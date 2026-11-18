'use strict'

const { makeProjection, median, percentile } = require('./geo')
const { windHint } = require('./wind')

const DEFAULTS = {
  // Episode detection
  radiusGateM: 250, // a stationary episode stays within this of its running centroid
  minDwellS: 2 * 3600,
  maxGapS: 30 * 60, // a reporting gap longer than this ends an episode
  minFixes: 6,
  spikeM: 100, // a fix that jumps this far away and back is a bad fix
  // Classification
  minSwingM: 8, // below this core spread the vessel is simply sitting still (berth, GPS jitter)
  minArcDeg: 150,
  maxSwingRadiusM: 350,
  minInlierFraction: 0.5,
  tightSwingM: 15, // fits with a smaller 95th percentile radius are tagged "possibly-moored"
  minRingRatio: 4, // fitted radius must span this many residual widths, else the track is a blob or a short arc
  // Heading based anchor location
  minHeadedFixes: 30,
  minAheadFraction: 0.85,
  maxMissFraction: 0.4,
  // Heading-into-wind hint (see wind.js). Weight of one wind sample relative to one
  // bow heading when estimating which way the anchor lies. The wind is a noisy pointer
  // (median 35 to 68 degrees off the heading in testing), so it is low by default;
  // 0 turns the hint off. It never places an anchor on its own.
  windWeight: 0.1,
  windMinFixes: 20, // wind samples needed before the hint is reported
  windDisagreeCos: 0 // tag 'wind-disagrees' when the anchor lies downwind of the boat on average
}

/**
 * Remove isolated GPS jumps: a fix that is far from both neighbours while the
 * neighbours are close to each other.
 * fixes: [{ t (seconds), lat, lon }] sorted by t.
 */
function removeSpikes(fixes, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  if (fixes.length < 3) return fixes.slice()
  const proj = makeProjection(fixes[0].lat, fixes[0].lon)
  const xy = fixes.map((f) => proj.toXY(f.lat, f.lon))
  const out = [fixes[0]]
  for (let i = 1; i < fixes.length - 1; i++) {
    const a = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])
    const b = Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1])
    const c = Math.hypot(xy[i + 1][0] - xy[i - 1][0], xy[i + 1][1] - xy[i - 1][1])
    if (a > o.spikeM && b > o.spikeM && c < 0.5 * Math.min(a, b)) continue
    out.push(fixes[i])
  }
  out.push(fixes[fixes.length - 1])
  return out
}

/**
 * Find stationary episodes: maximal runs of fixes that stay within radiusGateM
 * of their running centroid with no long reporting gap.
 * Returns [{ i0, i1, t0, t1, n, ongoing }] indexes into the (spike-filtered) array
 * that is also returned, so callers can slice the points.
 */
function findEpisodes(rawFixes, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const fixes = removeSpikes(rawFixes, o)
  const n = fixes.length
  if (n === 0) return { fixes, episodes: [] }
  const proj = makeProjection(fixes[0].lat, fixes[0].lon)
  const xy = fixes.map((f) => proj.toXY(f.lat, f.lon))
  const episodes = []
  let i = 0
  while (i < n) {
    let sx = xy[i][0]
    let sy = xy[i][1]
    let c = 1
    let j = i + 1
    while (
      j < n &&
      fixes[j].t - fixes[j - 1].t <= o.maxGapS &&
      Math.hypot(xy[j][0] - sx / c, xy[j][1] - sy / c) <= o.radiusGateM
    ) {
      sx += xy[j][0]
      sy += xy[j][1]
      c++
      j++
    }
    if (j - i >= o.minFixes && fixes[j - 1].t - fixes[i].t >= o.minDwellS) {
      episodes.push({ i0: i, i1: j, t0: fixes[i].t, t1: fixes[j - 1].t, n: j - i, ongoing: j === n })
      i = j
    } else {
      i++
    }
  }
  return { fixes, episodes }
}

