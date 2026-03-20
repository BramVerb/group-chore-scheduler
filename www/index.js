import init, { generate_schedule } from "./pkg/chores.js";

// ── WASM init ─────────────────────────────────────────────────────────────────
await init();

// ── Default chores ────────────────────────────────────────────────────────────
const DEFAULT_CHORES = [
  { name: "Dishes",   people_needed: 2 },
  { name: "Sweep",    people_needed: 3 },
  { name: "Laundry",  people_needed: 2 },
  { name: "Trash",    people_needed: 3 },
];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const choreList        = document.getElementById("chore-list");
const addChoreBtn      = document.getElementById("add-chore-btn");
const generateBtn      = document.getElementById("generate-btn");
const errorBox         = document.getElementById("error-box");
const outputDiv        = document.getElementById("output");
const scheduleDiv      = document.getElementById("schedule-container");
const summaryDiv       = document.getElementById("summary-container");
const numPeopleInput   = document.getElementById("num-people");
const customNamesToggle = document.getElementById("custom-names-toggle");
const namesField       = document.getElementById("names-field");
const namesInput       = document.getElementById("names-input");

// ── Chore rows ────────────────────────────────────────────────────────────────
function addChoreRow(name = "", people = 1) {
  const row = document.createElement("div");
  row.className = "chore-row";
  row.innerHTML = `
    <input type="text"   class="chore-name"   placeholder="Chore name" value="${escHtml(name)}" />
    <input type="number" class="chore-people" min="1" max="26" value="${people}" />
    <button class="remove-btn" title="Remove">✕</button>
  `;
  row.querySelector(".remove-btn").addEventListener("click", () => {
    row.remove();
  });
  choreList.appendChild(row);
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

DEFAULT_CHORES.forEach(ch => addChoreRow(ch.name, ch.people_needed));
addChoreBtn.addEventListener("click", () => addChoreRow());

// ── Names toggle ──────────────────────────────────────────────────────────────
function autoLabel(i) {
  // Mirror the Rust person_label: Excel-style A,B,…,Z,AA,AB,…
  let n = i + 1, chars = [];
  while (n > 0) { n--; chars.push(String.fromCharCode(65 + n % 26)); n = Math.floor(n / 26); }
  return chars.reverse().join("");
}

function syncNamesTextarea(count) {
  const existing = namesInput.value.split("\n").map(s => s.trim());
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(existing[i] !== undefined && existing[i] !== "" ? existing[i] : autoLabel(i));
  }
  namesInput.value = lines.join("\n");
  namesInput.rows = Math.min(Math.max(count, 3), 20);
}

customNamesToggle.addEventListener("change", () => {
  if (customNamesToggle.checked) {
    syncNamesTextarea(parseInt(numPeopleInput.value, 10) || 0);
    namesField.style.display = "block";
  } else {
    namesField.style.display = "none";
  }
});

numPeopleInput.addEventListener("input", () => {
  if (customNamesToggle.checked) {
    syncNamesTextarea(parseInt(numPeopleInput.value, 10) || 0);
  }
});

// ── Generate ──────────────────────────────────────────────────────────────────
generateBtn.addEventListener("click", () => {
  errorBox.style.display = "none";
  outputDiv.style.display = "none";

  const days       = parseInt(document.getElementById("days").value, 10);
  const num_people = parseInt(numPeopleInput.value, 10);

  const chores = [];
  for (const row of choreList.querySelectorAll(".chore-row")) {
    const name  = row.querySelector(".chore-name").value.trim();
    const need  = parseInt(row.querySelector(".chore-people").value, 10);
    if (!name) { showError("All chores must have a name."); return; }
    if (!(need >= 1)) { showError("People needed must be ≥ 1 for each chore."); return; }
    chores.push({ name, people_needed: need });
  }

  if (!chores.length) { showError("Add at least one chore."); return; }
  if (!(days >= 1))   { showError("Days must be at least 1."); return; }
  if (!(num_people >= 2)) { showError("Number of people must be at least 2."); return; }

  // Collect custom names if specified
  let names = null;
  if (customNamesToggle.checked) {
    names = namesInput.value.split("\n").map(s => s.trim()).filter(s => s !== "");
    if (names.length !== num_people) {
      showError(`Names list has ${names.length} entries but number of people is ${num_people}. Please provide exactly one name per person.`);
      return;
    }
  }

  generateBtn.disabled = true;
  generateBtn.innerHTML = `<span class="spinner"></span> Solving…`;

  // Run solver in a microtask so the UI can repaint first
  setTimeout(() => {
    try {
      const payload = { days, num_people, chores };
      if (names) payload.names = names;
      const inputJson = JSON.stringify(payload);
      const resultJson = generate_schedule(inputJson);
      const result = JSON.parse(resultJson);

      if (result.error) {
        showError(result.error);
      } else {
        renderOutput(result, chores);
      }
    } catch (err) {
      showError("Unexpected error: " + err.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate Schedule";
    }
  }, 10);
});

// ── Render ────────────────────────────────────────────────────────────────────
function renderOutput(result, chores) {
  // Build lookup: day → chore → people[]
  const days = Math.max(...result.schedule.map(a => a.day));
  const choreNames = chores.map(c => c.name);

  // ── Schedule grid ──────────────────────────────────────────────────────────
  const table = document.createElement("table");
  table.className = "schedule-table";

  // header
  const thead = table.createTHead();
  const hr = thead.insertRow();
  hr.insertCell().textContent = "Day";
  choreNames.forEach(n => {
    const th = document.createElement("th");
    th.textContent = n;
    hr.appendChild(th);
  });

  // rows
  const tbody = table.createTBody();
  for (let d = 1; d <= days; d++) {
    const tr = tbody.insertRow();
    const dayCell = tr.insertCell();
    dayCell.textContent = d;
    dayCell.style.fontWeight = "700";

    choreNames.forEach(choreName => {
      const cell = tr.insertCell();
      const entry = result.schedule.find(a => a.day === d && a.chore === choreName);
      if (entry) {
        const wrap = document.createElement("div");
        wrap.className = "initials";
        entry.people.forEach(p => {
          const tag = document.createElement("span");
          tag.className = "initial-tag";
          tag.textContent = p;
          wrap.appendChild(tag);
        });
        cell.appendChild(wrap);
      }
    });
  }

  scheduleDiv.innerHTML = "";
  scheduleDiv.appendChild(table);

  // ── Summary table ──────────────────────────────────────────────────────────
  // Count per-person per-chore; preserve insertion order (solver output order)
  const people = Object.keys(result.summary);
  const perChore = {};
  choreNames.forEach(n => perChore[n] = {});
  people.forEach(p => choreNames.forEach(n => perChore[n][p] = 0));
  result.schedule.forEach(a => {
    a.people.forEach(p => { perChore[a.chore][p] = (perChore[a.chore][p] || 0) + 1; });
  });

  const st = document.createElement("table");
  st.className = "summary-table";

  const sth = st.createTHead().insertRow();
  ["Person", ...choreNames, "Total"].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    sth.appendChild(th);
  });

  const stb = st.createTBody();
  people.forEach(p => {
    const tr = stb.insertRow();
    tr.insertCell().textContent = p;
    choreNames.forEach(n => tr.insertCell().textContent = perChore[n][p] || 0);
    tr.insertCell().textContent = result.summary[p];
  });

  summaryDiv.innerHTML = "";
  summaryDiv.appendChild(st);

  outputDiv.style.display = "block";
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = "block";
}
