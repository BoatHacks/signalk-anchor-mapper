'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { buildManifest, BASE, OVERLAY_ID, SOURCE_ID } = require('../src/plotterext')
const S = require('../public/shapes')

const PUBLIC = path.join(__dirname, '..', 'public')
const STYLE = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'plotterext', 'style.json'), 'utf8'))

// What Freeboard-SK draws of a data overlay style: DRAWN and LAYER_SOURCE in
// src/app/modules/plotterext/data-overlay-style.ts, Freeboard-SK master d22ab98
// (3.5.0-beta.2). Freeboard skips a whole layer that uses anything else (it also
// accepts other keys at their Style Spec default; we do not rely on that).
const DRAWN = {
  fill: { paint: ['fill-color', 'fill-opacity', 'fill-outline-color'], layout: [] },
  line: {
    paint: ['line-color', 'line-width', 'line-opacity', 'line-dasharray'],
    layout: ['line-cap', 'line-join', 'line-miter-limit']
  },
  circle: {
    paint: [
      'circle-color', 'circle-radius', 'circle-opacity', 'circle-stroke-color',
      'circle-stroke-width', 'circle-stroke-opacity', 'circle-translate'
    ],
    layout: []
  },
  symbol: {
    paint: ['text-color', 'text-halo-color', 'text-halo-width', 'text-opacity', 'text-translate'],
    layout: [
      'symbol-placement', 'symbol-spacing', 'text-field', 'text-font', 'text-size', 'text-anchor',
      'text-justify', 'text-max-width', 'text-letter-spacing', 'text-line-height', 'text-offset',
      'text-rotate', 'text-rotation-alignment', 'text-padding', 'text-transform', 'text-keep-upright',
      'text-max-angle', 'text-allow-overlap', 'text-ignore-placement', 'text-optional',
      'text-pitch-alignment', 'icon-pitch-alignment'
    ]
  }
}
const UNSUPPORTED_OPERATORS = ['image', 'within', 'distance']

function urlToFile(url) {
  assert.ok(url.startsWith(BASE + '/'), `${url} is under ${BASE}`)
  return path.join(PUBLIC, 'plotterext', url.slice(BASE.length + 1))
}

test('manifest: api version, and every reference resolves', () => {
  const m = buildManifest('1.2.3')
  assert.strictEqual(m.apiVersion, '1')
  assert.strictEqual(m.version, '1.2.3')
  assert.ok(m.requires.includes('overlays.data'))
  const panels = new Set(m.panels.map((p) => p.id))
  const overlays = new Set(m.overlays.map((o) => o.id))
  assert.ok(overlays.has(OVERLAY_ID))
  for (const a of m.actions) {
    if (a.action.panel) assert.ok(panels.has(a.action.panel), `action ${a.id} panel`)
    for (const t of a.targets) for (const o of t.overlays || []) assert.ok(overlays.has(o), `action ${a.id} overlay ${o}`)
  }
  for (const o of m.overlays) if (o.configPanel) assert.ok(panels.has(o.configPanel))
  const urls = [...m.background, ...m.panels].map((x) => x.url).concat(m.overlays.map((o) => o.style))
  for (const u of urls) assert.ok(fs.existsSync(urlToFile(u)), `${u} exists in public/plotterext`)
  // The webapp mount serves public/ at /<package name>/.
  assert.strictEqual(BASE, `/${require('../package.json').name}/plotterext`)
  // The overlay's interactive layer exists in the style.
  for (const l of m.overlays[0].interactiveLayers) assert.ok(STYLE.layers.some((x) => x.id === l), l)
})

