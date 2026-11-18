'use strict'

/**
 * Wind as a secondary anchor hint.
 *
 * A pleasure boat or sailboat lying to its anchor points its bow roughly into the
 * wind, so the anchor lies upwind of the boat. Wind is a much noisier pointer than
 * the boat's own heading (offline, heading vs harbor wind differed by a median of
 * about 65 degrees, vs gridded model wind about 35 to 40 degrees), so the detector
 * only uses it as a low-weight bearing hint, never to place an anchor (windHint).
 *
 * A wind source is any object with
 *   windFromAt(t, lat, lon) -> radians true the wind blows FROM, or undefined
 * OwnVesselWind (the default) answers from the own vessel's environment.wind.*
 * data and ignores the position. A gridded model source only has to implement
 * the same method, and can be wrapped with functionWindSource.
 */

const { makeProjection } = require('./geo')

const TWO_PI = 2 * Math.PI
const KNOT = 0.514444

// AIS ship types the hint applies to: 36 sailing, 37 pleasure craft.
const WIND_SHIP_TYPES = [36, 37]

function normAngle(a) {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

// Smallest absolute difference of two angles, radians.
function angleDiff(a, b) {
  const d = Math.abs(normAngle(a) - normAngle(b))
  return d > Math.PI ? TWO_PI - d : d
}

/**
 * Own vessel wind history. Feed it the own vessel's SignalK values with
 * handleValue(path, value, t); it keeps a thinned, time-bounded series of the
 * true wind direction.
 *
 * Paths used, best first:
 *   environment.wind.directionTrue    (direction the wind comes from, true)
 *   environment.wind.angleTrueGround  + navigation.headingTrue
 *   environment.wind.angleTrueWater   + navigation.headingTrue
 */
class OwnVesselWind {
  constructor({ maxAgeS = 12 * 3600, minIntervalS = 30, maxSkewS = 600 } = {}) {
    this.maxAgeS = maxAgeS
    this.minIntervalS = minIntervalS
    this.maxSkewS = maxSkewS
    this.series = [] // [{ t, w }] w = wind from, radians true
    this.heading = null // { t, h }
    this.lastDirectT = -Infinity // time of the last directionTrue sample
  }

  handleValue(path, value, t) {
    if (!Number.isFinite(value) || !Number.isFinite(t)) return
    if (path === 'navigation.headingTrue') {
      this.heading = { t, h: value }
    } else if (path === 'environment.wind.directionTrue') {
      this.lastDirectT = t
      this.add(t, value)
    } else if (path === 'environment.wind.angleTrueGround' || path === 'environment.wind.angleTrueWater') {
      // Only derive when no directionTrue is arriving, and the heading is fresh.
      if (t - this.lastDirectT <= this.maxSkewS) return
      if (!this.heading || Math.abs(t - this.heading.t) > 60) return
      this.add(t, this.heading.h + value)
    }
  }

  add(t, w) {
    const last = this.series[this.series.length - 1]
    if (last && t < last.t) return
    if (last && t - last.t < this.minIntervalS) return
    this.series.push({ t, w: normAngle(w) })
  }

  prune(nowS) {
    const cutoff = nowS - this.maxAgeS
    let k = 0
    while (k < this.series.length && this.series[k].t < cutoff) k++
    if (k > 0) this.series.splice(0, k)
  }

  windFromAt(t) {
    const s = this.series
    if (s.length === 0 || !Number.isFinite(t)) return undefined
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (s[mid].t < t) lo = mid + 1
      else hi = mid
    }
    let best = s[lo]
    if (lo > 0 && Math.abs(s[lo - 1].t - t) < Math.abs(best.t - t)) best = s[lo - 1]
    return Math.abs(best.t - t) <= this.maxSkewS ? best.w : undefined
  }
}

// Adapter for any (t, lat, lon) => radians lookup, e.g. a gridded wind model.
function functionWindSource(fn) {
  return { windFromAt: (t, lat, lon) => fn(t, lat, lon) }
}

function isWindShipType(shipTypeId, types = WIND_SHIP_TYPES) {
  return Number.isFinite(shipTypeId) && types.includes(shipTypeId)
}

