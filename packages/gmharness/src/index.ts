// `gm` — the GMharness entrypoint on top of the OpenCode engine.
//
// Startup budget is ~50ms: a bare `gm <tenant>` with a fresh entitlement cache
// reads three small files and execs the engine; `gm status` never touches the
// network.

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import * as assets from "./assets"
import * as bootstrap from "./bootstrap"
import { exec, run, which } from "./exec"
import * as paths from "./paths"
import * as sync from "./sync"
import * as remote from "./remote"
import * as tenants from "./tenants"

const USAGE = `gm — GMharness: the eFellows AIOps harness on the OpenCode engine

Usage:
  gm                          pick an entitled tenant, then launch
  gm <tenant> [-- args...]    launch the engine in tenants/<tenant>/
  gm tenant [--json] [--refresh]
                              list entitled tenants and the current one
  gm sync [flags]             run the Hermes sync (--dry-run --json --tenant ID
                              --no-archive --no-skills --force)
  gm init [--force]           install or update the embedded assets/config
  gm status [--short] [--json]
                              tenant, sync age, git state, MCP count
  gm doctor                   run scripts/doctor.sh against this install
  gm remote [serve|url|status|password]
                              always-on lab-VM control server for the iOS PWA
  gm update                   git pull --ff-only, then re-run install.sh
  gm netprobe|pcap|fwparse|ipcalc|evidence|context|goal [args...]
                              run the matching bin/ws-* utility
  gm help | --help | -h       this text

Environment:
  GMHARNESS_ROOT      repo root (default: resolved from the binary, else ~/work-stack)
  GM_OPENCODE_BIN     engine binary (default: packages/cli/dist/<target>, ~/.local/bin, PATH)
  AIOPS_BASE_URL      AIOps API root (default https://aiops.efellows.bg/engineer)
  AIOPS_MCP_TOKEN     AIOps PAT (else ~/.config/opencode/.env)

Tenant access is decided by the Entra access packages behind the token; the
entitled set is cached for 12h in ~/.config/opencode/.tenants.json.
`

const WS_COMMANDS = ["netprobe", "pcap", "fwparse", "ipcalc", "evidence", "context", "goal"] as const
const TENANT_ID = /^[a-z0-9][a-z0-9._-]*$/i

const main = async () => {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === undefined) {
    if (!process.stdin.isTTY) {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    return launch(await pickTenant())
  }

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  if (command === "tenant" || command === "tenants") return listTenants(argv.slice(1))
  if (command === "sync") return sync.sync(argv.slice(1))
  if (command === "init") return init(argv.slice(1))
  if (command === "status") return status(argv.slice(1))
  if (command === "doctor") return sync.doctor(argv.slice(1))
  if (command === "remote") return remote.remote(argv.slice(1))
  if (command === "update") return update()
  if ((WS_COMMANDS as readonly string[]).includes(command)) return ws(command, argv.slice(1))

  if (command.startsWith("-")) {
    process.stderr.write(`gm: unknown option ${command}\n\n${USAGE}`)
    process.exit(2)
  }

  if (!TENANT_ID.test(command)) {
    process.stderr.write(`gm: invalid tenant id ${command}\n\n${USAGE}`)
    process.exit(2)
  }
  return launch(command, argv.slice(1))
}

/** Verify entitlement, ensure the workspace, then exec the engine. */
const launch = async (id: string | undefined, forwarded: string[] = []): Promise<never> => {
  if (!id) {
    process.stderr.write("gm: no tenant selected\n")
    process.exit(1)
  }

  const entitlement = await tenants.entitlement()
  if (entitlement.status === 403) tenants.refuse(id)
  if (!tenants.isEntitled(entitlement.tenants, id)) tenants.refuse(id)

  const tenant = entitlement.tenants.find((entry) => entry.id === id)
  if (!tenant) tenants.refuse(id)

  if (entitlement.degraded) {
    process.stderr.write(`gm: entitlement refresh failed (${entitlement.degraded}); using the cached set\n`)
  }

  const dir = bootstrap.ensureWorkspace(id, tenant.mcp_url)
  tenants.setCurrent(id)

  const args = forwarded[0] === "--" ? forwarded.slice(1) : forwarded
  exec(paths.opencodeBin(), args, { cwd: dir })
}

