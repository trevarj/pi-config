---
description: Review and address pull-request feedback without remote changes
argument-hint: "<PR URL or number>"
---
Review pull-request feedback for: $ARGUMENTS

- Detect forge from Git remote. Use `gh` for GitHub or `fj` for Codeberg/Forgejo.
- Read repository instructions, PR context, every review, inline comment, and discussion thread.
- Build feedback ledger. Classify every item as actionable, already fixed, outdated, question, incorrect, conflicting, or blocked.
- Verify each concern against current code before editing.
- Fix root causes and sibling occurrences, not only cited lines. Add closest useful regression coverage.
- Run focused checks plus repository-required formatter, lint, typecheck, build, and tests.
- Self-review final diff for correctness and feedback coverage.
- Produce concise draft reply mapped to each feedback item.
- Stop for user review. Do not post replies, resolve threads, commit, push, or otherwise change PR.
