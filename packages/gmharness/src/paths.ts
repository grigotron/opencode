// XDG-aware locations and root/binary resolution for GMharness.
//
// Everything here is pure path arithmetic plus a couple of cheap filesystem
// probes: it runs on every `gm` invocation, so it must stay under a millisecond
// and must never touch the network.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const home = () => process.env.HOME || homedir()

/** `~/.config/opencode` (or `$XDG_CONFIG_HOME/opencode`). */
export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "opencode")

export const envFile = () => join(configDir(), ".env")
export const opencodeConfig = () => join(configDir(), "opencode.json")
export const opencodeConfigJsonc = () => join(configDir(), "opencode.jsonc")
export const gmharnessConfig = () => join(configDir(), ".gmharness-config.jsonc")
export const tokenFile = () => join(configDir(), ".aiops-token")
export const tenantsCacheFile = () => join(configDir(), ".tenants.json")
export const agentsDir = () => join(configDir(), "agents")
export const skillsDir = () => join(configDir(), "skills")
export const commandsDir = () => join(configDir(), "commands")

/**
 * Repository root: `$GMHARNESS_ROOT`, else walk up from the running binary
 * (and from this module in dev) until a directory holds both `AGENTS.md` and
 * `agents/`, else `~/work-stack`.
 */
export const root = () => {
  const fromEnv = process.env.GMHARNESS_ROOT
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv)

  for (const start of [executableDir(), import.meta.dir]) {
    const found = walkUpForRoot(start)
    if (found) return found
  }
  return join(home(), "work-stack")
}

/** Directory of the real executable, symlinks resolved (`~/.local/bin/gm`). */
export const executableDir = () => {
  const exe = process.execPath
  if (!exe) return process.cwd()
  if (!existsSync(exe)) return dirname(exe)
  return dirname(realpathSync(exe))
}

const walkUpForRoot = (start: string) => {
  let current = resolve(start)
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(join(current, "AGENTS.md")) && isDirectory(join(current, "agents"))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

const isDirectory = (path: string) => {
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat?.isDirectory() ?? false
}

/** Runtime state: `<root>/state` per the contract. */
export const stateDir = () => join(root(), "state")
export const stateScriptsDir = () => join(stateDir(), "scripts")
export const stateBinDir = () => join(stateDir(), "bin")
export const stateSystemdDir = () => join(stateDir(), "systemd")
export const syncStateFile = () => join(stateDir(), "sync.json")
export const syncLogFile = () => join(stateDir(), "sync.log")
export const versionFile = () => join(stateDir(), "version.json")
export const currentTenantFile = () => join(stateDir(), "current-tenant")

export const tenantsDir = () => join(root(), "tenants")
export const tenantDir = (id: string) => join(tenantsDir(), id)

/** The OpenCode engine checkout inside the umbrella repo. */
export const engineDir = () => {
  const candidates = [join(root(), "engine"), join(root(), "vendor", "opencode")]
  return candidates.find((path) => existsSync(path)) ?? root()
}

/**
 * The engine binary, in order: `$GM_OPENCODE_BIN`, a compiled build under
 * `packages/cli/dist/<target>/bin/opencode`, `~/.local/bin/opencode`, then
 * `opencode` on PATH.
 */
export const opencodeBin = () => {
  const fromEnv = process.env.GM_OPENCODE_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const dist = join(engineDir(), "packages", "cli", "dist")
  const platform = process.platform === "win32" ? "windows" : process.platform
  // The CLI build names its output either cli-<os>-<arch> (bun build) or
  // opencode-<os>-<arch> (release artifact); accept both.
  const names = [`cli-${platform}-${process.arch}`, `opencode-${platform}-${process.arch}`]
  for (const name of names) {
    const exact = join(dist, name, "bin", "opencode")
    if (existsSync(exact)) return exact
  }

  // Builds with an avx2/libc suffix: cli-linux-x64-baseline, …-musl.
  const variant = readdirSyncSafe(dist).find(
    (entry) =>
      (entry.startsWith(`cli-${platform}-${process.arch}`) ||
        entry.startsWith(`opencode-${platform}-${process.arch}`)) &&
      existsSync(join(dist, entry, "bin", "opencode")),
  )
  if (variant) return join(dist, variant, "bin", "opencode")

  const local = join(home(), ".local", "bin", "opencode")
  if (existsSync(local)) return local
  return "opencode"
}

const readdirSyncSafe = (path: string) => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}
