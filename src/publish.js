'use strict'

const plotterext = require('./plotterext')

const RESOURCE_TYPE = 'anchored-vessels'

/**
 * Feature served by the `anchored-vessels` resource provider (SPEC 6.2).
 */
function toFeature(app, e) {
  const name = app.getPath && app.getPath(`${e.context}.name`) && app.getPath(`${e.context}.name`).value
  return {
    type: 'Feature',
    id: e.id,
    geometry: { type: 'Point', coordinates: [e.center.longitude, e.center.latitude] },
    properties: {
      context: e.context,
      mmsi: e.id,
      name: name || undefined,
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

/**
 * Publishes estimates as deltas on the other vessels' contexts and keeps the current
 * estimate map. `deps`: `trackedCount()` for the status line, `historyNote()` for its
 * suffix, `manifest` and `isRunning()` for the plotter extension provider.
 */
function createPublisher(app, pluginId, deps = {}) {
  let published = new Map() // vesselContext -> last published estimate (also the current map)

  function delta(context, values) {
    app.handleMessage(pluginId, { context, updates: [{ values }] })
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
    const anchors = list.filter((e) => e.kind === 'anchor').length
    app.setPluginStatus(`${anchors} anchored, ${list.length - anchors} area only, from ${deps.trackedCount ? deps.trackedCount() : 0} tracked${deps.historyNote ? deps.historyNote() : ''}`)
  }

  function current() {
    return published
  }

  // Null every published path on every vessel (plugin stop) and forget them.
  function clearAll() {
    for (const ctx of published.keys()) {
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
    published = new Map()
  }

  function registerResources() {
    // Resource providers are anonymously readable under allow_readonly,
    // unlike /plugins/<id>/* routes which are admin-gated.
    if (typeof app.registerResourceProvider !== 'function') return
    try {
      app.registerResourceProvider({
        type: RESOURCE_TYPE,
        methods: {
          listResources: async () => Object.fromEntries([...published.values()].map((e) => [e.id, toFeature(app, e)])),
          getResource: async (id) => {
            const e = [...published.values()].find((x) => x.id === id)
            if (!e) throw new Error(`No anchored vessel ${id}`)
            return toFeature(app, e)
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
          listResources: async () => (isRunning() ? { [plotterext.PLUGIN_ID]: deps.manifest } : {}),
          getResource: async (id) => {
            if (!isRunning() || id !== plotterext.PLUGIN_ID) throw new Error(`No plotter extension ${id}`)
            return deps.manifest
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

  function isRunning() {
    return deps.isRunning ? deps.isRunning() : true
  }

  return { publish, current, clearAll, registerResources }
}

module.exports = { createPublisher, toFeature, RESOURCE_TYPE }
