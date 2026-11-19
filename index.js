'use strict'

const { TrackStore } = require('./src/store')
const { analyzeTrack, DEFAULTS } = require('./src/detector')
const { tagRepeatUse } = require('./src/repeat-use')
const { seed } = require('./src/seed')
const plotterext = require('./src/plotterext')
const { createPublisher, RESOURCE_TYPE } = require('./src/publish')
const { version } = require('./package.json')

const MMSI_RE = /mmsi:(\d+)/

module.exports = function (app) {
  const plugin = {
    id: 'signalk-anchor-mapper',
    name: 'Anchor Mapper',
    description: 'Estimates where other vessels are anchored (position and swing radius) from their AIS tracks'
  }

  let store = null
  let timer = null
  let unsubscribes = []
  let headings = new Map() // vesselContext -> { t, h } latest true heading in radians
  let running = false
  let seedRun = null // { cancelled } of the seeding started by the current start()
  let historyNote = '' // what the plugin status says about restart history
  const manifest = plotterext.buildManifest(version)
  const publisher = createPublisher(app, plugin.id, {
    manifest,
    isRunning: () => running,
    trackedCount: () => (store ? store.ids().length : 0),
    historyNote: () => historyNote
  })

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
    publisher.publish(keep)
  }

  plugin.start = function (options) {
    options = options || {}
    store = new TrackStore({ maxAgeS: (options.historyHours ?? 12) * 3600 })
    running = true
    publisher.registerResources()
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
    app.setPluginStatus('collecting tracks; loading track history from the tracks plugin')
    startSeeding(options)
  }

  function startSeeding(options) {
    const run = { cancelled: false }
    seedRun = run
    const dwellMin = options.minDwellMinutes ?? DEFAULTS.minDwellS / 60
    const noHistory = `no track history, so estimates need ${dwellMin} min to build up after a restart`
    seed(app, store, {
      historyS: (options.historyHours ?? 12) * 3600,
      cancelled: () => run.cancelled
    })
      .then((r) => {
        if (run.cancelled) return
        if (r.ok) {
          historyNote =
            r.vessels > 0
              ? `; seeded ${r.vessels} tracks from the tracks plugin`
              : "; the tracks plugin had no other vessels' tracks to seed from"
          if (app.debug) app.debug(`seeded ${r.fixes} fixes of ${r.vessels} vessels from the Track API`)
          analyze(options)
          return
        }
        historyNote = `; ${noHistory}`
        if (r.reason === 'fetch-failed') {
          app.error(`seeding from the tracks plugin failed: ${r.error && r.error.message}`)
        } else if (app.debug) {
          app.debug(`no track history to seed from (${r.reason})`)
        }
        app.setPluginStatus(`collecting tracks; ${noHistory}`)
      })
      .catch((err) => app.error(`seeding failed: ${err.message}`))
  }

  plugin.stop = function () {
    running = false
    publisher.clearAll()
    if (seedRun) seedRun.cancelled = true
    seedRun = null
    historyNote = ''
    if (timer) clearInterval(timer)
    timer = null
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    headings = new Map()
    store = null
  }

  return plugin
}

module.exports.RESOURCE_TYPE = RESOURCE_TYPE
