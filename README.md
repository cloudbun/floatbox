# Floatbox — User Access Review Tool

A browser-based User Access Review (UAR) tool that matches employee records from an HR Source of Truth against satellite system exports (Okta, AWS IAM, SAP, etc.) to surface risk: terminated employees with active accounts, orphan accounts, and other access anomalies.

All processing happens client-side via WebAssembly (Go) and Web Workers — no data leaves the browser.

## Quick Start

### Docker (pull from GHCR)

```sh
docker compose up
```

Open http://localhost:8443.

### Local Development

Requires Go 1.23+ and Node 22+.

```sh
npm install
make dev
```

### Build

```sh
make build       # Go WASM + Vite build → dist/
```

## How It Works

1. **Upload** — Drop a Source of Truth CSV (HR system export) and one or more satellite CSVs (Okta, AWS, SAP, etc.)
2. **Map Columns** — Auto-detected or manually mapped to canonical fields (employee ID, name, email, status)
3. **Process** — A Go WASM engine indexes the SoT, then Web Workers join each satellite file in parallel
4. **Review** — Interactive report with risk scoring, filtering, bulk actions, and per-row review decisions
5. **Export** — Download the completed review as XLSX

## Project Structure

```
src/go/          Go WASM engine (join, conflict detection, risk scoring)
src/ts/          React frontend (Vite + Tailwind)
tests/           Playwright E2E and Vitest unit tests
public/          Static assets and compiled WASM binary
uar_sample_data/ Sample CSVs for testing
```

## Sample Data

Drop the files from `uar_sample_data/` into the app to exercise the full pipeline. See `uar_sample_data/README.txt` for built-in test scenarios (terminated employees, orphan accounts, fuzzy matches, etc.)