test('style: version 8, one inline geojson source, only layers and keys Freeboard draws', () => {
  assert.strictEqual(STYLE.version, 8)
  assert.deepStrictEqual(Object.keys(STYLE.sources), [SOURCE_ID])
  assert.strictEqual(STYLE.sources[SOURCE_ID].type, 'geojson')
  assert.deepStrictEqual(STYLE.sources[SOURCE_ID].data, { type: 'FeatureCollection', features: [] })
  const ids = new Set()
  for (const l of STYLE.layers) {
    assert.ok(!ids.has(l.id), `duplicate layer ${l.id}`)
    ids.add(l.id)
    assert.ok(!l.id.startsWith('__'), 'ids starting with __ are reserved for hosts')
    assert.strictEqual(l.source, SOURCE_ID, l.id)
    const drawn = DRAWN[l.type]
    assert.ok(drawn, `${l.id}: layer type ${l.type} is drawn`)
    for (const part of ['paint', 'layout']) {
      for (const key of Object.keys(l[part] || {})) {
        if (key === 'visibility') continue
        assert.ok(drawn[part].includes(key), `${l.id}: ${part} ${key} is drawn by Freeboard`)
      }
    }
    const json = JSON.stringify([l.paint, l.layout, l.filter])
    for (const op of UNSUPPORTED_OPERATORS) assert.ok(!json.includes(`["${op}"`), `${l.id} uses ${op}`)
    // line-dasharray cannot be data-driven, hence the separate weak-circle layer.
    const dash = l.paint && l.paint['line-dasharray']
    if (dash) assert.ok(dash.every((x) => typeof x === 'number'), `${l.id}: literal dasharray`)
  }
})

test('style colours are the shared palette, so the overlay matches the webapp', () => {
  const coloured = []
  for (const l of STYLE.layers) {
    for (const [key, v] of Object.entries(l.paint || {})) {
      if (Array.isArray(v) && v[0] === 'match' && JSON.stringify(v[1]) === '["get","style"]') coloured.push([l.id, key])
    }
  }
  assert.deepStrictEqual(coloured, S.COLOR_PAINT)
  for (const [id, key] of S.COLOR_PAINT) {
    const l = STYLE.layers.find((x) => x.id === id)
    assert.deepStrictEqual(l.paint[key], S.colorExpression(S.DAY), `${id} ${key}`)
  }
})

test('style filters split the features toOverlayFeatures makes', () => {
  // A tiny evaluator for the filter forms the style uses.
  const ev = (e, p) => {
    if (!Array.isArray(e)) return e
    switch (e[0]) {
      case 'get': return p[e[1]]
      case '==': return ev(e[1], p) === ev(e[2], p)
      case '!=': return ev(e[1], p) !== ev(e[2], p)
      case 'all': return e.slice(1).every((x) => ev(x, p))
      default: throw new Error(`filter op ${e[0]} not covered`)
    }
  }
  const layersFor = (f) => STYLE.layers.filter((l) => !l.filter || ev(l.filter, f.properties)).map((l) => l.id)
  const feat = (props, kind) => ({ type: 'Feature', id: props.mmsi, geometry: { type: 'Point', coordinates: [0.6, 40.6] }, properties: Object.assign({ kind, tags: [] }, props) })
  const strong = S.toOverlayFeatures([feat({ mmsi: '1', quality: 'strong', radiusMeters: 40 }, 'anchor')]).features
  const weak = S.toOverlayFeatures([feat({ mmsi: '2', quality: 'weak', radiusMeters: 40 }, 'anchor')]).features
  const area = S.toOverlayFeatures([feat({ mmsi: '3', quality: 'weak', area: { semiMajorM: 90, semiMinorM: 30, bearingDeg: 0 } }, 'area')]).features
  assert.deepStrictEqual(layersFor(strong[0]), ['circle-fill', 'circle-line'])
  assert.deepStrictEqual(layersFor(weak[0]), ['circle-fill', 'circle-line-weak'])
  assert.deepStrictEqual(layersFor(area[0]), ['area-fill', 'area-line'])
  for (const pt of [strong[1], weak[1], area[1]]) assert.deepStrictEqual(layersFor(pt), ['anchor-point', 'label'])
})

// ---------- runtime ----------

