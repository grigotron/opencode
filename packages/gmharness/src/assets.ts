// Read-only accessors over the embedded asset map.

import { ASSETS, ASSET_HASH, ASSET_VERSION } from "./assets.gen"

export { ASSET_HASH, ASSET_VERSION }

export const get = (path: string) => ASSETS[path]

export const has = (path: string) => path in ASSETS

export const list = (prefix?: string) =>
  Object.keys(ASSETS)
    .filter((path) => (prefix ? path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`) : true))
    .sort()

export const count = () => Object.keys(ASSETS).length

/** Top-level groups, e.g. `agents`, `commands`, `skills` — used by `gm status`. */
export const groups = () => {
  const result = new Map<string, number>()
  for (const path of Object.keys(ASSETS)) {
    const group = path.includes("/") ? path.slice(0, path.indexOf("/")) : path
    result.set(group, (result.get(group) ?? 0) + 1)
  }
  return result
}
