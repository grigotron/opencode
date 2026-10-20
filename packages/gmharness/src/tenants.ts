// Tenant entitlement: a 12-hour cache of `GET {AIOPS_BASE_URL}/tenants`, the
// token it needs, and the exact refusal message used by both `gm` and sync.
//
// The token is read but never printed: no function in this module returns it.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import * as paths from "./paths"
import { readEnv } from "./render"

export const DEFAULT_BASE_URL = "https://aiops.efellows.bg/engineer"
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

export type Tenant = { id: string; mcp_url: string }
export type TenantCache = { updated: string; base_url: string; tenants: Tenant[] }
export type FetchResult =
  | { ok: true; tenants: Tenant[]; base_url: string }
  | { ok: false; status: number; message: string }

export const baseUrl = (cache?: TenantCache) => {
  const value =
    process.env.AIOPS_BASE_URL || cache?.base_url || readEnv(paths.envFile()).AIOPS_BASE_URL || DEFAULT_BASE_URL
  return value.replace(/\/+$/, "")
}

/** `$AIOPS_MCP_TOKEN`, else the value in `~/.config/opencode/.env`. */
export const token = () => process.env.AIOPS_MCP_TOKEN || readEnv(paths.envFile()).AIOPS_MCP_TOKEN || ""

export const mcpUrl = (id: string, base = DEFAULT_BASE_URL) => `${base.replace(/\/+$/, "")}/${id}/mcp`

export const readCache = (): TenantCache | undefined => {
  const file = paths.tenantsCacheFile()
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, "utf8")) as TenantCache
  if (!parsed || !Array.isArray(parsed.tenants)) return undefined
  return parsed
}

export const writeCache = (cache: TenantCache) => {
  const file = paths.tenantsCacheFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

export const isStale = (cache: TenantCache) => {
  const updated = Date.parse(cache.updated)
  if (Number.isNaN(updated)) return true
  return Date.now() - updated > CACHE_TTL_MS
}

export const ageMs = (cache: TenantCache) => {
  const updated = Date.parse(cache.updated)
  return Number.isNaN(updated) ? Number.POSITIVE_INFINITY : Date.now() - updated
}

/** `GET {base}/tenants` with a bearer token and a 10s deadline. */
export const fetchTenants = async (): Promise<FetchResult> => {
  const cache = readCache()
  const base = baseUrl(cache)
  const auth = token()
  if (!auth) return { ok: false, status: 0, message: `AIOPS_MCP_TOKEN is not set in ${paths.envFile()}` }

  try {
    const response = await fetch(`${base}/tenants`, {
      headers: { Authorization: `Bearer ${auth}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      const message = response.status === 403 ? "not entitled" : `HTTP ${response.status}`
      return { ok: false, status: response.status, message }
    }
    const body = (await response.json()) as unknown
    return { ok: true, tenants: normalize(body, base), base_url: base }
  } catch (error) {
    return { ok: false, status: 0, message: describe(error) }
  }
}

/** The API answers `{tenants: [{tenant_id, …}]}`; accept a bare array too. */
const normalize = (body: unknown, base: string): Tenant[] => {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { tenants?: unknown })?.tenants)
      ? ((body as { tenants: unknown[] }).tenants ?? [])
      : Array.isArray((body as { data?: unknown })?.data)
        ? ((body as { data: unknown[] }).data ?? [])
        : []

  return list.flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry, mcp_url: mcpUrl(entry, base) }]
    if (!entry || typeof entry !== "object") return []
    const record = entry as Record<string, unknown>
    const id = record.id ?? record.tenant_id ?? record.slug ?? record.name
    if (typeof id !== "string" || !id) return []
    const url = record.mcp_url ?? record.mcpUrl ?? mcpUrl(id, base)
    return [{ id, mcp_url: typeof url === "string" ? url : mcpUrl(id, base) }]
  })
}

const describe = (error: unknown) => {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out after 10s"
    return error.message
  }
  return String(error)
}

export type Entitlement = {
  cache: TenantCache | undefined
  tenants: Tenant[]
  /** Set when the refresh failed and an older cache was used. */
  degraded?: string
  /** HTTP status of the failed refresh (403 means "not entitled at all"). */
  status?: number
}

/**
 * The entitled set. A fresh cache is authoritative (no network, so plain
 * `gm <tenant>` stays fast); a stale one is refreshed and, on failure, the
 * cached set is kept and the caller can report `degraded`.
 */
export const entitlement = async (options: { refresh?: boolean } = {}): Promise<Entitlement> => {
  const cache = readCache()
  const fresh = cache && !isStale(cache)
  if (fresh && !options.refresh) return { cache, tenants: cache.tenants }

  const result = await fetchTenants()
  if (result.ok) {
    const next: TenantCache = {
      updated: new Date().toISOString(),
      base_url: result.base_url,
      tenants: result.tenants,
    }
    writeCache(next)
    return { cache: next, tenants: next.tenants }
  }
  return { cache, tenants: cache?.tenants ?? [], degraded: result.message, status: result.status }
}

export const ids = (tenants: Tenant[]) => tenants.map((tenant) => tenant.id)

export const isEntitled = (tenants: Tenant[], id: string) => tenants.some((tenant) => tenant.id === id)

/** The exact refusal required by the contract. Written to stderr; exit 3. */
export const refuse = (id: string): never => {
  process.stderr.write(
    [
      "You need to request an access package for this function.",
      `Tenant: ${id}`,
      "Run `gm tenant` to see the tenants you are entitled to.",
      "",
    ].join("\n"),
  )
  process.exit(3)
}

/** Last tenant launched, else `AIOPS_TENANT` from `.env`. */
export const current = () => {
  const file = paths.currentTenantFile()
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim()
    if (value) return value
  }
  return readEnv(paths.envFile()).AIOPS_TENANT || ""
}

export const setCurrent = (id: string) => {
  mkdirSync(paths.stateDir(), { recursive: true })
  writeFileSync(paths.currentTenantFile(), `${id}\n`)
}
