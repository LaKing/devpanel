import { hostPlatform } from './platform.mjs'

/*
 * What this host may run, and how, in one place (owner decisions 2026-10-13).
 *
 * The seat fence is bubblewrap (harness/fence.mjs), which only Linux has.
 *   fence     Linux: seats, checks and tooling run inside the proved fence.
 *   off       Linux with DEVPANEL_FENCE=off: the operator's switch, as before.
 *   unfenced  no bubblewrap (macOS), and this install opted in with
 *             DEVPANEL_UNFENCED=acknowledged (install-on-osx.sh): seats run as
 *             namespace 0, local checks local-unconfined, tooling unconfined,
 *             and every run and the panel say so.
 *   refused   no bubblewrap and no opt-in (the default): seat turns, tooling
 *             commands and local checks are refused before they start.
 * Without bubblewrap DEVPANEL_FENCE=off and DEVPANEL_FENCE_UNPROVED=run grant
 * nothing: the opt-in is the only way to run unfenced there.
 */

export const UNFENCED_OPT_IN = 'acknowledged'

const hostName = (id) => id === 'darwin' ? 'macOS (darwin)' : id

export function fencePolicy ({ platform = hostPlatform(), env = process.env } = {}) {
  if (platform.bubblewrap) return env.DEVPANEL_FENCE === 'off' ? { mode: 'off', reason: 'switched off (DEVPANEL_FENCE=off)' } : { mode: 'fence', reason: null }
  const name = hostName(platform.id)
  if (env.DEVPANEL_UNFENCED === UNFENCED_OPT_IN) {
    return { mode: 'unfenced', platform: platform.id, reason: `${name} has no seat fence; this install opted in to unfenced operation (DEVPANEL_UNFENCED=${UNFENCED_OPT_IN})` }
  }
  return { mode: 'refused', platform: platform.id, reason: `${name} has no seat fence (bubblewrap is Linux-only) and this install has not opted in to unfenced operation: seat turns, tooling commands and local checks are refused (DEVPANEL_UNFENCED=${UNFENCED_OPT_IN} bash install-on-osx.sh opts in)` }
}

/** Why a harness cannot run on this host at all, or null (owner decision 3: every Gemini seat on macOS). */
export function harnessRefusal (harness, { platform = hostPlatform() } = {}) {
  if (platform.bubblewrap) return null
  // Antigravity's rules do not confine reads and its workspace hooks run by themselves: only the fence holds it.
  if (harness === 'antigravity') return `antigravity seats are refused on ${hostName(platform.id)}: the adapter gives a seat tools only inside the seat fence, which this host does not have`
  if (harness !== 'gemini') return null
  return `gemini seats are refused on ${hostName(platform.id)}: the Gemini adapter's read-only confinement needs bubblewrap and the seat fence, which this host does not have (refused for every seat until a fence exists here)`
}

/** What an unfenced run records about itself (run.unfenced). */
export function unfencedRecord (policy, at) {
  return { platform: policy.platform, reason: policy.reason, optIn: `DEVPANEL_UNFENCED=${UNFENCED_OPT_IN}`, seats: 'namespace 0', checks: 'local-unconfined', tooling: 'unconfined', at }
}