// Algebraic (Kasa) circle fit. P: [[x, y], ...]. Returns { cx, cy, r } or null.
function fitCircle(P) {
  const n = P.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (const p of P) {
    mx += p[0]
    my += p[1]
  }
  mx /= n
  my /= n
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const p of P) {
    const u = p[0] - mx
    const v = p[1] - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const uc = ((suuu + suvv) * svv - (svvv + svuu) * suv) / (2 * det)
  const vc = ((svvv + svuu) * suu - (suuu + suvv) * suv) / (2 * det)
  return { cx: mx + uc, cy: my + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) }
}

// Angular coverage of the points around a centre, in degrees (360 minus the largest empty gap).
function arcCoverageDeg(P, cx, cy) {
  if (P.length < 2) return 0
  const a = P.map((p) => Math.atan2(p[1] - cy, p[0] - cx)).sort((x, y) => x - y)
  let maxGap = a[0] + 2 * Math.PI - a[a.length - 1]
  for (let i = 0; i < a.length - 1; i++) maxGap = Math.max(maxGap, a[i + 1] - a[i])
  return ((2 * Math.PI - maxGap) * 180) / Math.PI
}

/**
 * Fit an anchor swing circle to the fixes of one episode.
 * points: [{ lat, lon }] (any order). Returns null when too few points survive trimming.
 *
 * Steps: single-pass trim to the dense core (drops approach and departure
 * tails), robust Kasa fit with iterative residual trimming, then metrics.
 */
function fitEpisode(points) {
  const N = points.length
  if (N < 8) return null
  const proj = makeProjection(points[0].lat, points[0].lon)
  let K = points.map((p) => proj.toXY(p.lat, p.lon))

  // Dense-core trim. One pass only: iterating collapses a ring onto its densest arc.
  const mdx = median(K.map((p) => p[0]))
  const mdy = median(K.map((p) => p[1]))
  const d = K.map((p) => Math.hypot(p[0] - mdx, p[1] - mdy))
  const lim = Math.max(12, 2.2 * median(d))
  const core = K.filter((_, i) => d[i] <= lim)
  if (core.length >= 8) K = core

  let sx = 0
  let sy = 0
  for (const p of K) {
    sx += p[0]
    sy += p[1]
  }
  const cmx = sx / K.length
  const cmy = sy / K.length
  const coreSpreadM = percentile(K.map((p) => Math.hypot(p[0] - cmx, p[1] - cmy)), 0.95)
  const area = areaEllipse(K, cmx, cmy, proj)

  let f = fitCircle(K)
  if (!f) return { coreSpreadM, area, fitted: false, inlierFraction: K.length / N, center: proj.toLatLon(cmx, cmy) }
  const resid = (pts, c) => pts.map((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r))
  for (let it = 0; it < 3; it++) {
    const res = resid(K, f)
    const cut = Math.max(6, 2.5 * 1.4826 * median(res))
    const K3 = K.filter((_, i) => res[i] <= cut)
    if (K3.length < 8) break
    K = K3
    f = fitCircle(K) || f
  }
  const res = resid(K, f)
  const rms = Math.sqrt(res.reduce((s, e) => s + e * e, 0) / res.length)
  const r95 = percentile(K.map((p) => Math.hypot(p[0] - f.cx, p[1] - f.cy)), 0.95)

  // Split-half stability of the anchor estimate, in metres (smaller is steadier).
  let stabilityM = null
  const h = K.length >> 1
  const fa = fitCircle(K.slice(0, h))
  const fb = fitCircle(K.slice(h))
  if (fa && fb) stabilityM = Math.hypot(fa.cx - fb.cx, fa.cy - fb.cy)

  return {
    fitted: true,
    center: proj.toLatLon(f.cx, f.cy),
    radiusM: f.r,
    swingRadiusM: r95, // 95th percentile distance from the fitted centre
    rmsM: rms,
    ringRatio: f.r / Math.max(rms, 0.5), // how many residual-widths the radius spans; a blob scores low
    arcDeg: arcCoverageDeg(K, f.cx, f.cy),
    inlierFraction: K.length / N,
    coreSpreadM,
    area,
    stabilityM
  }
}

/**
 * 95% covariance ellipse of the points: the area the vessel actually occupied.
 * Used when the shape is not a ring. Orientation is the major axis bearing in
 * degrees clockwise from north.
 */
