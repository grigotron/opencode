# @gmharness/cli

The `gm` entrypoint for GMharness, built on the forked OpenCode engine.

## Commands

```
gm                          pick an entitled tenant, then launch
gm <tenant> [-- args...]    launch the engine in tenants/<tenant>/
gm tenant [--json] [--refresh]
gm sync [flags]             Hermes profiles + tenant workspaces
gm init [--force]           install/update the embedded assets
gm status [--short] [--json]
gm doctor
gm update
gm netprobe|pcap|fwparse|ipcalc|evidence|context|goal ...
```

## How it works

`src/assets.gen.ts` is generated from the umbrella repo by
`script/generate-assets.ts`: agents, commands, context docs, skills, config
template, sync/doctor scripts and `ws-*` utilities. At runtime `gm init` writes
them into `~/.config/opencode` and `<root>/state`.

`gm` resolves the engine binary in this order:

1. `$GM_OPENCODE_BIN`
2. `<root>/engine/packages/cli/dist/cli-<os>-<arch>/bin/opencode`
3. `~/.local/bin/opencode`
4. `opencode` on `PATH`

## Build

```bash
bun run assets
bun run build        # dist/gm, standalone binary
```

The umbrella repo wraps this as `make engine`.