/** Interactive picker: numbered list, empty answer cancels. */
const pickTenant = async () => {
  const entitlement = await tenants.entitlement()
  const list = entitlement.tenants
  if (!list.length) {
    process.stderr.write(
      `gm: no entitled tenants found${entitlement.degraded ? ` (${entitlement.degraded})` : ""}.\n` +
        "Check AIOPS_MCP_TOKEN in ~/.config/opencode/.env, then run `gm tenant --refresh`.\n",
    )
    process.exit(1)
  }
  const current = tenants.current()
  process.stdout.write("Tenants:\n")
  list.forEach((tenant, index) => {
    process.stdout.write(`  ${index + 1}) ${tenant.id}${tenant.id === current ? "  (current)" : ""}\n`)
  })
  process.stdout.write(`Choose [1-${list.length}] (Enter for ${current || list[0]?.id}): `)

  const answer = await readLine()
  if (!answer.trim()) return current || list[0]?.id
  const index = Number(answer.trim())
  if (Number.isInteger(index) && index >= 1 && index <= list.length) return list[index - 1]?.id
  const byName = list.find((tenant) => tenant.id === answer.trim())
  if (byName) return byName.id
  process.stderr.write(`gm: no such tenant: ${answer.trim()}\n`)
  process.exit(2)
}

const readLine = async () => {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question("")
  rl.close()
  return answer
}

