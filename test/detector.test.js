'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { analyzeTrack, findEpisodes, removeSpikes, anchorFromHeadings } = require('../src/detector')
const { makeProjection, distanceM } = require('../src/geo')

// Deterministic noise so tests never flake.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
}

const LAT0 = 40.6
const LON0 = 0.6
const proj = makeProjection(LAT0, LON0)

// Vessel swinging on a rode: bearing sweeps through sweepDeg while the radius stays ~r.
function ringTrack({ r, hours, sweepDeg = 300, noiseM = 3, stepS = 30, seed = 1, t0 = 0 }) {
  const rand = rng(seed)
  const n = Math.floor((hours * 3600) / stepS)
  const out = []
  for (let i = 0; i < n; i++) {
    const a = ((i / n) * sweepDeg * Math.PI) / 180
    const x = r * Math.cos(a) + gauss(rand) * noiseM
    const y = r * Math.sin(a) + gauss(rand) * noiseM
    const p = proj.toLatLon(x, y)
    out.push({ t: t0 + i * stepS, lat: p.latitude, lon: p.longitude })
  }
  return out
}

function berthTrack({ hours, noiseM = 2, stepS = 30, seed = 2 }) {
  const rand = rng(seed)
  const n = Math.floor((hours * 3600) / stepS)
  const out = []
  for (let i = 0; i < n; i++) {
    const p = proj.toLatLon(gauss(rand) * noiseM, gauss(rand) * noiseM)
    out.push({ t: i * stepS, lat: p.latitude, lon: p.longitude })
  }
  return out
}

function transitTrack({ hours, knots = 8, stepS = 30 }) {
  const n = Math.floor((hours * 3600) / stepS)
  const mps = knots * 0.514444
  const out = []
  for (let i = 0; i < n; i++) {
    const p = proj.toLatLon(i * stepS * mps, 0)
    out.push({ t: i * stepS, lat: p.latitude, lon: p.longitude })
  }
  return out
}

test('swinging vessel is detected as an anchor with the right centre and radius', () => {
  const eps = analyzeTrack(ringTrack({ r: 60, hours: 4 }))
  assert.strictEqual(eps.length, 1)
  const e = eps[0]
  assert.strictEqual(e.verdict, 'anchor')
  assert.deepStrictEqual(e.tags, [])
  assert.ok(distanceM(e.fit.center, { latitude: LAT0, longitude: LON0 }) < 8, 'centre within 8 m')
  assert.ok(Math.abs(e.fit.radiusM - 60) < 8, `radius ${e.fit.radiusM}`)
  assert.ok(e.fit.arcDeg > 250)
  assert.ok(e.ongoing)
})

test('large swing (cargo ship scale) is detected', () => {
  const e = analyzeTrack(ringTrack({ r: 150, hours: 12, noiseM: 6, stepS: 60 }))[0]
  assert.strictEqual(e.verdict, 'anchor')
  assert.ok(Math.abs(e.fit.radiusM - 150) < 20)
})

test('vessel sitting at a berth is "still", not an anchor', () => {
  const eps = analyzeTrack(berthTrack({ hours: 6 }))
  assert.strictEqual(eps.length, 1)
  assert.strictEqual(eps[0].verdict, 'still')
})

test('a tight swing is an anchor tagged possibly-moored', () => {
  const e = analyzeTrack(ringTrack({ r: 10, hours: 6, noiseM: 0.8 }))[0]
  assert.strictEqual(e.verdict, 'anchor')
  assert.deepStrictEqual(e.tags, ['possibly-moored'])
})

test('a vessel under way produces no stationary episode', () => {
  assert.strictEqual(findEpisodes(transitTrack({ hours: 4 })).episodes.length, 0)
})

test('too short a stay is not reported', () => {
  assert.strictEqual(analyzeTrack(ringTrack({ r: 60, hours: 1 })).length, 0)
  assert.strictEqual(analyzeTrack(ringTrack({ r: 60, hours: 1 }), { minDwellS: 1800 }).length, 1)
})