function fakeClient(caps, opts = {}) {
  const calls = []
  const handlers = {}
  return {
    calls,
    handlers,
    hasCapability: (c) => caps.includes(c),
    subscribe: async (patterns, h) => {
      for (const p of patterns) handlers[p] = h
      return () => {}
    },
    nightMode: { get: async () => ({ enabled: !!opts.night, auto: false }) },
    overlays: {
      setData: async (p) => { calls.push(['setData', p]) },
      setLayer: async (p) => { calls.push(['setLayer', p]) },
      list: async () => [{ id: 'anchors', skippedLayers: opts.skipped || [] }]
    }
  }
}

function fakeFetch(responses) {
  const seen = []
  const fn = async (url) => {
    seen.push(url)
    const r = responses.length > 1 ? responses.shift() : responses[0]
    if (r instanceof Error) throw r
    return { ok: r.status === 200, status: r.status, json: async () => r.body }
  }
  fn.seen = seen
  return fn
}

const RESOURCE = {
  123: { type: 'Feature', id: '123', geometry: { type: 'Point', coordinates: [0.6, 40.6] }, properties: { mmsi: '123', name: 'Blue Moon', kind: 'anchor', quality: 'strong', tags: [], radiusMeters: 45 } }
}

function quietLog() {
  const log = { infos: [], warns: [] }
  log.info = (...a) => log.infos.push(a.join(' '))
  log.warn = (...a) => log.warns.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  return log
}

async function runtime() {
  return import('../public/plotterext/runtime.js')
}

test('runtime pushes the estimates on start and every minute, only when changed', async () => {
  const { startRuntime, RESOURCE_URL, POLL_MS } = await runtime()
  const client = fakeClient(['overlays.data'])
  const fetch = fakeFetch([{ status: 200, body: RESOURCE }])
  let every
  const log = quietLog()
  const rt = startRuntime({ client, shapes: S, fetch, setInterval: (fn, ms) => { every = ms; return 1 }, log })
  await rt.tick()
  assert.strictEqual(every, POLL_MS)
  assert.strictEqual(fetch.seen[0], RESOURCE_URL)
  const sets = client.calls.filter((c) => c[0] === 'setData')
  assert.strictEqual(sets.length, 1, 'unchanged data is not sent twice')
  assert.strictEqual(sets[0][1].overlayId, 'anchors')
  assert.strictEqual(sets[0][1].source, 'estimates')
  assert.deepStrictEqual(sets[0][1].data, S.toOverlayFeatures(RESOURCE))
  assert.ok(log.infos.some((s) => s.includes('all style layers drawn')))
  assert.deepStrictEqual(log.warns, [])
})

test('runtime keeps the drawing on a failed poll and clears it when the provider is gone', async () => {
  const { startRuntime } = await runtime()
  const client = fakeClient(['overlays.data'], { skipped: [{ id: 'label', reason: 'property' }] })
  const fetch = fakeFetch([{ status: 200, body: RESOURCE }, new Error('offline'), { status: 500 }, { status: 404 }])
  const log = quietLog()
  const rt = startRuntime({ client, shapes: S, fetch, setInterval: () => 1, log })
  await rt.tick() // joins the poll start() began: the data is sent
  await rt.tick() // offline
  await rt.tick() // HTTP 500
  let sets = client.calls.filter((c) => c[0] === 'setData')
  assert.strictEqual(sets.length, 1, 'failures send nothing')
  assert.ok(log.warns.some((s) => s.includes('offline')))
  assert.ok(log.warns.some((s) => s.includes('HTTP 500')))
  assert.ok(log.warns.some((s) => s.includes('skipped style layers') && s.includes('label')), 'skipped layers are logged')
  await rt.tick()
  sets = client.calls.filter((c) => c[0] === 'setData')
  assert.strictEqual(sets.length, 2)
  assert.deepStrictEqual(sets[1][1].data, { type: 'FeatureCollection', features: [] })
})

