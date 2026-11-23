# mend

[![Competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Avapage/makefun-mend-round2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Avapage/makefun-mend-round2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and every file is changed or nothing is.

Bounty: [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, or `-` / absent to read the patch from standard input.
- `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`); `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` applied, `1` one or more edits failed (nothing written, every failure reported), `2` usage / unreadable patch / undetected format / parse error.

## How it works

Old lines are found at the first of three tiers where they occur at least once: exact, trailing-whitespace-insensitive, then leading-and-trailing-whitespace-insensitive with re-indentation of the replacement. Unified hunks take the occurrence nearest their (possibly wrong) line number; SEARCH/REPLACE blocks require exactly one occurrence; V4A chunks walk a cursor from anchor to anchor. CRLF files keep their line break, files without a final line break stay that way, and unified `\ No newline at end of file` markers are honoured. Edits apply in patch order against the tree as earlier edits left it, and a failed edit changes nothing while the edits after it still run.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner (kept as shipped).
- `check.ts` — run the practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the whole specification (in the kit).
- `LICENSE` — MIT.

## Practice

    node check.ts ../program/generator/practice.json
