import init, { generate_schedule } from "./pkg/chores.js";

await init();

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_CHORES = [
  { name: "Dishes",   people_needed: 2 },
  { name: "Sweep",    people_needed: 3 },
  { name: "Laundry",  people_needed: 2 },
  { name: "Trash",    people_needed: 3 },
];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const choreList          = document.getElementById("chore-list");
const addChoreBtn        = document.getElementById("add-chore-btn");
const generateBtn        = document.getElementById("generate-btn");
const errorBox           = document.getElementById("error-box");
const outputDiv          = document.getElementById("output");
const scheduleDiv        = document.getElementById("schedule-container");
const summaryDiv         = document.getElementById("summary-container");
const exportBtn          = document.getElementById("export-btn");

// Last successful result, kept for CSV export
let lastResult = null;
let lastChores = null;
let lastHasSupervisors = false;
const numPeopleInput     = document.getElementById("num-people");
const customNamesToggle  = document.getElementById("custom-names-toggle");
const namesField         = document.getElementById("names-field");
const namesInput         = document.getElementById("names-input");
const supervisorsToggle  = document.getElementById("supervisors-toggle");
const supervisorSettings = document.getElementById("supervisor-settings");
const numSupInput        = document.getElementById("num-supervisors");
const customSupToggle    = document.getElementById("custom-sup-names-toggle");
const supNamesField      = document.getElementById("sup-names-field");
const supNamesInput      = document.getElementById("sup-names-input");

// ── Chore rows ────────────────────────────────────────────────────────────────
function addChoreRow(name = "", people = 1) {
  const row = document.createElement("div");
  row.className = "chore-row";
  row.innerHTML = `
    <input type="text"   class="chore-name"   placeholder="Chore name" value="${escHtml(name)}" />
    <input type="number" class="chore-people" min="1" value="${people}" />
    <button class="remove-btn" title="Remove">✕</button>
  `;
  row.querySelector(".remove-btn").addEventListener("click", () => row.remove());
  choreList.appendChild(row);
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

DEFAULT_CHORES.forEach(ch => addChoreRow(ch.name, ch.people_needed));
addChoreBtn.addEventListener("click", () => addChoreRow());

// ── Names helpers ─────────────────────────────────────────────────────────────
function autoLabel(i) {
  let n = i + 1, chars = [];
  while (n > 0) { n--; chars.push(String.fromCharCode(65 + n % 26)); n = Math.floor(n / 26); }
  return chars.reverse().join("");
}

function syncTextarea(textarea, count, existing) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const cur = existing[i] !== undefined && existing[i].trim() !== "" ? existing[i] : autoLabel(i);
    lines.push(cur);
  }
  textarea.value = lines.join("\n");
  textarea.rows = Math.min(Math.max(count, 3), 20);
}

// Worker names
customNamesToggle.addEventListener("change", () => {
  if (customNamesToggle.checked) {
    const existing = namesInput.value.split("\n");
    syncTextarea(namesInput, parseInt(numPeopleInput.value, 10) || 0, existing);
    namesField.style.display = "block";
  } else {
    namesField.style.display = "none";
  }
});
numPeopleInput.addEventListener("input", () => {
  if (customNamesToggle.checked) {
    const existing = namesInput.value.split("\n");
    syncTextarea(namesInput, parseInt(numPeopleInput.value, 10) || 0, existing);
  }
});

// Supervisor settings visibility
supervisorsToggle.addEventListener("change", () => {
  supervisorSettings.style.display = supervisorsToggle.checked ? "block" : "none";
});

