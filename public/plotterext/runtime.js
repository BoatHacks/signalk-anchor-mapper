// Background runtime of the Freeboard-SK plotter extension: keeps the
// 'anchors' data overlay in step with the anchored-vessels resources.
// Runs only inside Freeboard (a modern browser), so it is an ES module.

export const RESOURCE_URL = '/signalk/v2/api/resources/anchored-vessels'
export const OVERLAY_ID = 'anchors'
export const SOURCE_ID = 'estimates'
export const POLL_MS = 60000

/**
 * Start polling and pushing data. Everything the runtime touches comes in as
 * a dependency so the tests can drive it without a browser.
 *  client  - connected ExtensionClient (signalk-plotterext-bus)
 *  shapes  - the AnchorShapes module (public/shapes.js)
 *  fetch, setInterval, log ({ info, warn })
 * Returns { tick, stop } (tick resolves once one poll is done).
 */
export function startRuntime({ client, shapes, fetch, setInterval: every, clearInterval: stopEvery, log }) {
  log = log || console
  if (!client.hasCapability('overlays.data')) {
    log.info('anchor-mapper: host has no data overlays; nothing to draw')
    return { tick: async () => {}, stop() {} }
  }
  let last = null // JSON of the last collection sent
  let reported = false

  async function load() {
    const r = await fetch(RESOURCE_URL, { credentials: 'same-origin' })
    // 404: the provider is gone (plugin stopped); clear the map instead of keeping old circles.
    if (r.status === 404) return {}
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  async function reportSkipped() {
    if (reported) return
    reported = true
    try {
      const list = await client.overlays.list()
      const me = (list || []).find((o) => o.id === OVERLAY_ID)
      const skipped = (me && me.skippedLayers) || []
      if (skipped.length) log.warn('anchor-mapper: Freeboard skipped style layers', skipped)
      else log.info('anchor-mapper: all style layers drawn')
    } catch (err) {
      log.warn(`anchor-mapper: overlay.list failed: ${err.message}`)
    }
  }

  // One poll at a time: a slow server never gets a second request stacked on the first.
  let running = null
  function tick() {
    if (!running) running = poll().finally(() => (running = null))
    return running
  }

  async function poll() {
    try {
      const data = shapes.toOverlayFeatures(await load())
      const json = JSON.stringify(data)
      if (json !== last) {
        await client.overlays.setData({ overlayId: OVERLAY_ID, source: SOURCE_ID, data })
        last = json
      }
      await reportSkipped()
    } catch (err) {
      // Keep what is drawn; the next poll tries again.
      log.warn(`anchor-mapper: update failed: ${err.message}`)
    }
  }

  async function applyNight(enabled) {
    const palette = enabled ? shapes.NIGHT : null
    for (const [layer, key] of shapes.COLOR_PAINT) {
      try {
        // null restores the colour the style declares (the day palette).
        await client.overlays.setLayer({
          overlayId: OVERLAY_ID,
          layer,
          paint: { [key]: palette ? shapes.colorExpression(palette) : null }
        })
      } catch (err) {
        log.warn(`anchor-mapper: night colours for ${layer} refused: ${err.message}`)
      }
    }
  }

  if (client.hasCapability('nightMode')) {
    client
      .subscribe(['nightMode.changed'], (_name, state) => applyNight(!!(state && state.enabled)))
      .then(() => client.nightMode.get())
      .then((state) => (state && state.enabled ? applyNight(true) : null))
      .catch((err) => log.warn(`anchor-mapper: night mode unavailable: ${err.message}`))
  }

  tick()
  const timer = every(tick, POLL_MS)
  return {
    tick,
    stop() {
      if (stopEvery) stopEvery(timer)
    }
  }
}
