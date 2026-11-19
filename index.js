'use strict'

const { TrackStore } = require('./src/store')
const { analyzeTrack, DEFAULTS } = require('./src/detector')
const { tagRepeatUse } = require('./src/repeat-use')
const plotterext = require('./src/plotterext')
const { version } = require('./package.json')

const MMSI_RE = /mmsi:(\d+)/
const RESOURCE_TYPE = 'anchored-vessels'

module.exports = function (app) {
  const plugin = {
    id: 'signalk-anchor-mapper',
    name: 'Anchor Mapper',
    description: 'Estimates where other vessels are anchored (position and swing radius) from their AIS tracks'
  }

  let store = null
  let timer = null
  let unsubscribes = []
  let published = new Map() // vesselContext -> last published estimate
  let estimates = new Map() // vesselContext -> current estimate (for the resource provider)
  let headings = new Map() // vesselContext -> { t, h } latest true heading in radians
  let running = false
  const manifest = plotterext.buildManifest(version)

  plugin.schema = {
    type: 'object',
    properties: {
      minDwellMinutes: {
        type: 'number',
        title: 'Minimum time stationary (minutes)',
        description: 'A vessel must stay within a small area this long before it is considered anchored',
        default: DEFAULTS.minDwellS / 60,
        minimum: 20
      },
      analyzeIntervalMinutes: {
        type: 'number',
        title: 'Analysis interval (minutes)',
        default: 5,
        minimum: 1
      },
      historyHours: {
        type: 'number',
        title: 'Track history kept in memory (hours)',
        default: 12,
        minimum: 2,
        maximum: 72
      },
      tightSwingM: {
        type: 'number',
        title: 'Tag swings tighter than this as "possibly moored" (metres)',
        default: DEFAULTS.tightSwingM,
        minimum: 0
      },
      publishTightSwings: {
        type: 'boolean',
        title: 'Publish "possibly moored" estimates too',
        description: 'They are still tagged. Turn off to publish only swings above the threshold.',
        default: true
      },
      includeWeakFits: {
        type: 'boolean',
        title: 'Publish weak (noisy ring) fits',
        default: true
      }
    }
  }

  function idFromContext(ctx) {
    const m = MMSI_RE.exec(ctx)
    return m ? m[1] : ctx
  }

  function onDelta(delta) {
    try {
      if (!delta.context || delta.context === app.selfContext) return
      for (const u of delta.updates || []) {
        const t = Date.parse(u.timestamp || new Date().toISOString()) / 1000
        for (const v of u.values || []) {
          if (v.path === 'navigation.headingTrue' && Number.isFinite(v.value)) {
            headings.set(delta.context, { t, h: v.value })
          } else if (v.path === 'navigation.position' && v.value) {
            const hd = headings.get(delta.context)
            const heading = hd && Math.abs(t - hd.t) <= 60 ? hd.h : undefined
            store.add(delta.context, t, v.value.latitude, v.value.longitude, heading)
          }
        }
      }
    } catch (err) {
      app.error(`delta handling failed: ${err.message}`)
    }
  }

  function analyze(options) {
    const nowS = Date.now() / 1000
    store.prune(nowS)
    const opts = {
      minDwellS: (options.minDwellMinutes ?? DEFAULTS.minDwellS / 60) * 60,
      tightSwingM: options.tightSwingM ?? DEFAULTS.tightSwingM
    }
    const found = []
    const stays = []
    for (const ctx of store.ids()) {
      try {
        const id = idFromContext(ctx)
        const eps = analyzeTrack(store.get(ctx), opts)
        for (const e of eps) stays.push({ id, centroid: e.centroid })
        // Only the ongoing episode matters for "anchored now".
        const cur = eps.find((e) => e.ongoing)
        if (cur && (cur.verdict === 'anchor' || cur.verdict === 'anchor-area')) {
          const base = {
            context: ctx,
            id,
            kind: cur.verdict === 'anchor' ? 'anchor' : 'area',
            quality: cur.quality,
            tags: cur.tags.slice(),
            since: new Date(cur.t0 * 1000).toISOString(),
            dwellHours: Math.round(((cur.t1 - cur.t0) / 3600) * 10) / 10
          }
          if (cur.verdict === 'anchor') {
            found.push({
              ...base,
              method: cur.method,
              center: cur.center,
              radiusM: Math.round(cur.swingRadiusM),
              arcDeg: cur.fit && cur.fit.arcDeg != null ? Math.round(cur.fit.arcDeg) : null
            })
          } else {
            found.push({
              ...base,
              center: cur.area.center,
              area: {
                semiMajorM: Math.round(cur.area.semiMajorM),
                semiMinorM: Math.round(cur.area.semiMinorM),
                bearingDeg: Math.round(cur.area.bearingDeg)
              }
            })
          }
        }
      } catch (err) {
        app.error(`analysis failed for ${ctx}: ${err.message}`)
      }
    }
    try {
      tagRepeatUse(found, stays)
    } catch (err) {
      app.error(`repeat-use tagging failed: ${err.message}`)
    }
    const keep = found.filter(
      (e) =>
        (options.publishTightSwings !== false || !e.tags.includes('possibly-moored')) &&
        (options.includeWeakFits !== false || e.kind === 'area' || e.quality === 'strong')
    )
    publish(keep)
  }

  function delta(context, values) {
    app.handleMessage(plugin.id, { context, updates: [{ values }] })
  }

  function publish(list) {
    const now = new Map(list.map((e) => [e.context, e]))
    for (const e of list) {
      try {
        const values = []
        if (e.kind === 'anchor') {
          values.push(
            { path: 'navigation.anchor.position', value: { latitude: e.center.latitude, longitude: e.center.longitude } },
            { path: 'navigation.anchor.maxRadius', value: e.radiusM }
          )
        } else {
          // Anchor point not resolvable from the track alone: publish no position or radius,
          // and clear any earlier ones so clients never see a stale anchor.
          values.push({ path: 'navigation.anchor.position', value: null }, { path: 'navigation.anchor.maxRadius', value: null })
        }
        values.push({
          path: 'navigation.anchor.estimate',
          value: {
            source: 'signalk-anchor-mapper',
            kind: e.kind,
            method: e.kind === 'anchor' ? e.method : 'occupied-area',
            quality: e.quality,
            tags: e.tags,
            since: e.since,
            dwellHours: e.dwellHours,
            arcDegrees: e.arcDeg == null ? null : e.arcDeg,
            area: e.area || null,
            note:
              e.kind === 'anchor'
                ? 'Estimated from position tracks and headings only; may be a mooring buoy or other fixed mooring.'
                : 'Long stay with a swing, but the anchor position cannot be placed from the track alone; only the occupied area is given.'
          }
        })
        delta(e.context, values)
      } catch (err) {
        app.error(`publish failed for ${e.context}: ${err.message}`)
      }
    }
    // Clear estimates for vessels that are no longer anchored.
    for (const ctx of published.keys()) {
      if (!now.has(ctx)) {
        try {
          delta(ctx, [
            { path: 'navigation.anchor.position', value: null },
            { path: 'navigation.anchor.maxRadius', value: null },
            { path: 'navigation.anchor.estimate', value: null }
          ])
        } catch (err) {
          app.error(`clear failed for ${ctx}: ${err.message}`)
        }
      }
    }
    published = now
    estimates = now
    const anchors = list.filter((e) => e.kind === 'anchor').length
    app.setPluginStatus(`${anchors} anchored, ${list.length - anchors} area only, from ${store.ids().length} tracked`)
  }

  function toFeature(e) {
    return {
      type: 'Feature',
      id: e.id,
      geometry: { type: 'Point', coordinates: [e.center.longitude, e.center.latitude] },
      properties: {
        context: e.context,
        mmsi: e.id,
        name: (app.getPath && app.getPath(`${e.context}.name`) && app.getPath(`${e.context}.name`).value) || undefined,
        kind: e.kind,
        method: e.kind === 'anchor' ? e.method : 'occupied-area',
        radiusMeters: e.kind === 'anchor' ? e.radiusM : undefined,
        area: e.area,
        quality: e.quality,
        tags: e.tags,
        since: e.since,
        dwellHours: e.dwellHours
      }
    }
  }

  function registerResources() {
    // Resource providers are anonymously readable under allow_readonly,
    // unlike /plugins/<id>/* routes which are admin-gated.
    if (typeof app.registerResourceProvider !== 'function') return
    try {
      app.registerResourceProvider({
        type: RESOURCE_TYPE,
        methods: {
          listResources: async () => Object.fromEntries([...estimates.values()].map((e) => [e.id, toFeature(e)])),
          getResource: async (id) => {
            const e = [...estimates.values()].find((x) => x.id === id)
            if (!e) throw new Error(`No anchored vessel ${id}`)
            return toFeature(e)
          },
          setResource: async () => {
            throw new Error('read only')
          },
          deleteResource: async () => {
            throw new Error('read only')
          }
        }
      })
    } catch (err) {
      app.error(`resource provider registration failed: ${err.message}`)
    }
    // Freeboard-SK reads this when it connects and draws the estimates as a plugin layer.
    try {
      app.registerResourceProvider({
        type: plotterext.RESOURCE_TYPE,
        methods: {
          listResources: async () => (running ? { [plotterext.PLUGIN_ID]: manifest } : {}),
          getResource: async (id) => {
            if (!running || id !== plotterext.PLUGIN_ID) throw new Error(`No plotter extension ${id}`)
            return manifest
          },
          setResource: async () => {
            throw new Error('read only')
          },
          deleteResource: async () => {
            throw new Error('read only')
          }
        }
      })
    } catch (err) {
      app.error(`plotter extension registration failed: ${err.message}`)
    }
  }

  plugin.start = function (options) {
    options = options || {}
    store = new TrackStore({ maxAgeS: (options.historyHours ?? 12) * 3600 })
    running = true
    registerResources()
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.*',
        subscribe: [
          { path: 'navigation.position', period: 10000 },
          { path: 'navigation.headingTrue', period: 10000 }
        ]
      },
      unsubscribes,
      (err) => app.error(`subscription error: ${err}`),
      onDelta
    )
    const every = (options.analyzeIntervalMinutes ?? 5) * 60 * 1000
    timer = setInterval(() => {
      try {
        analyze(options)
      } catch (err) {
        app.error(`analysis cycle failed: ${err.message}`)
      }
    }, every)
    app.setPluginStatus('collecting tracks')
  }

  plugin.stop = function () {
    running = false
    if (timer) clearInterval(timer)
    timer = null
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    published = new Map()
    estimates = new Map()
    headings = new Map()
    store = null
  }

  return plugin
}

module.exports.RESOURCE_TYPE = RESOURCE_TYPE
