# IronProbe architecture

**IronProbe** is a local-first, AI-driven testing agent. It does the jobs most teams pay
BrowserStack and Postman for, cross-browser/device UI testing and API testing, plus
accessibility, performance, load and crawl checks, and turns every run into one report
with charts. Claude Code is the brain; IronProbe is the hands.

```
                ┌──────────────────────────────────────────────┐
  You / Claude  │  Claude Code plugin (the AI agent layer)     │
  ───────────▶  │  • test-architect  → writes suites           │
                │  • failure-triager → explains & fixes fails  │
                │  • /ironprobe:test, /ironprobe:triage        │
                └──────────────┬───────────────────────────────┘
                               │ runs
                ┌──────────────▼───────────────────────────────┐
                │  ironprobe CLI (Node ≥ 20, no build step)    │
                │  config → SAFETY GATE → engines → report     │
                └──────────────┬───────────────────────────────┘
        ┌──────────┬───────────┼────────────┬───────────┬──────────┐
        ▼          ▼           ▼            ▼           ▼          ▼
     API engine  UI engine   A11y        Perf        Load       Crawl
     (Postman/   (Playwright (axe-core)  (Web Vitals (bounded   (same-site
     OpenAPI     Chromium/               LCP CLS     concurrency smoke of
     import,     Firefox/                FCP TTFB)   p50/p95/p99 every page)
     schema,     WebKit ×                            RPS, errors)
     chaining)   devices,
                 visual diff)
        └──────────┴───────────┬────────────┴───────────┴──────────┘
                               ▼
                results.json (machine) · report.html (charts) · junit.xml (CI)
                history.jsonl (trends across runs)
```

## Two ways in
- **Quick mode** (`ironprobe <url>`, `src/quick.js`) and the **dashboard** (`ironprobe`,
  `src/dashboard/`) need no config. Quick mode writes a config for the typed address into a per-site
  workspace in `~/.ironprobe/sites/<host>` (history of the last 20 runs, visual baselines), checks the
  site is reachable, downloads the test browser on first use (`src/browsers.js`), then calls the same
  runner. Uploaded files are recognised by content: Postman collections and environments, OpenAPI,
  HAR recordings (`src/importers/har.js`) and IronProbe test files.
- The dashboard is a small local server (127.0.0.1, per-launch token) that streams progress over
  server-sent events and serves saved reports. It allows one run at a time, can stop a run, and
  compares scores only with earlier runs of the same kind.
- **Config mode** (`ironprobe init` / `run`) is for teams that keep tests in their repo and run CI.

Every run gets a **health score** (`src/score.js`): the average pass rate of each area that ran (API,
user flows, pages, whole site, load), so one large area cannot hide a broken one. A run where an
engine crashed gets no score. Wording for people is shared by the dashboard and report
(`src/plain.js`).

## Engines
| Engine | Replaces | What it checks |
|---|---|---|
| API | Postman collections, Newman, monitors | Requests, variables, chaining (`extract`), status/header/body/JSONPath/JSON-Schema/latency assertions; imports Postman v2.1, OpenAPI 3 and HAR recordings |
| UI | BrowserStack Automate / Live (local) | Steps (goto, click, fill, press, expect, screenshot) across browsers × device profiles; console errors; failed requests |
| Visual | Percy | Pixel diff against a stored baseline per browser × device × page |
| A11y | BrowserStack Accessibility | axe-core WCAG 2.x A/AA, grouped by impact |
| Perf | Lighthouse-style checks | LCP, CLS, FCP, TTFB per browser against budgets |
| Load | Postman performance runs, k6 basics | Fixed-duration load with hard caps; latency percentiles, RPS, error rate |
| Crawl | Exploratory smoke | Same-origin crawl: broken pages, console errors, a11y on every page |

## AI agent layer (Claude Code plugin)
- **test-architect** reads the code, an OpenAPI file, a Postman export or a plain-English
  description and writes IronProbe suites.
- **failure-triager** reads `results.json`, groups failures by root cause, explains each
  in plain words and proposes the fix, including updated selectors ("self-healing").
- **coverage-scout** compares the app's routes and endpoints with what the suites test.
- Runs inside the user's own Claude Code session: no extra API keys, no third-party AI
  service, nothing leaves the machine except calls to the targets under test.

## Other commands
`doctor` checks the setup, `mock` serves an OpenAPI mock on 127.0.0.1, `scan` finds hard-coded secrets,
`export playwright` writes plain Playwright Test code.

## Isolation and evidence
Each UI test and page check gets a fresh browser context. Failed tests keep a screenshot and a
Playwright trace. A crash in one engine is recorded as a failure and the report is still written.

## Safety model (fail-closed)
1. **Allowed hosts are mandatory.** Every API request and redirect hop is checked against
   `allowedHosts`. Each browser runs behind a local allow-list proxy (`src/guard-proxy.js`) that
   checks every connection, including each redirect hop and WebSocket, and a request guard
   (`src/browser-guard.js`) that fails tests on off-list page loads. Unknown host: refused.
2. **Load tests need explicit ownership.** `load` runs only with `iOwnThisTarget: true`,
   and are capped (≤ 50 concurrent, ≤ 120 s, ≤ 200 req/s).
3. **No script execution from imports.** Postman `pm.*` scripts are never evaluated; common
   assertions are translated, the rest are flagged for review.
4. **Secrets** come from environment variables (`{{env.NAME}}`) and are redacted from
   logs, results and reports.
5. **No telemetry.** IronProbe makes no network calls except to the targets you list.
6. **Safe reports.** All report content is HTML-escaped; the report has a strict CSP and
   no external scripts, fonts or CDNs; charts are inline SVG.
7. **Crawl stays on your site** (same origin + allowed hosts, page cap).

## Outputs
- `report.html`, single self-contained file: summary, pass-rate chart, browser × device
  matrix, API latency chart, Web Vitals vs budget, accessibility by impact, load latency,
  trend vs previous runs, every failure with evidence (screenshots, response snippets).
- `results.json`, full machine-readable results (input to failure-triager).
- `junit.xml`, CI integration (GitHub Actions, GitLab, Jenkins).
- `history.jsonl`, one line per run for trends.
- Exit code 0 = all passed, 1 = failures, 2 = config/safety error.

## Honest limits vs BrowserStack
IronProbe runs browsers and device emulation on your machine. It does not have a cloud of
thousands of real phones. For real devices: iOS Simulator / Android Emulator on the Mac,
and later a real iPhone through iPhone Mirroring (Mirroir MCP) once it passes review.
