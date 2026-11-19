'use strict'

const test = require('node:test')
const assert = require('node:assert')
const createPlugin = require('../index')
const { makeProjection } = require('../src/geo')

function fakeApp() {
  const messages = []
  const app = {
    selfContext: 'vessels.self',
    messages,
    status: '',
    errors: [],
    resources: null,
    providers: {},
    handler: null,
    error: (m) => app.errors.push(m),
    setPluginStatus: (s) => (app.status = s),
    handleMessage: (id, msg) => messages.push({ id, msg }),
    registerResourceProvider: (p) => {
      app.providers[p.type] = p
      if (p.type === 'anchored-vessels') app.resources = p
    },
    subscriptionmanager: {
      subscribe: (sub, unsubs, onErr, onDelta) => {
        app.handler = onDelta
        unsubs.push(() => {})
      }
    }
  }
  return app
}

test('plugin publishes an anchor estimate for a swinging vessel and serves it as a resource', async (t) => {
  const app = fakeApp()
  const plugin = createPlugin(app)
  assert.strictEqual(plugin.id, 'signalk-anchor-mapper')
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const start = Date.parse('2026-01-01T00:00:00Z')
  t.mock.timers.setTime(start)
  plugin.start({ analyzeIntervalMinutes: 5, historyHours: 12 })

  const proj = makeProjection(40.6, 0.6)
  const ctx = 'vessels.urn:mrn:imo:mmsi:123456789'
  const hours = 5
  for (let i = 0; i <= hours * 120; i++) {
    const a = (i / (hours * 120)) * 5
    const p = proj.toLatLon(70 * Math.cos(a), 70 * Math.sin(a))
    const ts = new Date(start + i * 30000 - hours * 3600 * 1000).toISOString()
    app.handler({
      context: ctx,
      updates: [{ timestamp: ts, values: [{ path: 'navigation.position', value: p }] }]
    })
  }
  // self vessel is ignored
  app.handler({ context: 'vessels.self', updates: [{ timestamp: new Date(start).toISOString(), values: [{ path: 'navigation.position', value: { latitude: 1, longitude: 1 } }] }] })

  t.mock.timers.tick(5 * 60 * 1000)

  const paths = app.messages.filter((m) => m.msg.context === ctx).flatMap((m) => m.msg.updates[0].values.map((v) => v.path))
  assert.ok(paths.includes('navigation.anchor.position'), `published: ${paths}`)
  assert.ok(paths.includes('navigation.anchor.maxRadius'))
  const radius = app.messages.flatMap((m) => m.msg.updates[0].values).find((v) => v.path === 'navigation.anchor.maxRadius').value
  assert.ok(Math.abs(radius - 70) < 15, `radius ${radius}`)

  const list = await app.resources.methods.listResources({})
  assert.deepStrictEqual(Object.keys(list), ['123456789'])
  assert.strictEqual(list['123456789'].geometry.type, 'Point')
  await assert.rejects(app.resources.methods.setResource('x', {}))
  assert.deepStrictEqual(app.errors, [])
  plugin.stop()
})

test('a vessel with only an occupied area gets an estimate but no anchor position or radius', async (t) => {
  const app = fakeApp()
  const plugin = createPlugin(app)
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const start = Date.parse('2026-01-01T00:00:00Z')
  t.mock.timers.setTime(start)
  plugin.start({})
  const proj = makeProjection(40.6, 0.6)
  const ctx = 'vessels.urn:mrn:imo:mmsi:222222222'
  for (let i = 0; i <= 5 * 120; i++) {
    const b = ((200 + 25 * Math.sin((i / 600) * 9)) * Math.PI) / 180
    const p = proj.toLatLon(120 * Math.sin(b) + ((i * 7) % 11) - 5, 120 * Math.cos(b) + ((i * 5) % 9) - 4)
    app.handler({ context: ctx, updates: [{ timestamp: new Date(start + i * 30000 - 5 * 3600000).toISOString(), values: [{ path: 'navigation.position', value: p }] }] })
  }
  t.mock.timers.tick(5 * 60 * 1000)
  const values = app.messages.filter((m) => m.msg.context === ctx).flatMap((m) => m.msg.updates[0].values)
  const pos = values.find((v) => v.path === 'navigation.anchor.position')
  const est = values.find((v) => v.path === 'navigation.anchor.estimate')
  assert.ok(est, 'estimate published')
  assert.strictEqual(est.value.kind, 'area')
  assert.ok(est.value.area.semiMajorM > 0)
  assert.strictEqual(pos.value, null, 'no anchor position published')
  plugin.stop()
})

