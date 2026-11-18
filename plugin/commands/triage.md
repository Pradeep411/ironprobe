---
description: Explain and fix the failures from the last IronProbe run
---

Use the failure-triager agent on `ironprobe-report/results.json`. Group failures by root cause, separate app
bugs from test and environment problems, apply only safe test fixes (never weaken assertions), re-run what
changed, and report before/after in plain language.