function areaEllipse(K, cmx, cmy, proj) {
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of K) {
    const dx = p[0] - cmx
    const dy = p[1] - cmy
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  const n = K.length
  sxx /= n
  syy /= n
  sxy /= n
  const tr = sxx + syy
  const disc = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy))
  const l1 = tr / 2 + disc
  const l2 = Math.max(0, tr / 2 - disc)
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy) // major axis angle from +x (east), counter-clockwise
  const bearing = (((90 - (theta * 180) / Math.PI) % 180) + 180) % 180
  const k = Math.sqrt(5.991) // 95% for a 2-D Gaussian
  return {
    center: proj.toLatLon(cmx, cmy),
    semiMajorM: k * Math.sqrt(l1),
    semiMinorM: k * Math.sqrt(l2),
    bearingDeg: bearing
  }
}

/**
 * Locate the anchor from bow headings. A vessel riding to its anchor points its
 * bow at it, so the lines along the headings meet at the anchor. This works for
 * narrow swing sectors where the track shape alone cannot fix a circle.
 * points: [{ lat, lon, heading }] with heading in radians true. Returns null when
 * there are too few headed fixes or the rays do not meet convincingly.
 */
function anchorFromHeadings(points, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  let hp = points.filter((p) => Number.isFinite(p.heading))
  if (hp.length < o.minHeadedFixes) return null
  const proj = makeProjection(hp[0].lat, hp[0].lon)
  let xy = hp.map((p) => proj.toXY(p.lat, p.lon))
  // Drop approach and departure fixes: keep the dense core around the median position.
  const mx = median(xy.map((q) => q[0]))
  const my = median(xy.map((q) => q[1]))
  const dm = xy.map((q) => Math.hypot(q[0] - mx, q[1] - my))
  const lim = Math.max(40, 2.2 * median(dm))
  const keep = dm.map((d) => d <= lim)
  hp = hp.filter((_, i) => keep[i])
  xy = xy.filter((_, i) => keep[i])
  if (hp.length < o.minHeadedFixes) return null
  // Headings must vary a little, otherwise the rays are parallel (alongside a berth).
  let hs = 0
  let hc = 0
  for (const p of hp) {
    hs += Math.sin(p.heading)
    hc += Math.cos(p.heading)
  }
  const resultant = Math.hypot(hs, hc) / hp.length
  if (resultant > 0.9986) return null // under about 3 degrees of heading spread

  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < hp.length; i++) {
    const nx = Math.cos(hp[i].heading) // normal to the heading direction (sin h, cos h)
    const ny = -Math.sin(hp[i].heading)
    const d = nx * xy[i][0] + ny * xy[i][1]
    a11 += nx * nx
    a12 += nx * ny
    a22 += ny * ny
    b1 += d * nx
    b2 += d * ny
  }
  const det = a11 * a22 - a12 * a12
  if (Math.abs(det) < 1e-6) return null
  const cx = (a22 * b1 - a12 * b2) / det
  const cy = (a11 * b2 - a12 * b1) / det

  const dist = []
  const miss = []
  let ahead = 0
  for (let i = 0; i < hp.length; i++) {
    const vx = cx - xy[i][0]
    const vy = cy - xy[i][1]
    dist.push(Math.hypot(vx, vy))
    miss.push(Math.abs(vx * Math.cos(hp[i].heading) - vy * Math.sin(hp[i].heading)))
    if (vx * Math.sin(hp[i].heading) + vy * Math.cos(hp[i].heading) > 0) ahead++
  }
  const distM = median(dist)
  const missM = median(miss)
  const aheadFraction = ahead / hp.length
  const ok = aheadFraction >= o.minAheadFraction && missM <= o.maxMissFraction * distM && distM >= 10 && distM <= o.maxSwingRadiusM
  if (o.debug) o.debug({ aheadFraction, missM, distM, headed: hp.length, resultant })
  if (!ok) return null
  return {
    center: proj.toLatLon(cx, cy),
    distM,
    dist95M: percentile(dist, 0.95),
    missM,
    aheadFraction,
    headedFixes: hp.length
  }
}

