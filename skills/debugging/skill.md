---
name: debugging-discipline
description: How to debug failures in this workstation's own Node code
applicability: debug, fix, bug, failure, error, crash
modes: debug, autonomous
---
When debugging this project:
1. Reproduce with `npm test` or a targeted `node --test <file>` run first.
2. Read the failing test BEFORE the implementation — the test is the spec.
3. Prefer root-cause fixes in src/ over test adjustments; never weaken assertions.
4. All new behavior needs a focused test in the matching test/*.test.js file.
5. Run the affected test file, then the full suite before claiming success.
