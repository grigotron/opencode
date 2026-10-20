// `gm remote` — run the always-on lab-VM control server.
//
// The phone talks to the OpenCode web UI (a PWA) over the VPN. Caddy terminates
// TLS in front of this process; the engine binds loopback only and requires
// Basic auth (`opencode` + the password in ~/.config/opencode/.remote-password).

import { createConnection } from "node:net"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { exec } from "./exec"
import * as paths from "./paths"

export type RemoteConfig = {
  host: string
  bind: string
  port: number
  scheme: string
  public_url?: string
  username?: string
}

export const configFile = () => join(paths.configDir(), "remote.json")
export const passwordFile = () => join(paths.configDir(), ".remote-password")

const defaults: RemoteConfig = {
  host: "lab-vm",
  bind: "127.0.0.1",
  port: 4096,
  scheme: "https",
  public_url: "https://lab-vm:8443",
  username: "opencode",
}

export const readConfig = (): RemoteConfig => {
  if (!existsSync(configFile())) return defaults
  try {
    const text = readFileSync(configFile(), "utf8").replace(/^\s*\/\/.*$/gm, "")
    return { ...defaults, ...(JSON.parse(text) as Partial<RemoteConfig>) }
  } catch {
    process.stderr.write(`gm remote: ${configFile()} is not valid JSON; using defaults\n`)
    return defaults
  }
}

export const ensurePassword = (rotate = false) => {
  const file = passwordFile()
  if (!rotate && existsSync(file)) {
    const value = readFileSync(file, "utf8").trim()
    if (value) return value
  }
  const value = randomBytes(32).toString("base64url")
  writeFileSync(file, value + "\n", { mode: 0o600 })
  chmodSync(file, 0o600)
  return value
}

const url = (config: RemoteConfig) =>
  config.public_url || `${config.scheme}://${config.host}:${config.port}`

export const serve = (args: string[]) => {
  const config = readConfig()
  const forwarded = args.filter((arg) => arg !== "--")
  if (config.bind === "0.0.0.0" || config.bind === "::") {
    process.stderr.write(
      "gm remote: refusing to bind all interfaces. Set `bind` to the VPN address (or 127.0.0.1 behind Caddy).\n",
    )
    process.exit(2)
  }
  const password = ensurePassword()
  process.stderr.write(
    [
      `gm remote: serving on ${config.bind}:${config.port}`,
      `  phone URL : ${url(config)}`,
      `  username  : ${config.username ?? "opencode"}`,
      `  password  : ${passwordFile()} (mode 600; never printed)`,
      `  stop      : Ctrl-C`,
      "",
    ].join("\n"),
  )
  return exec(
    paths.opencodeBin(),
    ["serve", "--hostname", config.bind, "--port", String(config.port), ...forwarded],
    {
      cwd: paths.root(),
      env: { ...process.env, OPENCODE_PASSWORD: password },
    },
  )
}

export const showUrl = () => {
  const config = readConfig()
  process.stdout.write(
    [
      `url       ${url(config)}`,
      `bind      ${config.bind}:${config.port}`,
      `username  ${config.username ?? "opencode"}`,
      `password  ${passwordFile()} (read it locally; never paste it into chat)`,
      "",
      "On the phone: connect the VPN, open the URL in Safari, then Share → Add to Home Screen.",
      "If the certificate is the lab CA, install and trust it first (Settings → General → VPN & Device Management).",
      "",
    ].join("\n"),
  )
}

export const status = () => {
  const config = readConfig()
  const done = (ok: boolean, detail: string) => {
    process.stdout.write(`${ok ? "up  " : "down"}  ${url(config)}  ${detail}\n`)
    process.exit(ok ? 0 : 1)
  }
  const target = new URL(url(config))
  const host = target.hostname
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80))
  const socket = createConnection({ host, port })
  const timer = setTimeout(() => {
    socket.destroy()
    done(false, `(connect timeout to ${host}:${port})`)
  }, 1500)
  socket.once("connect", () => {
    clearTimeout(timer)
    socket.end()
    done(true, "")
  })
  socket.once("error", (error) => {
    clearTimeout(timer)
    done(false, `(${(error as NodeJS.ErrnoException).code ?? "error"})`)
  })
}

export const password = (args: string[]) => {
  const rotate = args.includes("--rotate")
  ensurePassword(rotate)
  process.stdout.write(
    `remote password ${rotate ? "rotated" : "ready"}: ${passwordFile()} (mode 600, value not printed)\n`,
  )
}

export const remote = (args: string[]) => {
  const command = args[0] ?? "url"
  if (command === "serve") return serve(args.slice(1))
  if (command === "url") return showUrl()
  if (command === "status") return status()
  if (command === "password") return password(args.slice(1))
  process.stderr.write("usage: gm remote [serve|url|status|password [--rotate]]\n")
  process.exit(2)
}
