'use strict'

const { createRequire } = require('node:module')

/**
 * Fills the TrackStore after a restart from the server's Track API (SignalK
 * server 2.33+, provided by @signalk/tracks-plugin 3+), so estimates come back
 * within one analysis cycle instead of after the minimum dwell.
 *
 * In process through app.getTrackApi(): no HTTP, port or token. Seeded fixes
 * carry position only; the tracks plugin records no heading.
 */

const DEFAULT_RESOLUTION_S = 30
const DEFAULT_RETRY_MS = 15000
const DEFAULT_MAX_WAIT_MS = 3 * 60 * 1000

/**
 * The Track API takes Temporal values. The server ships the polyfill, so look
 * for it from the server's own module tree; a later Node may have it built in.
 */
function loadTemporal() {
  if (globalThis.Temporal) return globalThis.Temporal
  const bases = []
  if (require.main && require.main.filename) bases.push(require.main.filename)
  bases.push(__filename)
  for (const base of bases) {
    const req = createRequire(base)
    try {
      return req('@js-temporal/polyfill').Temporal
    } catch (err) {
      // not hoisted; try next to the server API package
    }
    try {
      return createRequire(req.resolve('@signalk/server-api'))('@js-temporal/polyfill').Temporal
    } catch (err) {
      // not here either
    }
  }
  return null
}

/**
 * The time window as the Track API expects it. Without Temporal, plain objects
 * carrying epochMilliseconds (all a provider reads from an instant) and no
 * resolution: the TrackStore thins on insert instead.
 */
function buildRequest(fromMs, toMs, resolutionS, Temporal) {
  if (Temporal) {
    return {
      from: Temporal.Instant.fromEpochMilliseconds(fromMs),
      to: Temporal.Instant.fromEpochMilliseconds(toMs),
      resolution: Temporal.Duration.from({ seconds: resolutionS }),
      times: true
    }
  }
  const instant = (ms) => ({ epochMilliseconds: ms, toString: () => new Date(ms).toISOString() })
  return { from: instant(fromMs), to: instant(toMs), times: true }
}

/**
 * Track API FeatureCollection -> Map(context -> fixes oldest first). Skips the
 * own vessel, imported tracks (GPX files, not recordings) and untimed points.
 * Coordinates are GeoJSON order, [lon, lat].
 */
function featuresToFixes(collection, selfContext) {
  const out = new Map()
  const features = (collection && collection.features) || []
  for (const f of features) {
    const p = (f && f.properties) || {}
    const g = f && f.geometry
    if (!g || typeof p.context !== 'string' || !p.context.startsWith('vessels.')) continue
    if (p.isSelf || p.context === selfContext || p.imported !== undefined) continue
    const lines = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : null
    const times = g.type === 'LineString' && p.coordTimes && !Array.isArray(p.coordTimes[0]) ? [p.coordTimes] : p.coordTimes
    if (!Array.isArray(lines) || !Array.isArray(times)) continue
    const fixes = out.get(p.context) || []
    lines.forEach((line, i) => {
      const ts = times[i] || []
      ;(line || []).forEach((c, j) => {
        const t = Date.parse(ts[j]) / 1000
        if (!Array.isArray(c) || !Number.isFinite(t)) return
        const [lon, lat] = c
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
        fixes.push({ t, lat, lon })
      })
    })
    if (fixes.length) out.set(p.context, fixes)
  }
  for (const fixes of out.values()) fixes.sort((a, b) => a.t - b.t)
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Seed `store` with the last `historyS` seconds of every other vessel's track.
 * Resolves { ok: true, vessels, fixes } or { ok: false, reason } and never
 * rejects. `cancelled()` is checked between steps so a stopped plugin does not
 * write into a dropped store.
 */
async function seed(app, store, opts = {}) {
  const {
    historyS,
    resolutionS = DEFAULT_RESOLUTION_S,
    retryMs = DEFAULT_RETRY_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    cancelled = () => false,
    wait = sleep,
    now = () => Date.now(),
    Temporal = loadTemporal()
  } = opts
  if (typeof app.getTrackApi !== 'function') {
    return { ok: false, reason: 'no-track-api' }
  }
  // The tracks plugin may start after us; give it a while to register.
  let api = null
  let waited = 0
  for (;;) {
    try {
      api = await app.getTrackApi()
      break
    } catch (err) {
      if (waited >= maxWaitMs) return { ok: false, reason: 'no-provider' }
    }
    await wait(retryMs)
    waited += retryMs
    if (cancelled()) return { ok: false, reason: 'cancelled' }
  }
  if (cancelled()) return { ok: false, reason: 'cancelled' }
  const toMs = now()
  let collection
  try {
    collection = await api.getTracks(buildRequest(toMs - historyS * 1000, toMs, resolutionS, Temporal))
  } catch (err) {
    return { ok: false, reason: 'fetch-failed', error: err }
  }
  if (cancelled()) return { ok: false, reason: 'cancelled' }
  let vessels = 0
  let fixes = 0
  for (const [ctx, list] of featuresToFixes(collection, app.selfContext)) {
    const n = store.seed(ctx, list)
    if (n > 0) {
      vessels++
      fixes += n
    }
  }
  return { ok: true, vessels, fixes }
}

module.exports = { seed, featuresToFixes, buildRequest, loadTemporal }