test('a single GPS spike does not split the episode', () => {
  const track = ringTrack({ r: 60, hours: 4 })
  const bad = proj.toLatLon(900, 900)
  track[100] = { t: track[100].t, lat: bad.latitude, lon: bad.longitude }
  assert.strictEqual(removeSpikes(track).length, track.length - 1)
  const eps = analyzeTrack(track)
  assert.strictEqual(eps.length, 1)
  assert.strictEqual(eps[0].verdict, 'anchor')
})

test('a long reporting gap ends the episode', () => {
  const a = ringTrack({ r: 60, hours: 3 })
  const b = ringTrack({ r: 60, hours: 3, t0: 3 * 3600 + 2 * 3600, seed: 9 })
  assert.strictEqual(analyzeTrack(a.concat(b)).length, 2)
})

test('approach track before anchoring is trimmed away from the fit', () => {
  const approach = []
  for (let i = 0; i < 30; i++) {
    const p = proj.toLatLon(-600 + i * 10, 0)
    approach.push({ t: i * 30, lat: p.latitude, lon: p.longitude })
  }
  const ring = ringTrack({ r: 60, hours: 4, t0: 30 * 30 })
  const eps = analyzeTrack(approach.concat(ring))
  const e = eps[eps.length - 1]
  assert.strictEqual(e.verdict, 'anchor')
  assert.ok(Math.abs(e.fit.radiusM - 60) < 12, `radius ${e.fit.radiusM}`)
})

// A vessel lying to its anchor in steady wind: the bow points at the anchor and the
// track is a short arc of a large circle (the common real-world case).
function sectorTrack({ rode = 120, hours = 8, sectorDeg = 50, noiseM = 6, withHeading = true, stepS = 30, seed = 4, wind = null }) {
  const rand = rng(seed)
  const n = Math.floor((hours * 3600) / stepS)
  const out = []
  for (let i = 0; i < n; i++) {
    const b = ((200 + (sectorDeg / 2) * Math.sin((2 * Math.PI * i) / n * 1.5)) * Math.PI) / 180 // bearing anchor -> ship
    const p = proj.toLatLon(rode * Math.sin(b) + gauss(rand) * noiseM, rode * Math.cos(b) + gauss(rand) * noiseM)
    const fix = { t: i * stepS, lat: p.latitude, lon: p.longitude }
    if (withHeading) fix.heading = b + Math.PI + (gauss(rand) * 3 * Math.PI) / 180 // bow towards the anchor
    // Wind from roughly where the anchor is, with a bias and scatter in degrees.
    if (wind) fix.windFrom = b + Math.PI + (((wind.biasDeg || 0) + gauss(rand) * (wind.noiseDeg || 0)) * Math.PI) / 180
    out.push(fix)
  }
  return out
}

test('narrow swing sector with headings: anchor located from the bow direction', () => {
  const e = analyzeTrack(sectorTrack({}))[0]
  assert.strictEqual(e.verdict, 'anchor')
  assert.strictEqual(e.method, 'heading')
  assert.ok(distanceM(e.center, { latitude: LAT0, longitude: LON0 }) < 20, 'anchor within 20 m')
  assert.ok(Math.abs(e.swingRadiusM - 120) < 20, `radius ${e.swingRadiusM}`)
})

test('narrow swing sector without headings: occupied area only, no invented anchor', () => {
  const e = analyzeTrack(sectorTrack({ withHeading: false }))[0]
  assert.strictEqual(e.verdict, 'anchor-area')
  assert.strictEqual(e.center, undefined)
  assert.ok(e.area.semiMajorM > 30 && e.area.semiMajorM < 200, `semi-major ${e.area.semiMajorM}`)
  assert.ok(e.area.semiMinorM < e.area.semiMajorM)
})

test('constant heading with a small wobble (alongside a berth) is not mistaken for an anchor swing', () => {
  const rand = rng(7)
  const track = []
  for (let i = 0; i < 6 * 120; i++) {
    const p = proj.toLatLon(gauss(rand) * 2, gauss(rand) * 2)
    track.push({ t: i * 30, lat: p.latitude, lon: p.longitude, heading: 1.2 + gauss(rand) * 0.005 })
  }
  assert.strictEqual(analyzeTrack(track)[0].verdict, 'still')
})

