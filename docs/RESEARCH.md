# Why IronProbe exists, research summary (Nov 2026)

Sources: public docs, pricing pages, review sites (G2, Capterra, TrustRadius), engineering blogs,
Hacker News, and peer-reviewed papers. Vendor case studies are marked as vendor-selected.

## What people pay for today
- **BrowserStack**, Live/Automate on 3,500+ browser–device combos, App Automate, Percy visual testing,
  Accessibility, Test Reporting & Analytics, Load Testing (2026), Test Companion AI agent (Jul 2026).
  Automate Pro ≈ $129–169 per parallel/month. Complaints: slow/flaky device sessions at scale, cost grows
  with parallels, Percy false positives, still have to write and maintain scripts.
- **Postman**, collections, scripts, runner/CLI, monitors, mocks, flows, Agent Mode (credit-metered).
  Free plan is 1 user since Mar 2026; Team $19/user/month. Complaints: forced cloud sync, price, slow with
  large collections; 30,000+ public workspaces leaked keys and tokens (CloudSEK).
- **Alternatives studied:** TestMu AI (ex-LambdaTest), Sauce Labs, Playwright (built-in Planner/Generator/
  Healer agents), Cypress Cloud, QA Wolf, Mabl, Testim, Applitools, Katalon, Momentic; Insomnia, Bruno,
  Hoppscotch, Apidog, Thunder Client, Hurl, Schemathesis, Keploy.

## What engineering leaders actually value (and still lack)
| Theme | Evidence (abridged) | IronProbe answer |
|---|---|---|
| Fast feedback | Carousell: full pass from 8 engineers × 1 day to ~1 hour (vendor case study); BigBinary: 2h27m → 16 min after moving to Playwright | Local parallel workers, no device queue |
| Nobody wants to maintain tests | Recurring theme in engineering blogs and vendor case studies | test-architect writes, failure-triager heals selectors |
| Flaky tests erode trust | Teams report merging changes despite failing tests because failures are often flaky; Google has published that about 16% of its tests show some flakiness | Automatic retry, flaky label, cause per failure |
| AI tests check clicks, not outcomes | Decipher: AI tests "optimize for completion, not coverage quality" | `reload` + `request` outcome steps; agent rules require them |
| Secrets leaking from cloud collections | 30k Postman workspaces exposed keys | Local only, `{{env}}` secrets, masking, `ironprobe scan` |
| No lock-in | Teams moving to plain Playwright/Bruno | YAML in your repo + `export playwright` |
| Cost of parallel capacity | Cypress Cloud parallelism paywall; BrowserStack per-parallel pricing | Free, limited only by your machine/CI |
| API edge cases | Schemathesis paper: 1.4–4.5× more unique defects than the next-best fuzzer | `fuzz: true` on OpenAPI imports |

## Feature map: what IronProbe v0.1 covers
| # | Feature | v0.1 |
|---|---|---|
| 1 | Plain-English test authoring | ✓ via Claude Code agent |
| 2 | Self-healing selectors (reviewed, never weakening assertions) | ✓ agent |
| 3 | App exploration and coverage plan | ✓ test-architect, coverage-scout |
| 4 | Failure triage with cause | ✓ categories + agent |
| 5 | Flaky detection | ✓ retries + flaky label + history |
| 6 | OpenAPI tests + fuzzing | ✓ |
| 7 | Traffic recording to tests/mocks | ✓ tests from HAR recordings; mocks from recordings on the roadmap |
| 8 | Visual regression | ✓ pixel diff (no AI noise filter yet) |
| 9 | Tests as code in git, export to Playwright | ✓ |
| 10 | Results to coding agent | ✓ results.json (MCP server on roadmap) |
| 11 | Real-device cloud | ✗ by design (local); emulators/real phone on roadmap |
| 12 | Cross-browser × device grid | ✓ local Chromium/Firefox/WebKit × devices |
| 13 | Accessibility (WCAG 2.2 A/AA) | ✓ |
| 14 | Coverage-gap finder | ✓ coverage-scout agent |
| 15 | Mocks from OpenAPI | ✓ `ironprobe mock` |
| 16 | Postman import | ✓ (scripts never executed) |
| 17 | Load test with thresholds | ✓ capped |
| 18 | Web Vitals budgets | ✓ |
| 19 | Chrome extension testing | ✓ |
| 20 | CI output (JUnit) + exit codes | ✓ |

## On productivity claims
Vendors claim 50–90% less test-creation time; these are marketing, not independent. Independent data
says AI cuts writing and fixing work substantially but its output still needs review (Meta TestGen-LLM:
75% of generated tests built, 57% passed reliably, 25% added coverage; one repair study found ~50% real
convergence). IronProbe measures its own value per project: time per run, bugs found, flaky rate and
maintenance edits over time, publish those numbers, not promises.

## Who pays for these tools, and why (vendor-published case studies unless noted)

**Device-cloud testing (BrowserStack, Sauce Labs, TestMu AI):** Swiggy, Nykaa, Reddit, GoodRx,
Mastercard, Canva, TUI, Ubisoft, Sainsbury's, Walmart, N26, KAYAK, bet365, Raiffeisen Bank, Edureka,
Bajaj Finserv Health, Whatfix; Microsoft's .NET MAUI team (independent engineering blog).
Typical results claimed: regression cycles from days to hours (Swiggy 4 days to 1.5 days; Reddit
5 days to under 2 hours), daily or weekly releases, fewer visual and accessibility defects.

**API platform (Postman):** PayPal, Axis Bank, Goibibo, Belong.co, Razorpay (own blog), Cvent, Toast,
Autodesk, Amadeus, Visma, Microsoft Education, Salesforce (own GitHub), Stripe public workspace.
Typical results claimed: time to first API call from hours to minutes, onboarding 10 days to 2
(Axis Bank), 1,700+ API tests a day in CI (Goibibo).

## The jobs they hire these tools for, and how IronProbe does each
| Job | Why it is hard | IronProbe |
|---|---|---|
| Cover many browsers and devices | Device labs cost money and need upkeep | Local Chromium/Firefox/WebKit × device profiles; rent real devices only for the final pass |
| Realistic conditions (slow networks, location) | Needs lab setup | `ui.network` presets incl. `3g-india`, locale, time zone, geolocation |
| Release faster | Slow, manual regression | Parallel local runs, CI exit codes, JUnit, retries with flaky detection |
| Visual quality | Manual screenshot review | Baselines, pixel diff, masks, `--update-baselines` |
| Accessibility compliance | No in-house WCAG expertise | axe-core WCAG 2.2 A/AA on every page and crawl |
| Testing behind a firewall / staging | Cloud tools need a tunnel | Runs inside your network; no tunnel |
| Evidence for audits and debugging | Logs scattered | Screenshots, Playwright traces, results.json, JUnit, history |
| API regression in CI | Script-heavy collections | YAML suites in git, Postman/OpenAPI import, fuzzing |
| Parallel frontend/backend work | Backend not ready | `ironprobe mock openapi.yaml` |
| Onboarding and shared collections | Cloud sync leaks secrets | Git is the source of truth; `{{env}}` secrets; `ironprobe scan` |

## What IronProbe deliberately does not do
A hosted farm of physical phones, real-SIM/biometric flows, multi-region monitoring, hosted partner
workspaces. These need infrastructure; IronProbe stays local and points to rentable clouds for them.
