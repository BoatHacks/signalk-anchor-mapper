'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { OwnVesselWind, functionWindSource, isWindShipType, annotateWind, windHint, angleDiff } = require('../src/wind')

const DEG = Math.PI / 180

test('own vessel wind: nearest sample within the time skew', () => {
  const w = new OwnVesselWind({ maxSkewS: 600, minIntervalS: 30 })
  w.handleValue('environment.wind.directionTrue', 10 * DEG, 1000)
  w.handleValue('environment.wind.directionTrue', 99 * DEG, 1010) // thinned away
  w.handleValue('environment.wind.directionTrue', 30 * DEG, 2000)
  assert.ok(Math.abs(w.windFromAt(1200) - 10 * DEG) < 1e-9)
  assert.ok(Math.abs(w.windFromAt(1800) - 30 * DEG) < 1e-9)
  assert.strictEqual(w.windFromAt(3000), undefined)
  assert.strictEqual(w.windFromAt(0), undefined)
  w.prune(1500 + 12 * 3600)
  assert.strictEqual(w.series.length, 1)
})

test('own vessel wind: derived from true wind angle and heading when no direction is sent', () => {
  const w = new OwnVesselWind()
  w.handleValue('navigation.headingTrue', 350 * DEG, 100)
  w.handleValue('environment.wind.angleTrueWater', 20 * DEG, 110)
  assert.ok(angleDiff(w.windFromAt(110), 10 * DEG) < 1e-9)
  // stale heading: ignored
  w.handleValue('environment.wind.angleTrueWater', 20 * DEG, 500)
  assert.strictEqual(w.series.length, 1)
  // directionTrue wins over derived values while it keeps arriving
  w.handleValue('environment.wind.directionTrue', 200 * DEG, 1000)
  w.handleValue('navigation.headingTrue', 0, 1040)
  w.handleValue('environment.wind.angleTrueGround', 90 * DEG, 1040)
  assert.strictEqual(w.series.length, 2)
})

test('wind hint only for sailing and pleasure craft', () => {
  assert.ok(isWindShipType(36))
  assert.ok(isWindShipType(37))
  assert.ok(!isWindShipType(70))
  assert.ok(!isWindShipType(undefined))
})

test('annotateWind skips fixes moving faster than the GPS-artifact range', () => {
  const src = functionWindSource(() => 2 * Math.PI + 0.5)
  const fixes = [
    { t: 0, lat: 0, lon: 0 }, // no speed reported: used
    { t: 30, lat: 0, lon: 0, sog: 0.1 }, // artifact: used
    { t: 60, lat: 0, lon: 0, sog: 2.5 } // under way: not used
  ]
  const out = annotateWind(fixes, src, { maxSogKnots: 0.5 })
  assert.ok(Math.abs(out[0].windFrom - 0.5) < 1e-9)
  assert.ok(Math.abs(out[1].windFrom - 0.5) < 1e-9)
  assert.strictEqual(out[2].windFrom, undefined)
  assert.strictEqual(fixes[0].windFrom, undefined, 'input not modified')
  assert.strictEqual(annotateWind(fixes, null), fixes)
})

test('windHint: circular mean across north, heading offset, weighted bearing', () => {
  const pts = []
  for (let i = 0; i < 30; i++) {
    pts.push({ lat: 0, lon: 0, windFrom: (i % 3 === 0 ? 350 : i % 3 === 1 ? 10 : 0) * DEG, heading: 20 * DEG })
  }
  const h = windHint(pts, null, { windWeight: 0.1, windMinFixes: 20 })
  assert.ok(angleDiff(h.upwindBearingDeg * DEG, 0) < 1e-6)
  assert.strictEqual(h.windFixes, 30)
  assert.ok(Math.abs(h.headingOffsetDeg - 20) < 1e-6)
  assert.ok(Math.abs(h.windShare - 3 / 33) < 1e-9)
  assert.ok(h.anchorBearingDeg > 17 && h.anchorBearingDeg < 20, `bearing ${h.anchorBearingDeg}`)
  assert.strictEqual(windHint(pts, null, { windWeight: 0 }), null)
  assert.strictEqual(windHint(pts.slice(0, 5), null, { windWeight: 0.1, windMinFixes: 20 }), null)
})

test('windHint: anchor agreement is +1 straight upwind and -1 straight downwind', () => {
  // Boat 100 m south of the anchor, wind from north: anchor is upwind.
  const pts = Array.from({ length: 25 }, () => ({ lat: -0.0009, lon: 0, windFrom: 0 }))
  const anchor = { latitude: 0, longitude: 0 }
  assert.ok(windHint(pts, anchor, { windWeight: 0.1 }).anchorAgreement > 0.999)
  const south = pts.map((p) => ({ ...p, windFrom: Math.PI }))
  assert.ok(windHint(south, anchor, { windWeight: 0.1 }).anchorAgreement < -0.999)
})
