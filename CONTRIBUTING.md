# Contributing to fresh

This is a personal public fork of [Pi](https://github.com/earendil-works/pi),
not the Earendil project. Issues and PRs are welcome. There is no auto-close
gate and no `lgtm` contributor list.

If you use an agent, run it from this repository root so it picks up
`AGENTS.md`.

## Before a PR

```bash
npm run check
./test.sh
```

Both must pass. Do not edit `CHANGELOG.md` unless the change is yours and
belongs under `## [Unreleased]`.

Do not run `npm publish`, `npm run release:patch`, or `npm run release:minor`
from this fork. Those scripts still target upstream Pi package names.

## Security

See [SECURITY.md](SECURITY.md).