test('runtime recolours for night mode and restores the style colours by day', async () => {
  const { startRuntime } = await runtime()
  const client = fakeClient(['overlays.data', 'nightMode'], { night: true })
  const rt = startRuntime({ client, shapes: S, fetch: fakeFetch([{ status: 200, body: {} }]), setInterval: () => 1, log: quietLog() })
  await rt.tick()
  await new Promise((r) => setTimeout(r, 0))
  let layers = client.calls.filter((c) => c[0] === 'setLayer').map((c) => c[1])
  assert.deepStrictEqual(layers.map((l) => [l.layer, Object.keys(l.paint)[0]]), S.COLOR_PAINT)
  for (const l of layers) assert.deepStrictEqual(Object.values(l.paint)[0], S.colorExpression(S.NIGHT))
  client.calls.length = 0
  await client.handlers['nightMode.changed']('nightMode.changed', { enabled: false, auto: true })
  layers = client.calls.filter((c) => c[0] === 'setLayer').map((c) => c[1])
  assert.strictEqual(layers.length, S.COLOR_PAINT.length)
  for (const l of layers) assert.strictEqual(Object.values(l.paint)[0], null)
})

test('runtime does nothing on a host without data overlays', async () => {
  const { startRuntime } = await runtime()
  const client = fakeClient([])
  const fetch = fakeFetch([{ status: 200, body: RESOURCE }])
  startRuntime({ client, shapes: S, fetch, setInterval: () => assert.fail('no polling'), log: quietLog() })
  assert.strictEqual(fetch.seen.length, 0)
})

// ---------- details window ----------

test('details window finds the vessel from either action target', async () => {
  const { mmsiFromTarget } = await import('../public/plotterext/estimate.js')
  assert.strictEqual(mmsiFromTarget({ kind: 'overlayFeature', featureId: '123:anchor', properties: { mmsi: '123' } }), '123')
  assert.strictEqual(mmsiFromTarget({ kind: 'overlayFeature', featureId: '456:shape', properties: {} }), '456')
  assert.strictEqual(mmsiFromTarget({ kind: 'vessel', context: 'vessels.urn:mrn:imo:mmsi:367123450', self: false }), '367123450')
  assert.strictEqual(mmsiFromTarget({ kind: 'vessel', context: 'vessels.urn:mrn:signalk:uuid:abc' }), null)
  assert.strictEqual(mmsiFromTarget({ kind: 'position', position: [0, 0] }), null)
  assert.strictEqual(mmsiFromTarget(undefined), null)
})

test('details window shows the estimate, then "none" for a vessel without one', async () => {
  const { startEstimate, RESOURCE_URL } = await import('../public/plotterext/estimate.js')
  const views = []
  const fetch = fakeFetch([{ status: 200, body: RESOURCE['123'] }, { status: 404 }])
  const client = fakeClient([])
  client.context = { kind: 'window', invocation: { actionId: 'details', target: { kind: 'overlayFeature', featureId: '123:anchor', properties: { mmsi: '123' } } } }
  await startEstimate({ client, fetch, render: (v) => views.push(v) })
  await new Promise((r) => setTimeout(r, 0))
  assert.strictEqual(fetch.seen[0], `${RESOURCE_URL}/123`)
  assert.strictEqual(views[0].state, 'estimate')
  assert.strictEqual(views[0].title, 'Blue Moon')
  assert.ok(views[0].rows.some(([k, v]) => k === 'Swing radius' && v === '45 m'))
  // The same window, reused for an AIS vessel with no estimate.
  await client.handlers['action.invoked']('action.invoked', { actionId: 'vessel', target: { kind: 'vessel', context: 'vessels.urn:mrn:imo:mmsi:999', name: 'Nobody' } })
  assert.deepStrictEqual(views[1], { state: 'none', name: 'Nobody' })
})

test('details text for an area estimate gives the ellipse, not a radius', async () => {
  const { describe } = await import('../public/plotterext/estimate.js')
  const d = describe({ geometry: { coordinates: [0.6, 40.6] }, properties: { mmsi: '9', kind: 'area', quality: 'weak', tags: ['possibly-moored'], area: { semiMajorM: 120, semiMinorM: 60, bearingDeg: 30 } } })
  const rows = Object.fromEntries(d.rows)
  assert.strictEqual(rows.Area, '120 x 60 m, long axis 30°')
  assert.ok(!('Swing radius' in rows))
  assert.match(rows.Tags, /possibly moored/)
  assert.match(d.note, /cannot be placed/)
})
