'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createPublisher, toFeature } = require('../src/publish')

function fakeApp() {
  const messages = []
  return {
    messages,
    errors: [],
    status: '',
    error(m) {
      this.errors.push(m)
    },
    setPluginStatus(s) {
      this.status = s
    },
    handleMessage: (id, msg) => messages.push({ id, msg })
  }
}

const ctx = 'vessels.urn:mrn:imo:mmsi:111111111'
const anchor = {
  context: ctx,
  id: '111111111',
  kind: 'anchor',
  method: 'headings',
  quality: 'strong',
  tags: [],
  since: '2026-01-01T00:00:00.000Z',
  dwellHours: 3,
  center: { latitude: 40.6, longitude: 0.6 },
  radiusM: 40,
  arcDeg: 200
}
const area = {
  context: ctx,
  id: '111111111',
  kind: 'area',
  quality: 'weak',
  tags: [],
  since: '2026-01-01T00:00:00.000Z',
  dwellHours: 3,
  center: { latitude: 40.6, longitude: 0.6 },
  area: { semiMajorM: 90, semiMinorM: 40, bearingDeg: 10 }
}

const valuesOf = (m) => Object.fromEntries(m.msg.updates[0].values.map((v) => [v.path, v.value]))

test('an anchor estimate is published with position, radius and estimate', () => {
  const app = fakeApp()
  const pub = createPublisher(app, 'signalk-anchor-mapper')
  pub.publish([anchor])
  assert.strictEqual(app.messages.length, 1)
  const v = valuesOf(app.messages[0])
  assert.deepStrictEqual(v['navigation.anchor.position'], { latitude: 40.6, longitude: 0.6 })
  assert.strictEqual(v['navigation.anchor.maxRadius'], 40)
  assert.strictEqual(v['navigation.anchor.estimate'].kind, 'anchor')
  assert.strictEqual(pub.current().get(ctx).id, '111111111')
})

test('an anchor degrading to an area nulls position and radius in the same delta', () => {
  const app = fakeApp()
  const pub = createPublisher(app, 'signalk-anchor-mapper')
  pub.publish([anchor])
  pub.publish([area])
  const v = valuesOf(app.messages[1])
  assert.strictEqual(v['navigation.anchor.position'], null)
  assert.strictEqual(v['navigation.anchor.maxRadius'], null)
  assert.strictEqual(v['navigation.anchor.estimate'].kind, 'area')
})

test('a vessel dropping out gets all three paths nulled once', () => {
  const app = fakeApp()
  const pub = createPublisher(app, 'signalk-anchor-mapper')
  pub.publish([anchor])
  pub.publish([])
  pub.publish([])
  assert.strictEqual(app.messages.length, 2)
  const v = valuesOf(app.messages[1])
  assert.deepStrictEqual(v, {
    'navigation.anchor.position': null,
    'navigation.anchor.maxRadius': null,
    'navigation.anchor.estimate': null
  })
  assert.strictEqual(pub.current().size, 0)
})

test('clearAll nulls every published vessel and forgets them', () => {
  const app = fakeApp()
  const pub = createPublisher(app, 'signalk-anchor-mapper')
  pub.publish([anchor])
  pub.clearAll()
  assert.strictEqual(app.messages.length, 2)
  assert.strictEqual(valuesOf(app.messages[1])['navigation.anchor.estimate'], null)
  assert.strictEqual(pub.current().size, 0)
})

test('the status line counts anchors, areas and tracked vessels', () => {
  const app = fakeApp()
  const pub = createPublisher(app, 'signalk-anchor-mapper', { trackedCount: () => 7, historyNote: () => '; note' })
  pub.publish([anchor, { ...area, context: 'vessels.urn:mrn:imo:mmsi:222222222', id: '222222222' }])
  assert.strictEqual(app.status, '1 anchored, 1 area only, from 7 tracked; note')
})

test('toFeature names the vessel when the server knows it', () => {
  const app = { getPath: (p) => (p === `${ctx}.name` ? { value: 'SEA BREEZE' } : undefined) }
  const f = toFeature(app, anchor)
  assert.strictEqual(f.properties.name, 'SEA BREEZE')
  assert.deepStrictEqual(f.geometry.coordinates, [0.6, 40.6])
  assert.strictEqual(f.properties.radiusMeters, 40)
})