/**
 * Attach windFrom (radians true) to the fixes where the hint applies: the
 * vessel reports no speed, or a speed in the GPS-artifact range. Returns a new
 * array; fixes that are not eligible are passed through unchanged.
 */
function annotateWind(fixes, source, { maxSogKnots = 0.5 } = {}) {
  if (!source) return fixes
  const maxSog = maxSogKnots * KNOT
  return fixes.map((f) => {
    if (Number.isFinite(f.sog) && f.sog > maxSog) return f
    const w = source.windFromAt(f.t, f.lat, f.lon)
    return Number.isFinite(w) ? { ...f, windFrom: normAngle(w) } : f
  })
}

/**
 * The heading-into-wind hint for one stationary episode.
 *
 * points: the episode's fixes [{ lat, lon, heading?, windFrom? }]
 * center: the placed anchor { latitude, longitude }, or null for an area-only result
 * o: { windWeight, windMinFixes }
 *
 * Returns null when the hint is off or there are fewer than windMinFixes wind samples, else
 *   upwindBearingDeg   circular mean of the wind direction (where it blew from)
 *   steadiness         1 for a constant wind direction, towards 0 for a shifting one
 *   windFixes          number of wind samples
 *   headingOffsetDeg   median |heading - wind| where both exist, or null
 *   anchorBearingDeg   likely direction of the anchor from the boat: weighted circular
 *                      mean of the bow headings (weight 1) and the wind (weight windWeight)
 *   windShare          the wind's share of the weight behind anchorBearingDeg
 *   anchorAgreement    with a center: mean cosine between the bearing boat -> anchor and
 *                      the wind direction (1 = anchor straight upwind, below 0 = downwind)
 *
 * The wind only ever contributes a bearing: mixing it into the ray intersection
 * moved anchors by tens of metres when the wind was biased (see docs/VALIDATION.md).
 */
function windHint(points, center, o = {}) {
  const ww = o.windWeight > 0 ? o.windWeight : 0
  if (ww === 0) return null
  const minFixes = o.windMinFixes ?? 20
  let ws = 0, wc = 0, n = 0
  let as = 0, ac = 0, hw = 0
  let agree = 0
  const offsets = []
  const proj = center ? makeProjection(center.latitude, center.longitude) : null
  for (const p of points) {
    if (Number.isFinite(p.heading)) {
      as += Math.sin(p.heading)
      ac += Math.cos(p.heading)
      hw += 1
    }
    if (!Number.isFinite(p.windFrom)) continue
    n++
    ws += Math.sin(p.windFrom)
    wc += Math.cos(p.windFrom)
    as += ww * Math.sin(p.windFrom)
    ac += ww * Math.cos(p.windFrom)
    if (Number.isFinite(p.heading)) offsets.push(angleDiff(p.heading, p.windFrom))
    if (proj) {
      const [x, y] = proj.toXY(p.lat, p.lon)
      if (Math.hypot(x, y) > 1) agree += Math.cos(Math.atan2(-x, -y) - p.windFrom)
      else agree += 1
    }
  }
  if (n < minFixes) return null
  offsets.sort((a, b) => a - b)
  const m = offsets.length >> 1
  const medOff = offsets.length === 0 ? null : offsets.length % 2 ? offsets[m] : (offsets[m - 1] + offsets[m]) / 2
  const deg = (r) => (normAngle(r) * 180) / Math.PI
  return {
    upwindBearingDeg: deg(Math.atan2(ws, wc)),
    steadiness: Math.min(1, Math.hypot(ws, wc) / n),
    windFixes: n,
    headingOffsetDeg: medOff == null ? null : (medOff * 180) / Math.PI,
    anchorBearingDeg: deg(Math.atan2(as, ac)),
    windShare: (ww * n) / (ww * n + hw),
    anchorAgreement: proj ? agree / n : null
  }
}

module.exports = {
  WIND_SHIP_TYPES,
  OwnVesselWind,
  functionWindSource,
  isWindShipType,
  annotateWind,
  windHint,
  angleDiff,
  normAngle
}
