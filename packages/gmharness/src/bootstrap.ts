// Install embedded assets into `~/.config/opencode` and `<root>/state`.
//
// `gm init` is idempotent: an existing file is never replaced unless `--force`,
// and then it is copied to `<file>.bak-<timestamp>` first. Runtime scripts are
// extracted on demand (`ensure()`) by `gm sync` and the `ws-*` utilities, so a
// fresh checkout works without running `gm init` first.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { ASSETS, ASSET_VERSION } from "./assets.gen"
import * as paths from "./paths"
import { backupFile, renderConfig } from "./render"
import * as tenants from "./tenants"

export type Place = "written" | "skipped" | "backed-up" | "unchanged"

export type InitReport = {
  written: number
  skipped: number
  backedUp: number
  notes: string[]
}

/** Where an asset lands on disk, or `undefined` when it is not installed. */
export const target = (asset: string): { path: string; mode: number } | undefined => {
  if (asset === "AGENTS.md") return { path: join(paths.configDir(), "AGENTS.md"), mode: 0o644 }
  if (asset === "config/opencode.jsonc") return { path: paths.gmharnessConfig(), mode: 0o600 }
  if (asset === "config/.env.example") return { path: join(paths.configDir(), ".env.example"), mode: 0o600 }
  if (/^(agents|commands|context|skills)\//.test(asset)) return { path: join(paths.configDir(), asset), mode: 0o644 }
  if (asset.startsWith("scripts/")) return { path: join(paths.stateScriptsDir(), asset.slice("scripts/".length)), mode: 0o755 }
  if (asset.startsWith("bin/")) return { path: join(paths.stateBinDir(), asset.slice("bin/".length)), mode: 0o755 }
  if (asset.startsWith("systemd/")) return { path: join(paths.stateSystemdDir(), asset.slice("systemd/".length)), mode: 0o644 }
  return undefined
}

/** Write one asset, honouring the no-overwrite rule. */
export const place = (asset: string, options: { force?: boolean } = {}): Place => {
  const destination = target(asset)
  if (!destination) return "skipped"
  const existing = existsSync(destination.path)
  if (existing && !options.force) return "skipped"

  const backedUp = existing && options.force ? backupFile(destination.path) : undefined
  mkdirSync(dirname(destination.path), { recursive: true })
  writeFileSync(destination.path, ASSETS[asset] ?? "", { mode: destination.mode })
  chmodSync(destination.path, destination.mode)
  if (backedUp) return "backed-up"
  return "written"
}

/** Extract `scripts/<name>` or `bin/<name>` into the state dir if absent. */
export const ensure = (asset: string) => {
  const destination = target(asset)
  if (!destination) throw new Error(`no install target for ${asset}`)
  if (existsSync(destination.path)) return destination.path
  place(asset)
  return destination.path
}

export const init = (options: { force?: boolean } = {}): InitReport => {
  const report: InitReport = { written: 0, skipped: 0, backedUp: 0, notes: [] }

  for (const asset of Object.keys(ASSETS).sort()) {
    const result = place(asset, options)
    if (result === "written") report.written++
    else if (result === "backed-up") {
      report.written++
      report.backedUp++
    } else report.skipped++
  }

  report.notes.push(...ensureConfig(options))
  report.notes.push(...writeToken())
  writeVersion()
  return report
}

/**
 * Render `.gmharness-config.jsonc` into `opencode.json` when it does not exist.
 * `--force` re-renders it, keeping a timestamped backup.
 */
export const ensureConfig = (options: { force?: boolean } = {}) => {
  const template = ASSETS["config/opencode.jsonc"]
  if (!template) return ["config/opencode.jsonc is not embedded — run `bun run assets` in packages/gmharness"]

  const destination = paths.opencodeConfig()
  if (existsSync(destination) && !options.force) {
    return [`${destination} exists — left untouched (use \`gm init --force\` to re-render it).`]
  }

  const result = renderConfig({
    template,
    dest: destination,
    envFile: paths.envFile(),
    force: options.force,
  })
  const notes = [`rendered ${destination} (mode 600)`]
  if (result.backup) notes.push(`previous config saved as ${result.backup}`)
  return notes
}

/** `~/.config/opencode/.aiops-token` holds the raw PAT, mode 600. */
export const writeToken = () => {
  const value = tenants.token()
  if (!value) return [`AIOPS_MCP_TOKEN is not set — ${paths.tokenFile()} was not written`]
  const file = paths.tokenFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${value.trim()}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return [`wrote ${file} (mode 600)`]
}

export const writeVersion = () => {
  const file = paths.versionFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ version: ASSET_VERSION, installed_at: new Date().toISOString() }, null, 2)}\n`,
  )
  return file
}

/**
 * `tenants/<tenant>/` — the per-tenant OpenCode project. `opencode.json` is
 * regenerated (it only pins the AIOps MCP endpoint), `CONTEXT.md` is created
 * once and never overwritten, and the work directories are ensured.
 */
export const ensureWorkspace = (id: string, mcpUrl: string) => {
  const dir = paths.tenantDir(id)
  mkdirSync(dir, { recursive: true })
  for (const sub of ["findings", "evidence", "configs"]) mkdirSync(join(dir, sub), { recursive: true })

  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      servers: {
        aiops: {
          type: "remote",
          url: mcpUrl,
          oauth: false,
          headers: { Authorization: "Bearer {file:~/.config/opencode/.aiops-token}" },
        },
      },
    },
  }
  writeFileSync(join(dir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`)

  const context = join(dir, "CONTEXT.md")
  if (!existsSync(context)) writeFileSync(context, contextScaffold(id), "utf8")
  return dir
}

const contextScaffold = (id: string) => `# ${id} — working context

Tenant: \`${id}\`

## Purpose

What this engagement is for, in one paragraph. Why the tenant exists for us and
what "done" looks like.

## Sites

| Site | Role | Notes |
|---|---|---|
| | | |

## Key contacts

| Name | Role | Channel |
|---|---|---|
| | | |

## Open questions

- [ ]

## Evidence index

| Claim | Evidence | Path or id |
|---|---|---|
| | | |

Everything under \`findings/\` is durable working output; \`evidence/\` holds raw
captures (pcap, config exports, alarm dumps) referenced by the index above;
\`configs/\` holds sanitised device configuration excerpts.
`

