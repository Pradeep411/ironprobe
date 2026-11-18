---
description: Plan, write, run and triage IronProbe tests for this project end to end
argument-hint: "[url, spec file, or what to test]"
---

Use the ironprobe skill to test: $ARGUMENTS

If there is no `ironprobe.config.yaml`, run `ironprobe init`, set baseUrl and allowedHosts (ask the user to
confirm hosts they own), then use the test-architect agent to plan and write suites. Run `ironprobe run`.
If anything failed or was flaky, use the failure-triager agent. Finish with a plain-language summary:
what was tested, what broke and why, fixes made or proposed, coverage gaps, and the path to report.html.
