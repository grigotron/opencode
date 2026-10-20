// Process and PATH helpers. `spawnSync` with inherited stdio keeps the child's
// TTY, signals and exit code intact — `gm` is mostly a launcher, so nothing here
// captures output unless the caller asks for it.

import { accessSync, constants, statSync } from "node:fs"
import { spawnSync } from "node:child_process"

export type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Capture stdout instead of inheriting it (used by `status`). */
  capture?: boolean
}

export const run = (command: string, args: string[] = [], options: RunOptions = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
  })
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { status: 127, stdout: "" }
    throw result.error
  }
  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stdout: options.capture ? (result.stdout?.toString() ?? "") : "",
  }
}

/** Replace this process with `command` (exec semantics, no extra shell). */
export const exec = (command: string, args: string[] = [], options: RunOptions = {}): never => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  })
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      process.stderr.write(`gm: command not found: ${command}\n`)
      process.exit(127)
    }
    throw result.error
  }
  process.exit(result.status ?? 1)
}

/** `which`, without spawning a shell. */
export const which = (name: string) => {
  if (name.includes("/")) return isExecutable(name) ? name : undefined
  const path = process.env.PATH ?? ""
  for (const dir of path.split(":")) {
    if (!dir) continue
    const candidate = `${dir}/${name}`
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

const isExecutable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
