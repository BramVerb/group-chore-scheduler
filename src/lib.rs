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
    // Workers
    num_people: usize,
    names: Option<Vec<String>>,
    // Supervisors (separate pool)
    #[serde(default)]
    supervisors_enabled: bool,
    #[serde(default)]
    num_supervisors: usize,
    supervisor_names: Option<Vec<String>>,
    chores: Vec<ChoreSpec>,
}

#[derive(Serialize)]
struct Assignment {
    day: usize,
    chore: String,
    /// Supervisor name (from the supervisor pool), shown first in the UI
    #[serde(skip_serializing_if = "Option::is_none")]
    supervisor: Option<String>,
    /// Worker names (from the worker pool)
    people: Vec<String>,
}

#[derive(Serialize)]
struct SummaryEntry {
    name: String,
    total: usize,
}

#[derive(Serialize)]
struct Output {
    schedule: Vec<Assignment>,
    /// Worker totals, in person-index order
    workers: Vec<SummaryEntry>,
    /// Supervisor totals, in supervisor-index order (empty if disabled)
    supervisors: Vec<SummaryEntry>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

fn make_label(names: &Option<Vec<String>>, i: usize) -> String {
    names.as_ref()
        .and_then(|ns| ns.get(i))
        .cloned()
        .unwrap_or_else(|| person_label(i))
}

// ── Worker solver ─────────────────────────────────────────────────────────────

/// relax_variety: 0 = tight (floor..=ceil), 1 = loose (±1), 2 = none
fn solve_workers(
    input: &Input,
    relax: u8,
) -> Option<Vec<(usize, usize, usize)>> {
    let p = input.num_people;
    let d = input.days;
    let c = input.chores.len();

    let total: usize = d * input.chores.iter().map(|ch| ch.people_needed).sum::<usize>();
    let lo = total / p;
    let hi = (total + p - 1) / p;

    let mut vars = ProblemVariables::new();
    let x: Vec<Vec<Vec<Variable>>> = (0..p)
        .map(|_| {
            (0..c)
                .map(|_| (0..d).map(|_| vars.add(variable().binary())).collect())
                .collect()
        })
        .collect();

    let mut model = vars.minimise(Expression::from(0)).using(microlp);

    // At most one chore per worker per day
    for person in 0..p {
        for day in 0..d {
            let expr: Expression = (0..c).map(|ch| x[person][ch][day]).sum();
            model = model.with(constraint!(expr <= 1.0));
        }
    }

    // Each chore staffed exactly
    for chore in 0..c {
        let need = input.chores[chore].people_needed as f64;
        for day in 0..d {
            let expr: Expression = (0..p).map(|person| x[person][chore][day]).sum();
            model = model.with(constraint!(expr == need));
        }
    }

    // Fair total workload
    for person in 0..p {
        let expr: Expression = (0..c)
            .flat_map(|ch| (0..d).map(move |dy| (ch, dy)))
            .map(|(ch, dy)| x[person][ch][dy])
            .sum();
        model = model.with(constraint!(expr.clone() >= lo as f64));
        model = model.with(constraint!(expr <= hi as f64));
    }

    // Per-chore variety
    if relax < 2 {
        let slack = if relax == 0 { 0usize } else { 1 };
        for person in 0..p {
            for chore in 0..c {
                let total_chore = d * input.chores[chore].people_needed;
                let floor = total_chore / p;
                let ceil  = (total_chore + p - 1) / p;
                let expr: Expression = (0..d).map(|dy| x[person][chore][dy]).sum();
                model = model.with(constraint!(expr.clone() >= floor.saturating_sub(slack) as f64));
                model = model.with(constraint!(expr <= (ceil + slack) as f64));
            }
        }
    }

    let sol = model.solve().ok()?;
    let mut result = Vec::new();
    for person in 0..p {
        for chore in 0..c {
            for day in 0..d {
                if sol.value(x[person][chore][day]) > 0.5 {
                    result.push((person, chore, day));
                }
            }
        }
    }
    Some(result)
}

// ── Supervisor solver ─────────────────────────────────────────────────────────

fn solve_supervisors(
    input: &Input,
    relax: u8,
) -> Option<Vec<(usize, usize, usize)>> {
    let sv = input.num_supervisors;
    let d  = input.days;
    let c  = input.chores.len();

    // Total supervisor slots = 1 per chore per day
    let total = d * c;
    let lo = total / sv;
    let hi = (total + sv - 1) / sv;

    let mut vars = ProblemVariables::new();
    let s: Vec<Vec<Vec<Variable>>> = (0..sv)
        .map(|_| {
            (0..c)
                .map(|_| (0..d).map(|_| vars.add(variable().binary())).collect())
                .collect()
        })
        .collect();

    let mut model = vars.minimise(Expression::from(0)).using(microlp);

    // Each chore has exactly 1 supervisor per day
    for chore in 0..c {
        for day in 0..d {
            let expr: Expression = (0..sv).map(|sup| s[sup][chore][day]).sum();
            model = model.with(constraint!(expr == 1.0));
        }
    }

    // Each supervisor supervises at most 1 chore per day
    for sup in 0..sv {
        for day in 0..d {
            let expr: Expression = (0..c).map(|ch| s[sup][ch][day]).sum();
            model = model.with(constraint!(expr <= 1.0));
        }
    }

    // Fair total distribution
    for sup in 0..sv {
        let expr: Expression = (0..c)
            .flat_map(|ch| (0..d).map(move |dy| (ch, dy)))
            .map(|(ch, dy)| s[sup][ch][dy])
            .sum();
        model = model.with(constraint!(expr.clone() >= lo as f64));
        model = model.with(constraint!(expr <= hi as f64));
    }

    // Per-chore variety (1 slot per chore per day → d total per chore)
    if relax < 2 {
        let slack = if relax == 0 { 0usize } else { 1 };
        for sup in 0..sv {
            for _chore in 0..c {
                let floor = d / sv;
                let ceil  = (d + sv - 1) / sv;
                let expr: Expression = (0..d).map(|dy| s[sup][_chore][dy]).sum();
                model = model.with(constraint!(expr.clone() >= floor.saturating_sub(slack) as f64));
                model = model.with(constraint!(expr <= (ceil + slack) as f64));
            }
        }
    }

    let sol = model.solve().ok()?;
    let mut result = Vec::new();
    for sup in 0..sv {
        for chore in 0..c {
            for day in 0..d {
                if sol.value(s[sup][chore][day]) > 0.5 {
                    result.push((sup, chore, day));
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

    // Validate workers
    if input.num_people == 0 {
        return r#"{"error": "Number of workers must be at least 1"}"#.to_string();
    }
    if let Some(ref names) = input.names {
        if names.len() != input.num_people {
            return format!(
                "{{\"error\": \"Worker names list has {} entries but num_people is {}\"}}",
                names.len(), input.num_people
            );
        }
        if names.iter().any(|n| n.trim().is_empty()) {
            return r#"{"error": "All worker names must be non-empty"}"#.to_string();
        }
    }

    // Validate supervisors
    if input.supervisors_enabled {
        if input.num_supervisors == 0 {
            return r#"{"error": "Number of supervisors must be at least 1 when supervisors are enabled"}"#.to_string();
        }
        if let Some(ref names) = input.supervisor_names {
            if names.len() != input.num_supervisors {
                return format!(
                    "{{\"error\": \"Supervisor names list has {} entries but num_supervisors is {}\"}}",
                    names.len(), input.num_supervisors
                );
            }
            if names.iter().any(|n| n.trim().is_empty()) {
                return r#"{"error": "All supervisor names must be non-empty"}"#.to_string();
            }
        }
        if input.num_supervisors < input.chores.len() {
            return format!(
                "{{\"error\": \"Need at least {} supervisor(s) (one per chore) but only {} provided\"}}",
                input.chores.len(), input.num_supervisors
            );
        }
    }

    if input.days == 0 {
        return r#"{"error": "Number of days must be at least 1"}"#.to_string();
    }
    if input.chores.is_empty() {
        return r#"{"error": "At least one chore is required"}"#.to_string();
    }
    let workers_per_day: usize = input.chores.iter().map(|c| c.people_needed).sum();
    if workers_per_day == 0 {
        return r#"{"error": "Each chore must need at least 1 person"}"#.to_string();
    }
    if workers_per_day > input.num_people {
        return format!(
            "{{\"error\": \"Need {} workers per day but only {} available\"}}",
            workers_per_day, input.num_people
        );
    }

    // Solve workers
    let work_assignments = match solve_workers(&input, 0)
        .or_else(|| solve_workers(&input, 1))
        .or_else(|| solve_workers(&input, 2))
    {
        Some(a) => a,
        None => return r#"{"error": "No feasible worker schedule found."}"#.to_string(),
    };

    // Solve supervisors (independent problem)
    let sup_assignments: Vec<(usize, usize, usize)> = if input.supervisors_enabled {
        match solve_supervisors(&input, 0)
            .or_else(|| solve_supervisors(&input, 1))
            .or_else(|| solve_supervisors(&input, 2))
        {
            Some(a) => a,
            None => return r#"{"error": "No feasible supervisor schedule found."}"#.to_string(),
        }
    } else {
        vec![]
    };

    let p  = input.num_people;
    let sv = input.num_supervisors;
    let c  = input.chores.len();
    let d  = input.days;

    // Worker summary
    let mut work_counts = vec![0usize; p];
    for &(person, _, _) in &work_assignments { work_counts[person] += 1; }
    let workers: Vec<SummaryEntry> = (0..p)
        .map(|i| SummaryEntry { name: make_label(&input.names, i), total: work_counts[i] })
        .collect();

    // Supervisor summary
    let mut sup_counts = vec![0usize; sv];
    for &(sup, _, _) in &sup_assignments { sup_counts[sup] += 1; }
    let supervisors: Vec<SummaryEntry> = (0..sv)
        .map(|i| SummaryEntry { name: make_label(&input.supervisor_names, i), total: sup_counts[i] })
        .collect();

    // Build schedule (supervisor listed on each assignment)
    let mut schedule: Vec<Assignment> = Vec::new();
    for day in 0..d {
        for chore in 0..c {
            let people: Vec<String> = work_assignments.iter()
                .filter(|&&(_, ch, dy)| ch == chore && dy == day)
                .map(|&(person, _, _)| make_label(&input.names, person))
                .collect();
            let supervisor: Option<String> = sup_assignments.iter()
                .find(|&&(_, ch, dy)| ch == chore && dy == day)
                .map(|&(sup, _, _)| make_label(&input.supervisor_names, sup));
            if !people.is_empty() || supervisor.is_some() {
                schedule.push(Assignment {
                    day: day + 1,
                    chore: input.chores[chore].name.clone(),
                    supervisor,
                    people,
                });
            }
        }
    }

    let output = Output { schedule, workers, supervisors };
    match serde_json::to_string(&output) {
        Ok(s) => s,
        Err(e) => format!("{{\"error\": \"Serialization error: {}\"}}", e),
    }
}
