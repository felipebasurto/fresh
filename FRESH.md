# fresh — install, run, configure

`fresh` is a standalone coding-agent harness based on Pi, with native
FreshCtx context freshness: every `openai-completions` model request passes
through verified prepare → commit against current workspace bytes, and any
verification failure blocks dispatch (zero HTTP sent) instead of falling back
to potentially stale context.

This fork is source-only. Do not `npm publish` it. Package names stay
`@earendil-works/*` for merge compatibility with upstream Pi; they are not
an Earendil release.

## Prerequisites

- Node.js `>=22.19.0` and npm.
- A `freshctx` server on `PATH` speaking protocol `freshctx/1`
  (v0.1.0), unless you set `freshctx.mode` to `"off"`. Install from
  https://github.com/felipebasurto/freshctx :

  ```bash
  git clone https://github.com/felipebasurto/freshctx.git
  cd freshctx
  npm install
  npm install -g .
  freshctx doctor
  ```

- A configured model provider (same auth as Pi: `fresh auth`, API keys, etc.).
  Native mode only accepts `openai-completions`. The CLI default provider is
  still Google; pick a completions model, or set `freshctx.mode` to `"off"`.

## Install

```bash
git clone https://github.com/felipebasurto/fresh.git
cd fresh
npm install --ignore-scripts
npm run build
```

Verify the tree (from the repo root):

```bash
npm run check     # lint, format, type check — must be clean
./test.sh         # non-e2e suites (skips provider tests without keys)
```

## Run

The CLI binary is `fresh` (`packages/coding-agent/dist/bundle/cli.js`):

```bash
node packages/coding-agent/dist/bundle/cli.js --help
node packages/coding-agent/dist/bundle/cli.js -p "Say exactly: ok"
node packages/coding-agent/dist/bundle/cli.js            # interactive TUI
node packages/coding-agent/dist/bundle/cli.js -p --provider openai --model gpt-4o-mini "Refactor ..."
```

From a source checkout, `./fresh-test.sh` runs the TypeScript CLI via tsx
without requiring a dist bundle.

`fresh` keeps the user-facing identity (binary, help, docs, user agent) while
sharing Pi's data plane, so existing provider auth and sessions carry over:

- global config: `~/.pi/agent/` (`settings.json`, `auth.json`, sessions)
- project config: `.pi/` (trust decisions, project settings)
- env overrides: `FRESH_CODING_AGENT_DIR`, `FRESH_CODING_AGENT_SESSION_DIR`

## Configure FreshCtx

Settings live in `~/.pi/agent/settings.json` (global) or
`.pi/settings.json` (project). Defaults are strict-native:

```jsonc
{
  "freshctx": {
    "mode": "native",                        // or "off" for ordinary Pi behavior
    "serverCommand": ["freshctx", "serve", "--stdio", "--root", "{root}"],
    "serverEnv": {},
    "timeoutMs": 10000,
    "budgetBytes": 131072
  }
}
```

- `{root}` is replaced with the session workspace. Point `serverCommand`
  at another `freshctx` build to test server changes.
- `mode: "off"` disables all FreshCtx behavior (reads, compaction,
  payloads are byte-identical to upstream Pi).
- Historical recovery tools are opt-in via the tool allowlist:
  `"tools": ["read", "bash", "edit", "write", "freshctx_recover", "freshctx_inspect"]`
  (`freshctx_inspect` lists tracked reads and archive units so the model
  never invents IDs; `freshctx_recover` returns labeled historical bytes.
  Listed revisions are the observed revisions: whole-file reads are
  guaranteed recoverable, partial reads report `unknown_revision` when the
  archive does not hold that exact revision).

## Coverage and limits

- Native preparation covers `openai-completions` only. Other providers in
  native mode are blocked with an explicit error (set `mode: "off"` or use a
  completions provider). This is intentional: unsupported serializations are
  never silently labeled compatible.
- Tracked source is built-in workspace text reads. Shell/search output stays
  historical (outside the freshness guarantee).
- The guarantee: selected content matches a validated filesystem snapshot
  immediately before dispatch. Files can change after commit (documented
  external-edit race); harness-owned writes are quiesced during preparation.
- Never load the old `freshctx-pi` extension alongside native mode.

## What "blocked" looks like

A failed refresh ends the turn with an `error` stop reason whose message
starts with `FreshCtx blocked dispatch (<code>)`, and no HTTP request is
sent for that attempt. Common codes: `tampered-result`, `transport`,
`invalid-plan`, `commit-failed`, `budget-exhausted`, `unsupported-provider`.

## Internal names (intentionally unchanged)

npm package names (`@earendil-works/*`), the TypeScript import graph, and
session-file formats are byte-compatible with upstream Pi for merge
friendliness. Only the user-facing identity changed: repo, binary, user
agent, docs. Config directories remain `~/.pi/agent/` and `.pi/`.
