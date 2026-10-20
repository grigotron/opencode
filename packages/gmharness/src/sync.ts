// Run the embedded Hermes sync script and doctor.
//
// Both live in the state dir after extraction so they can be inspected and run
// by hand (`<root>/state/scripts/gm_sync.py`). Flags are passed through
// untouched: the CLI does not re-implement the sync contract.

import * as assets from "./assets"
import * as bootstrap from "./bootstrap"
import { exec, which } from "./exec"
import * as paths from "./paths"

export const SYNC_ASSET = "scripts/gm_sync.py"
export const DOCTOR_ASSET = "scripts/doctor.sh"

/** Extract the sync script and return its path, or exit with a clear reason. */
export const syncScript = () => extract(SYNC_ASSET, "python3")

export const doctorScript = () => extract(DOCTOR_ASSET, "bash")

const extract = (asset: string, interpreter: string) => {
  if (!assets.has(asset)) {
    process.stderr.write(`gm: ${asset} is not embedded in this build — rebuild with \`bun run assets\`.\n`)
    process.exit(1)
  }
  if (!which(interpreter)) {
    process.stderr.write(`gm: ${interpreter} is not on PATH.\n`)
    process.exit(1)
  }
  return bootstrap.ensure(asset)
}

/** `gm sync [flags]` — exec `python3 <state>/scripts/gm_sync.py <flags>`. */
export const sync = (args: string[]): never =>
  exec("python3", [syncScript(), ...args], { cwd: paths.root() })

/** `gm doctor` — exec the embedded doctor.sh with bash, from the repo root. */
export const doctor = (args: string[] = []): never =>
  exec("bash", [doctorScript(), ...args], { cwd: paths.root() })
