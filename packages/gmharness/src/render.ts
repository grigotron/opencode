// Render `{env:NAME}` references in a config template from the OpenCode `.env`.
//
// Mirrors scripts/render-config.py: a reference with an empty value is left
// verbatim so `doctor.sh` can report it, and line comments are stripped before
// the result is parsed so a JSONC template can be validated as JSON.

import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

const REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const LINE_COMMENT = /^\s*\/\/.*$/gm

export type Env = Record<string, string>

/** Parse a `.env` file. Missing file yields `{}`; quotes are stripped. */
export const readEnv = (path: string): Env => {
  if (!existsSync(path)) return {}
  const env: Env = {}
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || !line.includes("=")) continue
    const index = line.indexOf("=")
    const key = line.slice(0, index).trim()
    const value = unquote(line.slice(index + 1).trim())
    env[key] = value
  }
  return env
}

const unquote = (value: string) => {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1)
  }
  return value
}

/** Substitute `{env:NAME}`; unresolved names are returned for reporting. */
export const render = (template: string, env: Env) => {
  const missing = new Set<string>()
  const text = template.replace(REF, (match, name: string) => {
    const value = env[name]
    if (value) return value
    missing.add(name)
    return match
  })
  return { text, missing: [...missing] }
}

/** Parse the rendered config as JSON (comments stripped). Throws on bad input. */
export const parse = (text: string) => JSON.parse(text.replace(LINE_COMMENT, "")) as unknown

export type RenderResult = {
  written: boolean
  missing: string[]
  backup?: string
}

/**
 * Render `template` into `dest` with mode 600. An existing file is only
 * replaced when `force` is set, and then it is backed up first.
 */
export const renderConfig = (input: {
  template: string
  dest: string
  envFile: string
  force?: boolean
  warn?: (message: string) => void
}): RenderResult => {
  const env = readEnv(input.envFile)
  const { text, missing } = render(input.template, env)
  parse(text)

  const warn = input.warn ?? ((message: string) => process.stderr.write(`gm: ${message}\n`))
  if (!env.EFELLOWS_API_KEY) {
    warn(`EFELLOWS_API_KEY is empty in ${input.envFile} — the config is written but the model provider will not authenticate.`)
  }
  for (const name of missing) warn(`${name} has no value in ${input.envFile} — left as {env:${name}} in the config.`)

  const backup = input.force && existsSync(input.dest) ? backupFile(input.dest) : undefined
  writeFileSync(input.dest, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 })
  chmodSync(input.dest, 0o600)
  return { written: true, missing, backup }
}

/** Copy `path` to `path.bak-<ISO timestamp without colons>` and return the copy. */
export const backupFile = (path: string, stamp = new Date().toISOString()) => {
  const target = `${path}.bak-${stamp.replace(/[:.]/g, "-")}`
  copyFileSync(path, target)
  return target
}
