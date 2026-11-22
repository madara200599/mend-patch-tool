# mend: one patch tool for every AI edit format

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![mend rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/madara200599/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![mend reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/madara200599/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one contract:

- a unified diff, often with wrong line numbers,
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

It finds the lines each edit names at the first of three matching tiers
(exact; trailing whitespace ignored; leading and trailing whitespace
ignored), and changes every file or none. `SPEC.md` is the whole contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file; when it is absent or `-`, the patch is read
  from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`
for a move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>`
line per failed edit and `failed: <k> of <n> edits`, and writes nothing.
Exit 2 prints one usage, no-patch, format or parse error line.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner; keep it as it is. In a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh directory,
  and posts what it did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification.

## Results

- Practice checks: 100 of 100 passed (unified 30/30, search_replace 20/20,
  v4a 20/20, json 15/15, cli 15/15).
- Strict-baseline proxy (tier-0 exact matching only): 73 of 100 on the same
  practice set, so the fuzzy tiers add 27 checks.
- 81 additional hand-made edge checks (usage errors, parse errors, renames,
  empty hunks, end-of-file anchors, CRLF files, overlapping JSON matches,
  atomicity, `--check`) all pass.

Entered via referral code r7k9dyj1
