'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { analyzeTrack, findEpisodes, removeSpikes } = require('../src/detector')
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
function sectorTrack({ rode = 120, hours = 8, sectorDeg = 50, noiseM = 6, withHeading = true, stepS = 30, seed = 4 }) {
  const rand = rng(seed)
  const n = Math.floor((hours * 3600) / stepS)
  const out = []
  for (let i = 0; i < n; i++) {
    const b = ((200 + (sectorDeg / 2) * Math.sin((2 * Math.PI * i) / n * 1.5)) * Math.PI) / 180 // bearing anchor -> ship
    const p = proj.toLatLon(rode * Math.sin(b) + gauss(rand) * noiseM, rode * Math.cos(b) + gauss(rand) * noiseM)
    const fix = { t: i * stepS, lat: p.latitude, lon: p.longitude }
    if (withHeading) fix.heading = b + Math.PI + (gauss(rand) * 3 * Math.PI) / 180 // bow towards the anchor
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

// Class B GPS jitter at a berth or on land: a blob of 9 to 12 m with no heading at all.
function jitterBlob({ hours = 6, noiseM = 5, stepS = 180, seed = 11, heading = false }) {
  const rand = rng(seed)
  const out = []
  for (let i = 0; i < (hours * 3600) / stepS; i++) {
    const p = proj.toLatLon(gauss(rand) * noiseM, gauss(rand) * noiseM)
    const fix = { t: i * stepS, lat: p.latitude, lon: p.longitude }
    if (heading) fix.heading = rand() * 2 * Math.PI
    out.push(fix)
  }
  return out
}

test('class B jitter blob above the still cutoff, without heading, is still', () => {
  const e = analyzeTrack(jitterBlob({}))[0]
  assert.ok(e.fit.coreSpreadM >= 8, `core spread ${e.fit.coreSpreadM} must pass the 8 m gate`)
  assert.strictEqual(e.verdict, 'still')
})

test('the same blob from a vessel that sends headings keeps its area estimate', () => {
  const e = analyzeTrack(jitterBlob({ heading: true }))[0]
  assert.strictEqual(e.verdict, 'anchor-area')
})

test('a large area without heading is kept', () => {
  const e = analyzeTrack(jitterBlob({ noiseM: 15 }))[0]
  assert.ok(e.area.semiMajorM > 25)
  assert.strictEqual(e.verdict, 'anchor-area')
})

// Caneel Bay (USVI) class B yachts: a dense cluster on the west side most of the
// time, with a sparse tail now and then up to about 25 m east. The shape must hold
// the eastern fixes too, not just the dense part.
function lopsidedStay({ hours = 26, stepS = 300, seed = 21, ring = 0 }) {
  const rand = rng(seed)
  const out = []
  const n = (hours * 3600) / stepS
  for (let i = 0; i < n; i++) {
    let x, y
    if (i % 12 === 5 || i % 12 === 6) {
      x = 8 + rand() * 17 // the eastern tail
      y = gauss(rand) * 3
    } else if (ring) {
      const a = Math.PI / 2 + (rand() - 0.5) * 2.4 // swinging round the western half
      x = ring * Math.cos(a) - ring + 4
      y = ring * Math.sin(a)
    } else {
      x = -6 + gauss(rand) * 4
      y = gauss(rand) * 3
    }
    const p = proj.toLatLon(x, y)
    // A few random headings so the 80236c6 jitter rule (no heading, small area) leaves it alone.
    out.push({ t: i * stepS, lat: p.latitude, lon: p.longitude, heading: i % 20 === 0 ? rand() * 2 * Math.PI : undefined })
  }
  return out
}

function insideEllipse(fix, area) {
  const P = makeProjection(area.center.latitude, area.center.longitude)
  const [x, y] = P.toXY(fix.lat, fix.lon)
  const b = ((90 - area.bearingDeg) * Math.PI) / 180 // major axis from +x
  const u = x * Math.cos(b) + y * Math.sin(b)
  const v = -x * Math.sin(b) + y * Math.cos(b)
  return (u / area.semiMajorM) ** 2 + (v / area.semiMinorM) ** 2 <= 1 + 1e-6
}

test('an area estimate holds every fix of the stay, not just the dense side', () => {
  const track = lopsidedStay({})
  const e = analyzeTrack(track)[0]
  assert.strictEqual(e.verdict, 'anchor-area')
  const out = track.filter((f) => !insideEllipse(f, e.area))
  assert.strictEqual(out.length, 0, `${out.length} fixes outside the area`)
  assert.ok(e.coreArea.semiMajorM < e.area.semiMajorM)
})

test('a swing radius holds every fix of the stay', () => {
  for (const e of [analyzeTrack(ringTrack({ r: 30, hours: 8 }))[0], analyzeTrack(sectorTrack({}))[0]]) {
    assert.strictEqual(e.verdict, 'anchor')
    const P = makeProjection(e.center.latitude, e.center.longitude)
    const track = e.method === 'heading' ? sectorTrack({}) : ringTrack({ r: 30, hours: 8 })
    const far = Math.max(...track.map((f) => Math.hypot(...P.toXY(f.lat, f.lon))))
    assert.ok(e.swingRadiusM >= far - 1e-6, `radius ${e.swingRadiusM} < farthest fix ${far}`)
    assert.ok(e.swingRadiusM >= e.coreRadiusM)
  }
})

test('the approach is not counted in the covering radius', () => {
  // Motoring in at 1.5 kn and dropping the hook at the anchor spot.
  const approach = []
  for (let i = 0; i < 40; i++) {
    const p = proj.toLatLon(920 - (i + 1) * 23, 0)
    approach.push({ t: i * 30, lat: p.latitude, lon: p.longitude })
  }
  const e = analyzeTrack([...approach, ...ringTrack({ r: 30, hours: 8, t0: 1200 })]).find((x) => x.verdict === 'anchor')
  assert.ok(e && e.swingRadiusM < 50, `radius ${e && e.swingRadiusM}`)
})
