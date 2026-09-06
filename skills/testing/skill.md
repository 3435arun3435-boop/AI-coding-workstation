---
name: testing-standards
description: Testing conventions for this zero-dependency project
applicability: test, tests, node:test, coverage
modes: test, code, autonomous
---
- Use Node's built-in runner (`node:test`) — zero dependencies is a hard rule.
- Tests live in test/<area>.test.js; use real temp directories (fs.mkdtempSync).
- Mock providers via injectable callFn; never require real API keys.
- Unavailable optional capabilities must self-skip honestly, never fake a pass.