test('plugin serves the Freeboard plotter extension manifest only while running', async () => {
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({})
  const prov = app.providers.plotterExtensions
  assert.ok(prov, 'plotterExtensions provider registered on start')
  const list = await prov.methods.listResources({})
  assert.deepStrictEqual(Object.keys(list), ['signalk-anchor-mapper'])
  const m = list['signalk-anchor-mapper']
  assert.strictEqual(m.apiVersion, '1')
  assert.strictEqual(m.version, require('../package.json').version)
  assert.deepStrictEqual(await prov.methods.getResource('signalk-anchor-mapper'), m)
  await assert.rejects(prov.methods.getResource('other'))
  await assert.rejects(prov.methods.setResource('signalk-anchor-mapper', {}))
  await assert.rejects(prov.methods.deleteResource('signalk-anchor-mapper'))
  plugin.stop()
  assert.deepStrictEqual(await prov.methods.listResources({}), {})
  await assert.rejects(prov.methods.getResource('signalk-anchor-mapper'))
  assert.deepStrictEqual(app.errors, [])
})

function swingingTrack(proj, startMs, hours) {
  const segment = []
  for (let i = 0; i <= hours * 120; i++) {
    const a = (i / (hours * 120)) * 5
    const p = proj.toLatLon(70 * Math.cos(a), 70 * Math.sin(a))
    segment.push({ t: new Date(startMs + i * 30000 - hours * 3600 * 1000).toISOString(), p })
  }
  return {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: [segment.map((s) => [s.p.longitude, s.p.latitude])] },
    properties: { context: 'vessels.urn:mrn:imo:mmsi:123456789', isSelf: false, coordTimes: [segment.map((s) => s.t)] }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('after a restart, tracks from the tracks plugin give an estimate right away', async (t) => {
  const app = fakeApp()
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const start = Date.parse('2026-01-01T00:00:00Z')
  t.mock.timers.setTime(start)
  let request = null
  app.getTrackApi = async () => ({
    getTracks: async (q) => {
      request = q
      return { type: 'FeatureCollection', features: [swingingTrack(makeProjection(40.6, 0.6), start, 5)] }
    }
  })
  const plugin = createPlugin(app)
  plugin.start({ historyHours: 12 })
  assert.match(app.status, /loading track history/)
  for (let i = 0; i < 5; i++) await flush()

  assert.strictEqual(request.to.epochMilliseconds - request.from.epochMilliseconds, 12 * 3600 * 1000)
  const radius = app.messages.flatMap((m) => m.msg.updates[0].values).find((v) => v.path === 'navigation.anchor.maxRadius')
  assert.ok(radius && Math.abs(radius.value - 70) < 15, `radius ${radius && radius.value}`)
  assert.match(app.status, /^1 anchored, .*seeded 1 tracks from the tracks plugin/)
  assert.deepStrictEqual(app.errors, [])
  plugin.stop()
})

test('without the tracks plugin, start still succeeds and the status says estimates need the dwell time', async () => {
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ minDwellMinutes: 90 })
  await flush()
  assert.match(app.status, /no track history, so estimates need 90 min/)
  assert.deepStrictEqual(app.errors, [])
  plugin.stop()

  const failing = fakeApp()
  failing.getTrackApi = async () => ({ getTracks: async () => { throw new Error('database is locked') } })
  const p2 = createPlugin(failing)
  p2.start({})
  for (let i = 0; i < 3; i++) await flush()
  assert.match(failing.status, /no track history/)
  assert.deepStrictEqual(failing.errors, ['seeding from the tracks plugin failed: database is locked'])
  p2.stop()
})

test('stopping the plugin while seeding drops the seeded tracks', async () => {
  const app = fakeApp()
  let release
  app.getTrackApi = () => new Promise((resolve) => (release = resolve))
  const plugin = createPlugin(app)
  plugin.start({})
  plugin.stop()
  release({ getTracks: async () => ({ features: [] }) })
  for (let i = 0; i < 3; i++) await flush()
  assert.deepStrictEqual(app.errors, [])
  assert.deepStrictEqual(app.messages, [])
})