/**
 * Turn a circle fit (and, when available, a heading based anchor) into a verdict.
 *
 * verdict
 *   'still'        no swing: sitting at a berth, or fix jitter
 *   'anchor'       an anchor position and swing radius could be resolved
 *   'anchor-area'  long stationary and swinging, but the anchor cannot be placed from
 *                  the track alone (blob, or a short arc of a large circle); only the
 *                  occupied area is reported
 *   'other'        reserved
 * method (for 'anchor'): 'heading' (bow headings meet at the anchor) or 'ring-fit'
 * quality: 'strong' for a clean fit, 'weak' for a plausible but noisier one
 * tags: ['possibly-moored'] for swings tighter than opts.tightSwingM,
 *       ['wind-disagrees'] when the placed anchor lies downwind of the boat
 * hint (from analyzeTrack): the wind summary and, for 'anchor-area', anchorBearingDeg,
 *       the likely direction of the anchor from the area centre
 */
function classify(fit, heading, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  if (!fit || fit.coreSpreadM < o.minSwingM) return { verdict: 'still', quality: null, tags: [] }

  if (heading) {
    const tags = heading.dist95M < o.tightSwingM ? ['possibly-moored'] : []
    return {
      verdict: 'anchor',
      method: 'heading',
      quality: heading.missM <= 0.15 * heading.distM ? 'strong' : 'weak',
      tags,
      center: heading.center,
      swingRadiusM: heading.dist95M
    }
  }

  if (
    fit.fitted &&
    fit.arcDeg >= o.minArcDeg &&
    fit.swingRadiusM <= o.maxSwingRadiusM &&
    fit.inlierFraction >= o.minInlierFraction &&
    fit.ringRatio >= o.minRingRatio
  ) {
    const tags = fit.swingRadiusM < o.tightSwingM ? ['possibly-moored'] : []
    return {
      verdict: 'anchor',
      method: 'ring-fit',
      quality: fit.ringRatio >= 6 ? 'strong' : 'weak',
      tags,
      center: fit.center,
      swingRadiusM: fit.swingRadiusM
    }
  }

  const tags = fit.coreSpreadM < o.tightSwingM ? ['possibly-moored'] : []
  return { verdict: 'anchor-area', quality: null, tags, area: fit.area }
}

/**
 * Analyse one vessel's track. Returns one entry per stationary episode:
 * { t0, t1, ongoing, centroid, verdict, method, quality, tags, center, swingRadiusM, area, fit, heading }
 * Fixes may carry an optional `heading` (radians true) for the heading based method,
 * and an optional `windFrom` (radians true, see wind.js) for the heading-into-wind hint.
 */
function analyzeTrack(fixes, opts = {}) {
  const { fixes: clean, episodes } = findEpisodes(fixes, opts)
  return episodes.map((e) => {
    const pts = clean.slice(e.i0, e.i1)
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length
    const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length
    const fit = fitEpisode(pts.map((p) => ({ lat: p.lat, lon: p.lon })))
    const heading = anchorFromHeadings(pts, opts)
    const cls = classify(fit, heading, opts)
    const center = cls.verdict === 'anchor' ? cls.center : cls.verdict === 'anchor-area' ? null : undefined
    const hint = center === undefined ? null : windHint(pts, center, { ...DEFAULTS, ...opts })
    if (hint && cls.verdict === 'anchor' && hint.anchorAgreement != null && hint.anchorAgreement < (opts.windDisagreeCos ?? DEFAULTS.windDisagreeCos)) {
      cls.tags = cls.tags.concat('wind-disagrees')
    }
    return {
      t0: e.t0,
      t1: e.t1,
      ongoing: e.ongoing,
      centroid: { latitude: lat, longitude: lon },
      ...cls,
      fit,
      heading,
      hint
    }
  })
}

module.exports = {
  DEFAULTS,
  removeSpikes,
  findEpisodes,
  fitCircle,
  arcCoverageDeg,
  fitEpisode,
  anchorFromHeadings,
  classify,
  analyzeTrack
}
