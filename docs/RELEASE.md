# IronProbe 0.1.0 release record

## Sign-off
Signed-off commit: the commit tagged `v0.1.0`. Six independent reviews ran on the release candidate
on 19 Nov 2026; every finding they raised was fixed and re-tested before the tag.

| Review | Verdict |
|---|---|
| Architecture and release readiness | Pass after fixes |
| Line-by-line code review | Pass after fixes |
| Feature testing as a user | Pass after fixes |
| Release audit (consistency, licences, leftovers) | Pass after fixes |
| Security (dashboard, quick mode, proxy, secrets) | Pass after fixes, no high findings |
| Design (dashboard and report, light, dark, phone) | Pass after fixes |

Evidence at sign-off:
- 40 automated tests pass (`npm test`); CI runs them on Node 20 and 22; `ironprobe scan .` is clean.
- Demo with planted bugs (`DEMO_BUGS=1`): all 4 planted bugs found, plus fuzzer crashes on
  `/api/items` with unusual IDs. With bugs off: 39/39 checks pass on Chromium.
- Fresh machine: the first quick run downloads the Chromium headless shell (about 266 MB) from
  Playwright's servers by itself, then runs. `--headed` and extension testing need the full browser
  (`npx playwright install chromium`).
- The proxy guard test (`test/guard.test.js`) runs on Chromium. Firefox and WebKit are installed in
  CI and run the demo, but guard coverage on those engines is not automated yet.

## Before publishing to npm
1. Check that "IronProbe" is free as a trademark where you launch (npm and GitHub names were free on
   19 Nov 2026).
2. Confirm the CI workflow is green on GitHub.
3. Reserve and publish the npm package (`npm publish`, account with 2FA).

## Privacy notes for users (also in SECURITY.md)
- No telemetry. Besides your targets, IronProbe only downloads its test browser once.
- Quick mode: pages may load their own public files; private network addresses are blocked; an API
  token is held in memory only; run history lives in `~/.ironprobe` and dropped files are deleted
  after each run.

## Where to publish, in order
1. GitHub (public repo, MIT licence).
2. npm (`npx ironprobe` works straight away).
3. Claude Code plugin marketplace (`/plugin marketplace add Pradeep411/ironprobe`).
4. Launch posts (Show HN, Product Hunt, Reddit, dev.to, X, LinkedIn).

## Known limits
- Devices are emulated, not real phones; WebKit is close to, but not the same as, Safari on iOS.
- No cloud dashboard or team accounts yet; reports are files on your computer.
- Load tests are capped at 50 users, 120 s and 200 requests per second by design.
