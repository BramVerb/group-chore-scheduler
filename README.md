# Chore Schedule Generator

A browser-based tool that produces a fair chore schedule for a group of people over multiple days. Everything runs client-side — a Rust ILP solver compiled to WebAssembly, no server required.

## Features

- **Fair distribution** — every person does the same number of chores (±1), and no one is stuck doing only one chore type
- **Supervisors** — optionally maintain a separate pool of supervisors; each chore on each day gets one supervisor, also distributed evenly
- **Unlimited people** — labels auto-generate as A–Z, then AA–AZ, BA–BZ, … (Excel-style); custom names can be specified for both workers and supervisors
- **CSV export** — downloads the full schedule and summary in a spreadsheet-friendly format
- **Fully offline** — no data leaves the browser

## Usage

Open the app, fill in:

| Field | Description |
|---|---|
| Number of days | How many days to schedule |
| Number of workers | How many people are in the worker pool |
| Worker names *(optional)* | One name per line; leave unchecked to use auto-labels |
| Enable supervisors | Adds a separate supervisor pool |
| Number of supervisors | How many supervisors are available |
| Supervisor names *(optional)* | One name per line |
| Chores | Name + number of workers needed per day for each chore |

Click **Generate Schedule**. The result shows:

- **Schedule table** — rows are days, columns are chores; supervisor (amber) listed first, then workers (blue)
- **Summary tables** — per-person breakdown by chore type, split into Supervisors and Workers sections

Click **Export CSV** to download the schedule and summaries as a `.csv` file.

## How it works

The scheduler is a **Binary Integer Program** solved with [`good_lp`](https://crates.io/crates/good_lp) (using the [`microlp`](https://crates.io/crates/microlp) backend, pure Rust, no native dependencies).

Decision variables `x[person][chore][day] ∈ {0,1}` encode whether a person works a given chore on a given day. Supervisor variables `s[supervisor][chore][day]` are solved independently. The constraints enforce:

1. At most one role per person per day
2. Each chore is exactly staffed every day
3. Each person's total assignments stay within `⌊total/P⌋` – `⌈total/P⌉` (fairness)
4. Each person's assignments per chore type stay within `⌊slots/P⌋` – `⌈slots/P⌉` (variety)

If the tight variety bounds make the problem infeasible, the solver automatically retries with relaxed bounds (±1), then without variety bounds at all.

## Building locally

**Prerequisites:** Rust toolchain, `wasm-pack`

```bash
# Install wasm-pack (first time only)
cargo install wasm-pack

# Build
wasm-pack build --target web --out-dir www/pkg

# Serve
python3 -m http.server 8080 --directory www

# Open
open http://localhost:8080
```
