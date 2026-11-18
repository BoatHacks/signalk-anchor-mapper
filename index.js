'use strict'

const { TrackStore } = require('./src/store')
const { analyzeTrack, DEFAULTS } = require('./src/detector')
const { tagRepeatUse } = require('./src/repeat-use')
const { OwnVesselWind, annotateWind, isWindShipType } = require('./src/wind')

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
  let speeds = new Map() // vesselContext -> { t, v } latest speed over ground in m/s
  let ownWind = null // own vessel wind history, the default wind source

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
      },
      windSource: {
        type: 'string',
        title: 'Wind source for the heading-into-wind hint',
        description:
          'Sailboats and pleasure craft lying to an anchor point roughly into the wind, so the anchor is upwind. "self" uses this vessel\'s environment.wind data.',
        enum: ['self', 'none'],
        default: 'self'
      },
      windWeight: {
        type: 'number',
        title: 'Weight of the wind hint relative to a bow heading',
        description: 'The wind is a noisy pointer to the anchor, so keep this low. 0 turns the hint off.',
        default: DEFAULTS.windWeight,
        minimum: 0,
        maximum: 1
      },
      windMaxSpeedKnots: {
        type: 'number',
        title: 'Use the wind hint only below this reported speed (knots)',
        description: 'Speeds this low are GPS artifacts on a boat at anchor. Fixes with no reported speed are used too.',
        default: 0.5,
        minimum: 0
      }
    }
  }

  function idFromContext(ctx) {
    const m = MMSI_RE.exec(ctx)
    return m ? m[1] : ctx
  }

  function onDelta(delta) {
    try {
      if (!delta.context) return
      if (delta.context === app.selfContext || delta.context === 'vessels.self') {
        if (!ownWind) return
        for (const u of delta.updates || []) {
          const t = Date.parse(u.timestamp || new Date().toISOString()) / 1000
          for (const v of u.values || []) ownWind.handleValue(v.path, v.value, t)
        }
        return
      }
      for (const u of delta.updates || []) {
        const t = Date.parse(u.timestamp || new Date().toISOString()) / 1000
        for (const v of u.values || []) {
          if (v.path === 'navigation.headingTrue' && Number.isFinite(v.value)) {
            headings.set(delta.context, { t, h: v.value })
          } else if (v.path === 'navigation.speedOverGround' && Number.isFinite(v.value)) {
            speeds.set(delta.context, { t, v: v.value })
          } else if (v.path === 'navigation.position' && v.value) {
            const hd = headings.get(delta.context)
            const heading = hd && Math.abs(t - hd.t) <= 60 ? hd.h : undefined
            const sp = speeds.get(delta.context)
            const sog = sp && Math.abs(t - sp.t) <= 60 ? sp.v : undefined
            store.add(delta.context, t, v.value.latitude, v.value.longitude, heading, sog)
          }
        }
      }
    } catch (err) {
      app.error(`delta handling failed: ${err.message}`)
    }
  }

  function shipTypeOf(ctx) {
    try {
      const st = app.getPath && app.getPath(`${ctx}.design.aisShipType`)
      const v = st && (st.value !== undefined ? st.value : st)
      return v && Number.isFinite(v.id) ? v.id : undefined
    } catch (err) {
      return undefined
    }
  }

  function analyze(options) {
    const nowS = Date.now() / 1000
    store.prune(nowS)
    if (ownWind) ownWind.prune(nowS)
    const windWeight = options.windWeight ?? DEFAULTS.windWeight
    const opts = {
      minDwellS: (options.minDwellMinutes ?? DEFAULTS.minDwellS / 60) * 60,
      tightSwingM: options.tightSwingM ?? DEFAULTS.tightSwingM,
      windWeight: ownWind ? windWeight : 0
    }
    const found = []
    const stays = []
    for (const ctx of store.ids()) {
      try {
        const id = idFromContext(ctx)
        let track = store.get(ctx)
        // Wind hint: sailboats and pleasure craft only, see src/wind.js.
        if (ownWind && windWeight > 0 && isWindShipType(shipTypeOf(ctx))) {
          track = annotateWind(track, ownWind, { maxSogKnots: options.windMaxSpeedKnots ?? 0.5 })
        }
        const eps = analyzeTrack(track, opts)
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
            dwellHours: Math.round(((cur.t1 - cur.t0) / 3600) * 10) / 10,
            hint: cur.hint
              ? {
                  upwindBearingDegrees: Math.round(cur.hint.upwindBearingDeg),
                  anchorBearingDegrees: Math.round(cur.hint.anchorBearingDeg),
                  windShare: Math.round(cur.hint.windShare * 100) / 100,
                  headingOffsetDegrees: cur.hint.headingOffsetDeg == null ? null : Math.round(cur.hint.headingOffsetDeg),
                  anchorAgreement: cur.hint.anchorAgreement == null ? null : Math.round(cur.hint.anchorAgreement * 100) / 100,
                  windSamples: cur.hint.windFixes
                }
              : null
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
            // Heading-into-wind hint: for an area, anchorBearingDegrees is the likely
            // direction of the anchor from the area centre. Null when no wind data.
            windHint: e.hint,
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
        windHint: e.hint || undefined,
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
  }

  plugin.start = function (options) {
    options = options || {}
    store = new TrackStore({ maxAgeS: (options.historyHours ?? 12) * 3600 })
    ownWind = (options.windSource ?? 'self') === 'self' ? new OwnVesselWind({ maxAgeS: (options.historyHours ?? 12) * 3600 }) : null
    registerResources()
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.*',
        subscribe: [
          { path: 'navigation.position', period: 10000 },
          { path: 'navigation.headingTrue', period: 10000 },
          { path: 'navigation.speedOverGround', period: 10000 }
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
    if (ownWind) {
      app.subscriptionmanager.subscribe(
        {
          context: 'vessels.self',
          subscribe: [
            { path: 'environment.wind.directionTrue', period: 10000 },
            { path: 'environment.wind.angleTrueGround', period: 10000 },
            { path: 'environment.wind.angleTrueWater', period: 10000 },
            { path: 'navigation.headingTrue', period: 10000 }
          ]
        },
        unsubscribes,
        (err) => app.error(`wind subscription error: ${err}`),
        onDelta
      )
    }
    app.setPluginStatus('collecting tracks')
  }

  plugin.stop = function () {
    if (timer) clearInterval(timer)
    timer = null
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    published = new Map()
    estimates = new Map()
    headings = new Map()
    speeds = new Map()
    ownWind = null
    store = null
  }

  return plugin
}

module.exports.RESOURCE_TYPE = RESOURCE_TYPE
