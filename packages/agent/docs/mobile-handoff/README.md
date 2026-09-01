# pi — design handoff

Work in numbered order. Each unit is self-contained and independently testable;
later units consume earlier ones.

```
01-harness/
  01-delta/            op vocabulary, tracker, applier, codec   [LANDED IN CHORD]
  02-scopes/           storage scopes, list tags, JSONL encoding [SPEC + type check]
  03-execenv/          bounded Shell output, capture, spill      [CODE + 29 tests]
  04-tool-output/      the ToolOutput sink                       [SPEC ONLY]
  05-assistant-output/ assistant partials, symmetric with 04     [SPEC ONLY]
02-plugins/
  01-facets/           the facet system                          [SPEC ONLY]
  02-sandbox/          isolated-vm membrane                      [CODE + 412 tests]
```

Base everything on a clean checkout of `origin/dev`.

## Read this first

**Three units ship working code. Four are specifications.** The table above says
which. Do not assume a doc describes something that exists.

**`01-delta/FINDINGS.md` is historical evidence, not an implementation queue.** Production lives in `packages/chord/src/delta/index.ts`: flush-time dirty tracking fixed D1, and production remeasurement closed D2. The explicit append/truncate API is rejected; see [`01-harness/01-delta/append-decision.md`](01-harness/01-delta/append-decision.md). The code beside the handoff remains prototype and benchmark evidence.

**If a doc and the code disagree, the code wins** — fix the doc and say so in the
commit.

**Port the tests before the implementation.** Each group's comment explains the
failure it guards against, and several of those failures are silent: wrong output,
no exception.

**Benchmark with `node --experimental-strip-types`, never through a transpiler.**
Measuring this module through `tsx` inflates results 2.6x. `FINDINGS.md` D5 lists
five more measurement traps, each of which produced a confident wrong conclusion.

## Unit status

| unit | ships | state |
| --- | --- | --- |
| **01-delta** | production implementation and tests in `packages/chord`; prototype evidence here | landed; D1 fixed, explicit text API rejected after production remeasurement |
| **02-scopes** | spec + `scopes.variance.ts` | spec aligned to code; not implemented. The variance check compiles. |
| **03-execenv** | impl, rewritten bash, 2 diffs, spec | ran green (29 tests). **Its checkpoint policy is wrong** — see `04-tool-output/rate-limiting.md` §5 |
| **04-tool-output** | spec + design notes | **not built.** The piece every measurement of the op encoding depends on |
| **05-assistant-output** | spec | not built. Same shape as 04; do it after |
| **02-plugins/01-facets** | spec, ~1800 lines | not built. §14 rewritten to match the sandbox PoC |
| **02-plugins/02-sandbox** | working PoC, 412 assertions | `npm install && npm run audit` |

## Suggested order

1. **`03-execenv`** — land the shipped code, minus the checkpoint policy and the two redundant knobs (`rate-limiting.md` §5).
2. **`02-scopes`** — the compiler finds the call sites for you once `Write<Sc>` is invariant.
3. **`04-tool-output`** — decide the cadence question first (`rate-limiting.md` §4.3 lists what is undecided), then build.
4. **05**, then **02-plugins**.

## Live bugs on `origin/dev`, independent of this design

- `drive/tools.ts:257` — `clearReplayCheckpoint` deletes `pendingToolOutput` before
  re-executing a replay-safe tool. Memos exist so a replayed tool skips work, and
  skipped work emits nothing, so output for memoised work is lost today. Seed from
  it instead (`harness-tools.md` §7.4).
- `runtime/progress.ts:44` — `commitWrite(item)` captures the value at call time
  and writes fire-and-forget, so an older checkpoint can land after a newer one.
- memo and checkpoint are two transactions (`drive/tools.ts:112` vs
  `progress.ts:44`). They must be one (`harness-tools.md` §7.5).

**Expected test churn:** nine tests assert the old cleanup write set and will fail
once `retireScope` replaces the per-address deletes. That is the change landing.

## Environment

- Node 22+ for every shipped `.ts` file. They run under
  `node --experimental-strip-types` with no build step and no dependencies.
- In the pi repo, tests run from the package:
  `cd packages/agent && npx vitest run --config vitest.harness.config.ts`.
  The root vitest config does **not** alias `@earendil-works/pi-ai`; the
  per-package harness config does.
- Typecheck with `npx tsgo --noEmit` from the repo root. **Baseline is ~788
  pre-existing errors**, almost all in `packages/ai/test`. Count only:
  `grep "error TS" | grep -E "packages/(agent|session-backends)/src"`.
- `packages/ai` cannot be built offline — model data is fetched at build time.
