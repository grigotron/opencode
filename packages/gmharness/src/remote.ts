// `gm remote` — run the always-on lab-VM control server.
//
// The phone talks to the OpenCode web UI (a PWA) over the VPN. Caddy terminates
// TLS in front of this process; the engine binds loopback only and requires
// Basic auth (`opencode` + the password in ~/.config/opencode/.remote-password).

import { createConnection } from "node:net"
import { spawn, spawnSync } from "node:child_process"
import { hostname } from "node:os"
import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { exec, run } from "./exec"
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

const sharePidFile = () => join(paths.stateDir(), "remote-share.pid")
const SHARE_PORT = 4196

const localEndpoint = () => {
  const status = run("opencode", ["service", "status"], { capture: true }).stdout.trim()
  const match = status.match(/https?:\/\/([^:/]+):(\d+)/)
  if (!match) process.stderr.write("gm remote share: could not read `opencode service status`; assuming 4096\n")
  return { port: match ? Number(match[2]) : 4096 }
}

const localPassword = (port: number) => {
  const roots = [join(paths.home(), ".local", "state", "opencode"), paths.configDir()]
  const candidates: { password: string; url?: string }[] = []
  for (const root of roots) {
    let files: string[] = []
    try {
      files = readdirSync(root).filter((name) => /^service.*\.json$/.test(name)).map((name) => join(root, name))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { password?: string; url?: string }
        if (typeof data.password === "string" && data.password) {
          candidates.push({ password: data.password, url: typeof data.url === "string" ? data.url : undefined })
        }
      } catch {
        // try the next file
      }
    }
  }
  // Prefer the record that names the running port, then a config entry without a URL.
  return (
    candidates.find((item) => item.url?.includes(`:${port}`))?.password ??
    candidates.find((item) => !item.url)?.password ??
    candidates[0]?.password ??
    ""
  )
}

const killShare = () => {
  const file = sharePidFile()
  if (!existsSync(file)) return false
  const pid = Number(readFileSync(file, "utf8").trim())
  if (Number.isFinite(pid) && pid > 0) {
    try { process.kill(pid, "SIGTERM") } catch { /* already gone */ }
  }
  try { unlinkSync(file) } catch { /* ignore */ }
  return true
}

const installAuthHeader = (password: string) => {
  if (!password) return false
  const basic = Buffer.from(`opencode:${password}`).toString("base64")
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "lab-root", "tee", "/etc/nginx/pile-local-auth.conf"],
    { input: `proxy_set_header Authorization "Basic ${basic}";\n`, encoding: "utf8" },
  )
  spawnSync("ssh", ["-o", "BatchMode=yes", "lab-root", "chmod 600 /etc/nginx/pile-local-auth.conf"], { stdio: "ignore" })
  const reload = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "lab-root", "nginx -t && systemctl reload nginx"],
    { stdio: "ignore" },
  )
  return result.status === 0 && reload.status === 0
}

export const share = (args: string[]) => {
  if (hostname() === "debian" || existsSync("/etc/gmharness-vm")) {
    process.stdout.write("You are on the lab VM. Use https://10.11.10.78:8443/ for the VM-hosted harness.\n")
    return
  }
  killShare()
  const { port } = localEndpoint()
  const password = localPassword(port)
  const child = spawn(
    "ssh",
    [
      "-N",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-R", `127.0.0.1:${SHARE_PORT}:127.0.0.1:${port}`,
      "lab-fvpn",
    ],
    { detached: true, stdio: "ignore" },
  )
  child.unref()
  writeFileSync(sharePidFile(), String(child.pid ?? "") + "\n", { mode: 0o600 })
  const ready = run("ssh", ["-o", "BatchMode=yes", "lab-fvpn", "ss -lntn | grep -q 4196"], { capture: true }).status === 0
  if (!ready) {
    process.stderr.write("gm remote share: the reverse tunnel did not come up; check `ssh lab-fvpn true`.\n")
    killShare()
    process.exit(1)
  }
  const auth = installAuthHeader(password)
  const open = args.includes("--open")
  let opened = false
  if (open) {
    const url = "https://10.11.10.78:8444/"
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
    const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url]
    opened = spawnSync(opener, argv, { stdio: "ignore" }).status === 0
  }
  process.stdout.write(
    [
      `shared   https://10.11.10.78:8444/  ->  local engine 127.0.0.1:${port}`,
      `auth     8444 login required (opencode) + upstream ${auth ? "injected" : "NOT injected"}`,
      `tunnel   pid ${child.pid ?? "?"} (ssh -R 127.0.0.1:${SHARE_PORT})`,
      `browser  ${open ? (opened ? "opened" : "could not open; use the URL") : "not requested"}`, 
      `stop     gm remote unshare`,
      "",
      "Open the URL on the phone, pick the live session from the list, and type into it.",
      "",
    ].join("\n"),
  )
}

export const unshare = () => {
  const stopped = killShare()
  process.stdout.write(stopped ? "remote share stopped\n" : "no remote share running\n")
}

export const shareStatus = () => {
  const file = sharePidFile()
  if (!existsSync(file)) {
    process.stdout.write("down  no local share\n")
    process.exit(1)
  }
  const pid = Number(readFileSync(file, "utf8").trim())
  let alive = false
  if (Number.isFinite(pid) && pid > 0) {
    try { process.kill(pid, 0); alive = true } catch { alive = false }
  }
  process.stdout.write(`${alive ? "up  " : "down"}  share pid ${pid} -> https://10.11.10.78:8444/\n`)
  process.exit(alive ? 0 : 1)
}

export const remote = (args: string[]) => {
  const command = args[0] ?? "url"
  if (command === "serve") return serve(args.slice(1))
  if (command === "url") return showUrl()
  if (command === "status") return status()
  if (command === "password") return password(args.slice(1))
  if (command === "share") return share(args.slice(1))
  if (command === "unshare") return unshare()
  if (command === "share-status") return shareStatus()
  process.stderr.write("usage: gm remote [serve|url|status|share|unshare|share-status|password [--rotate]]\n")
  process.exit(2)
}
