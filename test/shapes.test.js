'use strict'

const test = require('node:test')
const assert = require('node:assert')
const S = require('../public/shapes')
const { distanceM, makeProjection } = require('../src/geo')

const C = [0.6, 40.6] // [lon, lat]
const at = (pt) => ({ latitude: pt[1], longitude: pt[0] })

function feature(id, props, center) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: center || C },
    properties: Object.assign({ mmsi: id, kind: 'anchor', quality: 'strong', tags: [], radiusMeters: 50 }, props)
  }
}

test('circle polygon is closed and every vertex lies on the radius', () => {
  for (const lat of [0, 40.6, 65]) {
    const center = [10, lat]
    const ring = S.circlePolygon(center, 70)
    assert.strictEqual(ring.length, 65)
    assert.deepStrictEqual(ring[0], ring[ring.length - 1])
    for (const v of ring) {
      const d = distanceM(at(center), at(v))
      assert.ok(Math.abs(d - 70) / 70 < 0.005, `lat ${lat}: vertex at ${d} m`)
    }
  }
})

test('ellipse axes and bearing: major axis north, then east', () => {
  const proj = makeProjection(C[1], C[0])
  const north = S.ellipsePolygon(C, 120, 40, 0, 4) // t = 0, 90, 180, 270 deg
  let [x, y] = proj.toXY(north[0][1], north[0][0])
  assert.ok(Math.abs(x) < 0.01 && Math.abs(y - 120) < 0.01, `major axis north: ${x}, ${y}`)
  ;[x, y] = proj.toXY(north[1][1], north[1][0])
  assert.ok(Math.abs(x - 40) < 0.01 && Math.abs(y) < 0.01, `minor axis east: ${x}, ${y}`)

  const east = S.ellipsePolygon(C, 120, 40, 90, 4)
  ;[x, y] = proj.toXY(east[0][1], east[0][0])
  assert.ok(Math.abs(x - 120) < 0.01 && Math.abs(y) < 0.01, `major axis east: ${x}, ${y}`)
  ;[x, y] = proj.toXY(east[1][1], east[1][0])
  assert.ok(Math.abs(x) < 0.01 && Math.abs(y + 40) < 0.01, `minor axis south: ${x}, ${y}`)
})

test('anchor estimate gives a polygon and an anchor point with a radius label', () => {
  const fc = S.toOverlayFeatures({ 123: feature('123', { name: 'Blue Moon', radiusMeters: 45 }) })
  assert.strictEqual(fc.type, 'FeatureCollection')
  assert.deepStrictEqual(fc.features.map((f) => f.id), ['123:shape', '123:anchor'])
  const [shape, anchor] = fc.features
  assert.strictEqual(shape.geometry.type, 'Polygon')
  assert.strictEqual(anchor.geometry.type, 'Point')
  assert.deepStrictEqual(anchor.geometry.coordinates, C)
  assert.strictEqual(shape.properties.part, 'shape')
  assert.strictEqual(anchor.properties.part, 'anchor')
  assert.strictEqual(anchor.properties.label, 'Blue Moon\nr 45 m')
  assert.strictEqual(anchor.properties.radiusMeters, 45)
  assert.strictEqual(anchor.properties.style, 'normal')
})

test('area estimate gives an ellipse polygon and no radius', () => {
  const f = feature('222', { kind: 'area', radiusMeters: undefined, area: { semiMajorM: 120, semiMinorM: 60, bearingDeg: 30 } })
  const [shape, anchor] = S.toOverlayFeatures([f]).features
  assert.strictEqual(shape.geometry.type, 'Polygon')
  assert.strictEqual(shape.properties.kind, 'area')
  assert.ok(!('radiusMeters' in shape.properties))
  assert.strictEqual(anchor.properties.label, '222\narea 120 x 60 m')
})

test('style per tag and alert combination', () => {
  const s = (tags, alerts) => S.styleOf({ tags, alerts })
  assert.strictEqual(s([]), 'normal')
  assert.strictEqual(s(['possibly-moored']), 'moored')
  assert.strictEqual(s(['possible-mooring-buoy']), 'buoy')
  assert.strictEqual(s(['possibly-moored', 'possible-mooring-buoy']), 'buoy', 'buoy beats moored')
  assert.strictEqual(s(['possible-mooring-buoy'], ['overlap']), 'overlap')
  assert.strictEqual(s([], ['overlap', 'dragging']), 'dragging')
  assert.strictEqual(S.styleOf({}), 'normal')
  assert.strictEqual(S.colorFor({ tags: ['possibly-moored'] }), S.DAY.moored)
  assert.strictEqual(S.colorFor({ tags: [] }, S.NIGHT), S.NIGHT.normal)
})

test('colour expression covers every style key and falls back to normal', () => {
  const e = S.colorExpression(S.DAY)
  assert.deepStrictEqual(e.slice(0, 2), ['match', ['get', 'style']])
  assert.strictEqual(e[e.length - 1], S.DAY.normal)
  for (const k of S.STYLE_KEYS) {
    if (k === 'normal') continue
    assert.strictEqual(e[e.indexOf(k) + 1], S.DAY[k], k)
  }
  for (const pal of [S.DAY, S.NIGHT]) assert.deepStrictEqual(Object.keys(pal).sort(), S.STYLE_KEYS.slice().sort())
})

test('ids and output are stable across calls', () => {
  const input = { 1: feature('1'), 2: feature('2', { kind: 'area', area: { semiMajorM: 80, semiMinorM: 30, bearingDeg: 10 } }) }
  assert.deepStrictEqual(S.toOverlayFeatures(input), S.toOverlayFeatures(input))
  assert.deepStrictEqual(S.toOverlayFeatures(input).features.map((f) => f.id), ['1:shape', '1:anchor', '2:shape', '2:anchor'])
})

test('garbage input is skipped, not thrown', () => {
  const bad = [
    null,
    {},
    feature('a', { radiusMeters: NaN }),
    feature('b', { radiusMeters: -3 }),
    feature('c', { radiusMeters: '40' }),
    feature('d', { kind: 'area', area: null }),
    feature('e', { kind: 'area', area: { semiMajorM: Infinity, semiMinorM: 3, bearingDeg: 0 } }),
    feature('f', {}, [NaN, 40]),
    feature('g', {}, [0, 95]),
    { type: 'Feature', geometry: null, properties: { kind: 'anchor', radiusMeters: 10 } },
    feature('ok')
  ]
  const fc = S.toOverlayFeatures(bad)
  assert.deepStrictEqual(fc.features.map((f) => f.id), ['ok:shape', 'ok:anchor'])
  assert.deepStrictEqual(S.toOverlayFeatures(null).features, [])
  assert.deepStrictEqual(S.toOverlayFeatures({ type: 'FeatureCollection', features: [feature('x')] }).features.length, 2)
})
