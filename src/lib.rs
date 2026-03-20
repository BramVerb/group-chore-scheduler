use good_lp::{
    variable, Expression, ProblemVariables, Solution, SolverModel,
    constraint, microlp, Variable,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// ── Input / Output types ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChoreSpec {
    name: String,
    people_needed: usize,
}

#[derive(Deserialize)]
struct Input {
    days: usize,
    num_people: usize,
    names: Option<Vec<String>>,
    chores: Vec<ChoreSpec>,
}

#[derive(Serialize)]
struct Assignment {
    day: usize,
    chore: String,
    people: Vec<String>,
}

#[derive(Serialize)]
struct Output {
    schedule: Vec<Assignment>,
    summary: std::collections::HashMap<String, usize>,
}

// ── Solver ────────────────────────────────────────────────────────────────────

fn person_label(i: usize) -> String {
    // Excel-style: 0→A, 25→Z, 26→AA, 27→AB, 51→AZ, 52→BA, …
    let mut n = i + 1;
    let mut chars = Vec::new();
    while n > 0 {
        n -= 1;
        chars.push((b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    chars.iter().rev().collect()
}

/// relax_variety: 0 = tight (floor..=ceil), 1 = loose (floor-1..=ceil+1), 2 = none
fn solve(input: &Input, relax_variety: u8) -> Option<Vec<(usize, usize, usize)>> {
    let p = input.num_people;
    let d = input.days;
    let c = input.chores.len();

    // total slots and fairness bounds
    let total_slots: usize = d * input.chores.iter().map(|ch| ch.people_needed).sum::<usize>();
    let lo = total_slots / p;
    let hi = (total_slots + p - 1) / p;

    // Build ILP
    let mut problem_vars = ProblemVariables::new();

    // x[person][chore][day] – stored flat: index = person*c*d + chore*d + day
    let mut x: Vec<Vec<Vec<Variable>>> = Vec::with_capacity(p);
    for _person in 0..p {
        let mut xc: Vec<Vec<Variable>> = Vec::with_capacity(c);
        for _chore in 0..c {
            let mut xd: Vec<Variable> = Vec::with_capacity(d);
            for _day in 0..d {
                xd.push(problem_vars.add(variable().binary()));
            }
            xc.push(xd);
        }
        x.push(xc);
    }

    let mut model = problem_vars.minimise(Expression::from(0)).using(microlp);

    // Constraint 1: at most one chore per person per day
    for person in 0..p {
        for day in 0..d {
            let expr: Expression = (0..c)
                .map(|chore| x[person][chore][day])
                .sum::<Expression>();
            model = model.with(constraint!(expr <= 1.0));
        }
    }

    // Constraint 2: each chore staffed exactly on each day
    for chore in 0..c {
        let need = input.chores[chore].people_needed as f64;
        for day in 0..d {
            let expr: Expression = (0..p)
                .map(|person| x[person][chore][day])
                .sum::<Expression>();
            model = model.with(constraint!(expr == need));
        }
    }

    // Constraint 3: fair total workload
    for person in 0..p {
        let expr: Expression = (0..c)
            .flat_map(|chore| (0..d).map(move |day| (chore, day)))
            .map(|(chore, day)| x[person][chore][day])
            .sum::<Expression>();
        model = model.with(constraint!(expr.clone() >= lo as f64));
        model = model.with(constraint!(expr <= hi as f64));
    }

    // Constraint 4: per-person per-chore variety (floor..=ceil, softened on retry)
    if relax_variety < 2 {
        let slack = if relax_variety == 0 { 0usize } else { 1 };
        for person in 0..p {
            for chore in 0..c {
                let need = input.chores[chore].people_needed;
                // fair share for this chore across all days
                let total_chore_slots = d * need;
                let floor = total_chore_slots / p;
                let ceil  = (total_chore_slots + p - 1) / p;
                let expr: Expression = (0..d)
                    .map(|day| x[person][chore][day])
                    .sum::<Expression>();
                model = model.with(constraint!(expr.clone() >= floor.saturating_sub(slack) as f64));
                model = model.with(constraint!(expr <= (ceil + slack) as f64));
            }
        }
    }

    let solution = model.solve().ok()?;

    // Extract assignments
    let mut result = Vec::new();
    for person in 0..p {
        for chore in 0..c {
            for day in 0..d {
                let val = solution.value(x[person][chore][day]);
                if val > 0.5 {
                    result.push((person, chore, day));
                }
            }
        }
    }
    Some(result)
}

// ── WASM export ───────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn generate_schedule(input_json: &str) -> String {
    let input: Input = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\": \"Parse error: {}\"}}", e),
    };

    // Basic validation
    if input.num_people == 0 {
        return r#"{"error": "Number of people must be at least 1"}"#.to_string();
    }
    if let Some(ref names) = input.names {
        if names.len() != input.num_people {
            return format!(
                "{{\"error\": \"names list has {} entries but num_people is {}\"}}",
                names.len(), input.num_people
            );
        }
        if names.iter().any(|n| n.trim().is_empty()) {
            return r#"{"error": "All names must be non-empty"}"#.to_string();
        }
    }
    if input.days == 0 {
        return r#"{"error": "Number of days must be at least 1"}"#.to_string();
    }
    if input.chores.is_empty() {
        return r#"{"error": "At least one chore is required"}"#.to_string();
    }
    let slots_per_day: usize = input.chores.iter().map(|c| c.people_needed).sum();
    if slots_per_day > input.num_people {
        return format!(
            "{{\"error\": \"Not enough people: need {} per day but only {} available\"}}",
            slots_per_day, input.num_people
        );
    }
    if slots_per_day == 0 {
        return r#"{"error": "Each chore must need at least 1 person"}"#.to_string();
    }

    // Try tight variety bounds, then loosen, then drop entirely
    let assignments = solve(&input, 0)
        .or_else(|| solve(&input, 1))
        .or_else(|| solve(&input, 2));

    let assignments = match assignments {
        Some(a) => a,
        None => {
            return r#"{"error": "No feasible schedule found. Try fewer days, more people, or different chore sizes."}"#.to_string();
        }
    };

    // Build output
    let p = input.num_people;
    let c = input.chores.len();
    let d = input.days;

    // Resolve display name for each person index
    let label = |i: usize| -> String {
        input.names.as_ref()
            .and_then(|ns| ns.get(i))
            .cloned()
            .unwrap_or_else(|| person_label(i))
    };

    // summary: count chores per person
    let mut counts = vec![0usize; p];
    for &(person, _, _) in &assignments {
        counts[person] += 1;
    }

    let mut summary = std::collections::HashMap::new();
    for person in 0..p {
        summary.insert(label(person), counts[person]);
    }

    // schedule: for each day × chore, collect people
    let mut schedule: Vec<Assignment> = Vec::new();
    for day in 0..d {
        for chore in 0..c {
            let people: Vec<String> = assignments
                .iter()
                .filter(|&&(_, ch, dy)| ch == chore && dy == day)
                .map(|&(person, _, _)| label(person))
                .collect();
            if !people.is_empty() {
                schedule.push(Assignment {
                    day: day + 1,
                    chore: input.chores[chore].name.clone(),
                    people,
                });
            }
        }
    }

    let output = Output { schedule, summary };
    match serde_json::to_string(&output) {
        Ok(s) => s,
        Err(e) => format!("{{\"error\": \"Serialization error: {}\"}}", e),
    }
}
