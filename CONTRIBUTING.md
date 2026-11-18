# Contributing to IronProbe

Thanks for helping. Good first contributions: a device profile, a network preset, a Postman script
pattern the importer does not translate yet, or a clearer message in `ironprobe doctor`.

1. `npm install && npx playwright install chromium`
2. Make the change, with a test in `test/`.
3. `npm test` must pass, and `node bin/ironprobe.js scan .` must be clean.
4. Open a pull request saying what job it helps with.

Rules that keep IronProbe trustworthy:
- Never weaken the allow-list, the load caps or secret masking.
- No telemetry, no network calls except to the user's own targets.
- Report security issues privately (see SECURITY.md), not in public issues.