// Heading-into-wind hint. See src/wind.js.

const ANCHOR = { latitude: LAT0, longitude: LON0 }
const stripWind = (track) => track.map(({ windFrom, ...f }) => f)

test('area only, no headings: the wind gives the side the anchor is on', () => {
  // Anchor at the origin, boat swinging around bearing 200 from it, so the anchor lies at ~20 from the boat.
  const e = analyzeTrack(sectorTrack({ withHeading: false, wind: { noiseDeg: 35 } }))[0]
  assert.strictEqual(e.verdict, 'anchor-area')
  assert.ok(Math.abs(e.hint.anchorBearingDeg - 20) < 10, `bearing ${e.hint.anchorBearingDeg}`)
  assert.strictEqual(e.hint.windShare, 1)
  assert.strictEqual(e.hint.anchorAgreement, null)
})

test('the wind never places an anchor: same verdict and centre with or without it', () => {
  for (const withHeading of [true, false]) {
    const track = sectorTrack({ withHeading, wind: { biasDeg: 65, noiseDeg: 35 } })
    const a = analyzeTrack(track)[0]
    const b = analyzeTrack(stripWind(track))[0]
    assert.strictEqual(a.verdict, b.verdict)
    assert.deepStrictEqual(a.center, b.center)
  }
})

test('with headings the bearing hint follows the bow; a biased wind tilts it by at most its share', () => {
  // Headings that do not vary enough for the ray method (steady wind): area only.
  const track = sectorTrack({ sectorDeg: 2, noiseM: 12, wind: { biasDeg: 65, noiseDeg: 35 } })
  const e = analyzeTrack(track)[0]
  assert.notStrictEqual(e.method, 'heading', 'rays too parallel for the heading method')
  assert.ok(e.hint.windShare > 0.05 && e.hint.windShare < 0.15, `share ${e.hint.windShare}`)
  const off = Math.abs(e.hint.anchorBearingDeg - 20)
  assert.ok(off < 65 * e.hint.windShare + 3, `bearing ${e.hint.anchorBearingDeg}`)
  assert.ok(Math.abs(e.hint.headingOffsetDeg - 65) < 15, `offset ${e.hint.headingOffsetDeg}`)
})

test('the wind weight is configurable: higher weight pulls the bearing towards the wind', () => {
  const track = sectorTrack({ wind: { biasDeg: 60, noiseDeg: 5 } })
  const lo = analyzeTrack(track, { windWeight: 0.1 })[0].hint
  const hi = analyzeTrack(track, { windWeight: 1 })[0].hint
  assert.ok(hi.windShare > lo.windShare)
  assert.ok(Math.abs(hi.anchorBearingDeg - 20) > Math.abs(lo.anchorBearingDeg - 20) + 15)
})

test('a placed anchor upwind of the boat agrees with the wind; one downwind is tagged', () => {
  const good = analyzeTrack(sectorTrack({ wind: { noiseDeg: 20 } }))[0]
  assert.strictEqual(good.verdict, 'anchor')
  assert.ok(good.hint.anchorAgreement > 0.7, `agreement ${good.hint.anchorAgreement}`)
  assert.ok(!good.tags.includes('wind-disagrees'))
  const bad = analyzeTrack(sectorTrack({ wind: { biasDeg: 180, noiseDeg: 20 } }))[0]
  assert.strictEqual(bad.verdict, 'anchor')
  assert.ok(bad.hint.anchorAgreement < 0)
  assert.ok(bad.tags.includes('wind-disagrees'))
})

test('windWeight 0 or too few wind samples: no hint', () => {
  const track = sectorTrack({ wind: { noiseDeg: 10 } })
  assert.strictEqual(analyzeTrack(track, { windWeight: 0 })[0].hint, null)
  const few = track.map((f, i) => (i < 10 ? f : { ...f, windFrom: undefined }))
  assert.strictEqual(analyzeTrack(few)[0].hint, null)
  assert.strictEqual(analyzeTrack(stripWind(track))[0].hint, null)
})
