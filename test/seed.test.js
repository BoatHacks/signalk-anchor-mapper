'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { seed, featuresToFixes, buildRequest, loadTemporal } = require('../src/seed')
const { TrackStore } = require('../src/store')

const A = 'vessels.urn:mrn:imo:mmsi:111111111'
const B = 'vessels.urn:mrn:imo:mmsi:222222222'
const iso = (s) => new Date(s * 1000).toISOString()

function feature(context, segments, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: segments.map((seg) => seg.map((p) => [p.lon, p.lat])) },
    properties: { context, isSelf: false, coordTimes: segments.map((seg) => seg.map((p) => (p.t == null ? null : iso(p.t)))), ...extra }
  }
}

test('featuresToFixes reads [lon, lat] order, joins segments in time order and skips untimed points', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      feature(A, [
        [{ t: 200, lat: 40.1, lon: 0.6 }, { t: null, lat: 40.2, lon: 0.6 }],
        [{ t: 100, lat: 40.0, lon: 0.5 }]
      ])
    ]
  }
  const m = featuresToFixes(fc, 'vessels.self')
  assert.deepStrictEqual(m.get(A), [
    { t: 100, lat: 40.0, lon: 0.5 },
    { t: 200, lat: 40.1, lon: 0.6 }
  ])
})

test('featuresToFixes leaves out the own vessel, imported tracks, untimed and geometry-less features', () => {
  const p = [{ t: 100, lat: 1, lon: 2 }]
  const fc = {
    features: [
      feature('vessels.self', [p]),
      feature(B, [p], { isSelf: true }),
      feature(B, [p], { imported: '2026-01-01T00:00:00Z' }),
      { type: 'Feature', geometry: null, properties: { context: B, pointCount: 3 } },
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[2, 1]]] }, properties: { context: B } },
      feature(undefined, [p])
    ]
  }
  assert.strictEqual(featuresToFixes(fc, 'vessels.self').size, 0)
  assert.strictEqual(featuresToFixes(null, 'vessels.self').size, 0)
})

test('TrackStore.seed puts history before live fixes, thinned, and never after the first live fix', () => {
  const store = new TrackStore({ minFixIntervalS: 30 })
  store.add(A, 1000, 1, 1)
  const hist = []
  for (let t = 0; t <= 1100; t += 10) hist.push({ t, lat: 0, lon: 0 })
  const n = store.seed(A, hist)
  const ts = store.get(A).map((f) => f.t)
  assert.strictEqual(ts[ts.length - 1], 1000)
  assert.strictEqual(n, ts.length - 1)
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 30, `gap at ${i}: ${ts}`)
  assert.ok(ts[ts.length - 2] <= 970)
  // a vessel with no live data gets the history as is
  assert.strictEqual(store.seed(B, [{ t: 5, lat: 1, lon: 1 }]), 1)
  assert.strictEqual(store.seed('vessels.x', []), 0)
})

test('buildRequest uses Temporal when there is one, epoch-millisecond instants otherwise', () => {
  const plain = buildRequest(1000, 5000, 30, null)
  assert.strictEqual(plain.from.epochMilliseconds, 1000)
  assert.strictEqual(plain.to.epochMilliseconds, 5000)
  assert.strictEqual(plain.resolution, undefined)
  assert.strictEqual(plain.times, true)
  const fake = {
    Instant: { fromEpochMilliseconds: (ms) => ({ epochMilliseconds: ms }) },
    Duration: { from: (d) => ({ seconds: d.seconds }) }
  }
  const r = buildRequest(1000, 5000, 30, fake)
  assert.strictEqual(r.from.epochMilliseconds, 1000)
  assert.deepStrictEqual(r.resolution, { seconds: 30 })
  assert.ok(loadTemporal() === null || typeof loadTemporal().Instant === 'function')
})

test('seed asks the Track API for the history window and fills the store', async () => {
  let asked = null
  const app = {
    selfContext: 'vessels.self',
    getTrackApi: async () => ({
      getTracks: async (q) => {
        asked = q
        return { features: [feature(A, [[{ t: 100, lat: 1, lon: 2 }, { t: 200, lat: 1.1, lon: 2.1 }]]), feature('vessels.self', [[{ t: 100, lat: 0, lon: 0 }]])] }
      }
    })
  }
  const store = new TrackStore()
  const r = await seed(app, store, { historyS: 3600, now: () => 10000000, Temporal: null })
  assert.deepStrictEqual(r, { ok: true, vessels: 1, fixes: 2 })
  assert.strictEqual(asked.to.epochMilliseconds - asked.from.epochMilliseconds, 3600 * 1000)
  assert.deepStrictEqual(store.ids(), [A])
})

test('seed waits for a tracks plugin that registers late, and gives up after maxWait', async () => {
  let calls = 0
  const late = {
    getTrackApi: () => (++calls < 3 ? Promise.reject(new Error('No track api provider configured')) : Promise.resolve({ getTracks: async () => ({ features: [] }) }))
  }
  const fast = { wait: async () => {}, retryMs: 10, maxWaitMs: 100, Temporal: null, historyS: 60 }
  assert.deepStrictEqual(await seed(late, new TrackStore(), fast), { ok: true, vessels: 0, fixes: 0 })
  assert.strictEqual(calls, 3)

  calls = 0
  const never = { getTrackApi: () => (calls++, Promise.reject(new Error('none'))) }
  assert.deepStrictEqual(await seed(never, new TrackStore(), fast), { ok: false, reason: 'no-provider' })
  assert.strictEqual(calls, 11)

  assert.deepStrictEqual(await seed({}, new TrackStore(), fast), { ok: false, reason: 'no-track-api' })
  let stop = false
  const cancelling = { getTrackApi: () => ((stop = true), Promise.reject(new Error('none'))) }
  assert.deepStrictEqual(await seed(cancelling, new TrackStore(), { ...fast, cancelled: () => stop }), { ok: false, reason: 'cancelled' })
})

test('seed reports a failing fetch instead of throwing', async () => {
  const app = { getTrackApi: async () => ({ getTracks: async () => { throw new Error('db locked') } }) }
  const r = await seed(app, new TrackStore(), { historyS: 60, Temporal: null })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'fetch-failed')
  assert.strictEqual(r.error.message, 'db locked')
})