const listTenants = async (args: string[]) => {
  const entitlement = await tenants.entitlement({ refresh: args.includes("--refresh") })
  const current = tenants.current()

  if (args.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          updated: entitlement.cache?.updated ?? null,
          base_url: entitlement.cache?.base_url ?? tenants.baseUrl(entitlement.cache),
          current: current || null,
          degraded: entitlement.degraded ?? null,
          tenants: entitlement.tenants,
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  if (!entitlement.tenants.length) {
    process.stderr.write(
      `No entitled tenants${entitlement.degraded ? ` (${entitlement.degraded})` : ""}.\n` +
        "Check AIOPS_MCP_TOKEN in ~/.config/opencode/.env, then run `gm tenant --refresh`.\n",
    )
    process.exit(1)
  }

  process.stdout.write(`Entitled tenants (${entitlement.tenants.length}):\n`)
  for (const tenant of entitlement.tenants) {
    process.stdout.write(`  ${tenant.id === current ? "*" : " "} ${tenant.id}\n`)
  }
  if (entitlement.degraded) process.stderr.write(`gm: refresh failed (${entitlement.degraded}); showing the cache\n`)
}

const init = (args: string[]) => {
  const force = args.includes("--force")
  const report = bootstrap.init({ force })
  process.stdout.write(
    `gm init: ${report.written} written, ${report.skipped} already present${report.backedUp ? `, ${report.backedUp} backed up` : ""}\n`,
  )
  if (!force && report.skipped) process.stdout.write("  (existing files are kept; use `gm init --force` to replace them)\n")
  for (const note of report.notes) process.stdout.write(`  ${note}\n`)
  process.stdout.write(`  ${assets.count()} assets, version ${assets.ASSET_VERSION}\n`)
}

const status = async (args: string[]) => {
  const json = args.includes("--json")
  const short = args.includes("--short")
  const id = tenants.current()
  const syncAge = syncAgeOf()
  const git = gitState()
  const mcp = mcpCount()

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        { tenant: id || null, sync: syncAge, git, mcp_servers: mcp, root: paths.root(), assets: assets.ASSET_VERSION },
        null,
        2,
      )}\n`,
    )
    return
  }

  if (short) {
    const dirty = git.dirty ? "*" : ""
    process.stdout.write(
      `gm: ${id || "no tenant"} | sync ${syncAge.label} | ${git.branch || "no git"}${dirty} | ${mcp ?? "?"} mcp\n`,
    )
    return
  }

  process.stdout.write(`GMharness status\n`)
  process.stdout.write(`  root        ${paths.root()}\n`)
  const tenantLabel = id || "(none - set one with `gm <tenant>`)"
  process.stdout.write(`  tenant      ${tenantLabel}\n`)
  process.stdout.write(`  sync        ${syncAge.label}${syncAge.stale ? "  (stale: > 36h)" : ""}\n`)
  process.stdout.write(`  git         ${git.branch || "(not a repo)"}${git.dirty ? " (dirty)" : ""}\n`)
  process.stdout.write(`  engine      ${paths.opencodeBin()}\n`)
  process.stdout.write(`  config      ${paths.opencodeConfig()}\n`)
  process.stdout.write(`  mcp servers ${mcp ?? "unknown"}\n`)
  process.stdout.write(`  assets      ${assets.count()} files, version ${assets.ASSET_VERSION}\n`)
}

/** Age of `state/sync.json`; the file is rewritten by every sync run. */
const syncAgeOf = () => {
  const file = paths.syncStateFile()
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat) return { label: "never", stale: true, seconds: null as number | null }
  const seconds = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000))
  return { label: `${humanize(seconds)} ago`, stale: seconds > 36 * 3600, seconds }
}

const humanize = (seconds: number) => {
  if (seconds < 90) return `${seconds}s`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

const gitState = () => {
  const root = paths.root()
  if (!existsSync(join(root, ".git"))) return { branch: "", dirty: false }
  const branch = run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { capture: true })
  const porcelain = run("git", ["-C", root, "status", "--porcelain"], { capture: true })
  return { branch: branch.stdout.trim(), dirty: porcelain.stdout.trim().length > 0 }
}

/** Count `mcp.servers` keys in the installed config — local file read, no network. */
const mcpCount = () => {
  for (const file of [paths.opencodeConfig(), paths.gmharnessConfig()]) {
    if (!existsSync(file)) continue
    try {
      const text = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")
      const servers = (JSON.parse(text) as { mcp?: { servers?: Record<string, unknown> } })?.mcp?.servers
      if (servers) return Object.keys(servers).length
    } catch {
      // Unreadable config: report unknown rather than guessing.
    }
  }
  return null
}

const update = (): never => {
  const root = paths.root()
  process.stdout.write(`gm update: ${root}\n`)
  const pull = run("git", ["-C", root, "pull", "--ff-only"])
  if (pull.status !== 0) {
    process.stderr.write("gm update: git pull failed — resolve the tree by hand, then re-run.\n")
    process.exit(pull.status)
  }
  const installer = join(root, "install.sh")
  if (!existsSync(installer)) {
    process.stderr.write(`gm update: ${installer} not found\n`)
    process.exit(1)
  }
  if (!which("bash")) {
    process.stderr.write("gm update: bash is not on PATH\n")
    process.exit(1)
  }
  return exec("bash", [installer], { cwd: root })
}

/** `gm netprobe …` → `<state>/bin/ws-netprobe …` (or `<root>/bin/ws-netprobe`). */
const ws = (name: string, args: string[]): never => {
  const asset = `bin/ws-${name}`
  const extracted = assets.has(asset) ? bootstrap.ensure(asset) : ""
  const candidates = [extracted, join(paths.root(), "bin", `ws-${name}`)].filter(Boolean)
  const script = candidates.find((path) => existsSync(path))
  if (!script) {
    process.stderr.write(`gm: ws-${name} is not installed (run \`gm init\`)\n`)
    process.exit(1)
  }
  if (!which("bash")) {
    process.stderr.write("gm: bash is not on PATH\n")
    process.exit(1)
  }
  return exec("bash", [script, ...args], { cwd: paths.root() })
}

await main()