// Supervisor names
customSupToggle.addEventListener("change", () => {
  if (customSupToggle.checked) {
    const existing = supNamesInput.value.split("\n");
    syncTextarea(supNamesInput, parseInt(numSupInput.value, 10) || 0, existing);
    supNamesField.style.display = "block";
  } else {
    supNamesField.style.display = "none";
  }
});
numSupInput.addEventListener("input", () => {
  if (customSupToggle.checked) {
    const existing = supNamesInput.value.split("\n");
    syncTextarea(supNamesInput, parseInt(numSupInput.value, 10) || 0, existing);
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
    const name = row.querySelector(".chore-name").value.trim();
    const need = parseInt(row.querySelector(".chore-people").value, 10);
    if (!name) { showError("All chores must have a name."); return; }
    if (!(need >= 1)) { showError("People needed must be ≥ 1 for each chore."); return; }
    chores.push({ name, people_needed: need });
  }

  if (!chores.length) { showError("Add at least one chore."); return; }
  if (!(days >= 1))   { showError("Days must be at least 1."); return; }
  if (!(num_people >= 1)) { showError("Number of workers must be at least 1."); return; }

  // Worker names
  let names = null;
  if (customNamesToggle.checked) {
    names = namesInput.value.split("\n").map(s => s.trim()).filter(s => s !== "");
    if (names.length !== num_people) {
      showError(`Worker names list has ${names.length} entries but number of workers is ${num_people}.`);
      return;
    }
  }

  // Supervisor settings
  const supervisors_enabled = supervisorsToggle.checked;
  let num_supervisors = 0;
  let supervisor_names = null;
  if (supervisors_enabled) {
    num_supervisors = parseInt(numSupInput.value, 10);
    if (!(num_supervisors >= 1)) { showError("Number of supervisors must be at least 1."); return; }
    if (customSupToggle.checked) {
      supervisor_names = supNamesInput.value.split("\n").map(s => s.trim()).filter(s => s !== "");
      if (supervisor_names.length !== num_supervisors) {
        showError(`Supervisor names list has ${supervisor_names.length} entries but number of supervisors is ${num_supervisors}.`);
        return;
      }
    }
  }

  generateBtn.disabled = true;
  generateBtn.innerHTML = `<span class="spinner"></span> Solving…`;

  setTimeout(() => {
    try {
      const payload = { days, num_people, chores, supervisors_enabled, num_supervisors };
      if (names)            payload.names = names;
      if (supervisor_names) payload.supervisor_names = supervisor_names;
      const result = JSON.parse(generate_schedule(JSON.stringify(payload)));

      if (result.error) {
        showError(result.error);
      } else {
        lastResult = result;
        lastChores = chores;
        lastHasSupervisors = supervisors_enabled;
        renderOutput(result, chores, supervisors_enabled);
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
function renderOutput(result, chores, hasSupervisors) {
  const days = Math.max(...result.schedule.map(a => a.day));
  const choreNames = chores.map(c => c.name);

  // ── Schedule grid ──────────────────────────────────────────────────────────
  const table = document.createElement("table");
  table.className = "schedule-table";

  const hr = table.createTHead().insertRow();
  hr.insertCell().textContent = "Day";
  choreNames.forEach(n => {
    const th = document.createElement("th");
    th.textContent = n;
    hr.appendChild(th);
  });

  const tbody = table.createTBody();
  for (let d = 1; d <= days; d++) {
    const tr = tbody.insertRow();
    const dc = tr.insertCell();
    dc.textContent = d;
    dc.style.fontWeight = "700";

    choreNames.forEach(choreName => {
      const cell = tr.insertCell();
      const entry = result.schedule.find(a => a.day === d && a.chore === choreName);
      if (entry) {
        const wrap = document.createElement("div");
        wrap.className = "initials";
        // Supervisor first
        if (entry.supervisor) {
          const tag = document.createElement("span");
          tag.className = "initial-tag supervisor-tag";
          tag.title = "Supervisor";
          tag.textContent = entry.supervisor;
          wrap.appendChild(tag);
        }
        entry.people.forEach(name => {
          const tag = document.createElement("span");
          tag.className = "initial-tag";
          tag.textContent = name;
          wrap.appendChild(tag);
        });
        cell.appendChild(wrap);
      }
    });
  }

  scheduleDiv.innerHTML = "";
  if (hasSupervisors) {
    const legend = document.createElement("p");
    legend.className = "legend";
    legend.innerHTML =
      `<span class="initial-tag supervisor-tag">A</span> supervisor &nbsp;` +
      `<span class="initial-tag">A</span> worker`;
    scheduleDiv.appendChild(legend);
  }
  scheduleDiv.appendChild(table);

  // ── Summary ────────────────────────────────────────────────────────────────
  summaryDiv.innerHTML = "";

  if (hasSupervisors) {
    // Supervisors section
    summaryDiv.appendChild(makeSectionLabel("Supervisors"));
    summaryDiv.appendChild(buildSummaryTable(
      result.supervisors,
      choreNames,
      result.schedule,
      /* isSupervisor */ true,
    ));

    // Workers section
    summaryDiv.appendChild(makeSectionLabel("Workers"));
  }

  summaryDiv.appendChild(buildSummaryTable(
    result.workers,
    choreNames,
    result.schedule,
    /* isSupervisor */ false,
  ));

  outputDiv.style.display = "block";
}

function makeSectionLabel(text) {
  const h = document.createElement("h3");
  h.className = "summary-section-label";
  h.textContent = text;
  return h;
}

function buildSummaryTable(entries, choreNames, schedule, isSupervisor) {
  // Per-person per-chore counts from schedule
  const perChore = {};
  choreNames.forEach(n => perChore[n] = {});
  schedule.forEach(a => {
    if (isSupervisor) {
      if (a.supervisor) {
        perChore[a.chore][a.supervisor] = (perChore[a.chore][a.supervisor] || 0) + 1;
      }
    } else {
      a.people.forEach(name => {
        perChore[a.chore][name] = (perChore[a.chore][name] || 0) + 1;
      });
    }
  });

  const st = document.createElement("table");
  st.className = "summary-table";

  const hr = st.createTHead().insertRow();
  ["Person", ...choreNames, "Total"].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });

  const stb = st.createTBody();
  entries.forEach(({ name, total }) => {
    const tr = stb.insertRow();
    tr.insertCell().textContent = name;
    choreNames.forEach(n => tr.insertCell().textContent = perChore[n][name] || 0);
    tr.insertCell().textContent = total;
  });

  return st;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = "block";
}

// ── CSV export ────────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells) { return cells.map(csvCell).join(","); }

exportBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const { schedule, workers, supervisors } = lastResult;
  const choreNames = lastChores.map(c => c.name);
  const rows = [];

  // ── Schedule section ──────────────────────────────────────────────────────
  // Grid layout: columns = chores, rows grouped by day.
  // If supervisors enabled, first row of each day group = supervisors.
  // Subsequent rows = one worker per row (padded with "" across chores).
  rows.push(["SCHEDULE"]);
  rows.push(["Day", ...choreNames]);

  const days = Math.max(...schedule.map(a => a.day));
  for (let d = 1; d <= days; d++) {
    const entries = choreNames.map(n => schedule.find(a => a.day === d && a.chore === n) ?? { people: [], supervisor: null });
    const maxWorkers = Math.max(...entries.map(e => e.people.length));
    let firstRow = true;

    // Supervisor row (only when supervisors enabled)
    if (lastHasSupervisors) {
      rows.push([d, ...entries.map(e => e.supervisor ?? "")]);
      firstRow = false;
    }

    // Worker rows
    for (let i = 0; i < maxWorkers; i++) {
      rows.push([firstRow && i === 0 ? d : "", ...entries.map(e => e.people[i] ?? "")]);
    }
  }

  rows.push([]);  // blank separator

  // ── Worker summary ────────────────────────────────────────────────────────
  rows.push(["WORKER SUMMARY"]);

  // Build per-chore counts for workers
  const workerPerChore = {};
  choreNames.forEach(n => workerPerChore[n] = {});
  schedule.forEach(a => a.people.forEach(name => {
    workerPerChore[a.chore][name] = (workerPerChore[a.chore][name] || 0) + 1;
  }));

  rows.push(["Person", ...choreNames, "Total"]);
  workers.forEach(({ name, total }) => {
    rows.push([name, ...choreNames.map(n => workerPerChore[n][name] || 0), total]);
  });

  // ── Supervisor summary ────────────────────────────────────────────────────
  if (lastHasSupervisors && supervisors.length > 0) {
    rows.push([]);
    rows.push(["SUPERVISOR SUMMARY"]);

    const supPerChore = {};
    choreNames.forEach(n => supPerChore[n] = {});
    schedule.forEach(a => {
      if (a.supervisor) {
        supPerChore[a.chore][a.supervisor] = (supPerChore[a.chore][a.supervisor] || 0) + 1;
      }
    });

    rows.push(["Person", ...choreNames, "Total"]);
    supervisors.forEach(({ name, total }) => {
      rows.push([name, ...choreNames.map(n => supPerChore[n][name] || 0), total]);
    });
  }

  const csv = rows.map(csvRow).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chore-schedule.csv";
  a.click();
  URL.revokeObjectURL(url);
});
