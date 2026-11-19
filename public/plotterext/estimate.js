// Details window of the Freeboard-SK plotter extension: one vessel's anchor
// estimate, opened from a tap on an anchor point or from an AIS vessel's popover.

export const RESOURCE_URL = '/signalk/v2/api/resources/anchored-vessels'

const MMSI_RE = /mmsi:(\d+)/

// The vessel an action was chosen on: an overlay feature carries its mmsi in its
// properties, an AIS vessel its Signal K context.
export function mmsiFromTarget(target) {
  if (!target) return null
  if (target.kind === 'overlayFeature') {
    const m = target.properties && target.properties.mmsi
    if (m) return String(m)
    const id = target.featureId == null ? '' : String(target.featureId)
    return id.split(':')[0] || null
  }
  if (target.kind === 'vessel' && typeof target.context === 'string') {
    const m = MMSI_RE.exec(target.context)
    return m ? m[1] : null
  }
  return null
}

const NOTE_ANCHOR = 'Estimated from position tracks and headings only; may be a mooring buoy or other fixed mooring.'
const NOTE_AREA = 'Long stay with a swing, but the anchor position cannot be placed from the track alone; only the occupied area is given.'

const TAG_TEXT = {
  'possibly-moored': 'possibly moored (swing under the threshold)',
  'possible-mooring-buoy': 'possible mooring buoy (other boats stayed here too)'
}

function fmtTime(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// An anchored-vessels resource feature -> { title, rows: [[label, value]], note }.
export function describe(feature, fallbackName) {
  const p = (feature && feature.properties) || {}
  const isArea = p.kind === 'area'
  const rows = []
  rows.push(['Estimate', isArea ? 'occupied area only' : 'anchor and swing circle'])
  if (!isArea) rows.push(['Swing radius', `${p.radiusMeters} m`])
  if (isArea && p.area) {
    rows.push(['Area', `${p.area.semiMajorM} x ${p.area.semiMinorM} m, long axis ${p.area.bearingDeg}°`])
  }
  rows.push(['Method', p.method || (isArea ? 'occupied-area' : '-')])
  rows.push(['Quality', p.quality === 'strong' ? 'strong' : 'weak (noisy ring)'])
  const tags = Array.isArray(p.tags) ? p.tags : []
  rows.push(['Tags', tags.length ? tags.map((t) => TAG_TEXT[t] || t).join('; ') : 'none'])
  if (feature && feature.geometry && Array.isArray(feature.geometry.coordinates)) {
    const [lon, lat] = feature.geometry.coordinates
    rows.push([isArea ? 'Area centre' : 'Anchor', `${lat.toFixed(5)}, ${lon.toFixed(5)}`])
  }
  if (p.since) rows.push(['Since', fmtTime(p.since)])
  if (p.dwellHours != null) rows.push(['Stationary', `${p.dwellHours} h`])
  rows.push(['MMSI', String(p.mmsi || '')])
  return { title: p.name || fallbackName || p.mmsi || 'Vessel', rows, note: isArea ? NOTE_AREA : NOTE_ANCHOR }
}

export async function loadEstimate(fetch, mmsi) {
  const r = await fetch(`${RESOURCE_URL}/${encodeURIComponent(mmsi)}`, { credentials: 'same-origin' })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const f = await r.json()
  return f && f.properties ? f : null
}

// Wire the window to the bus and the page. render(view) draws one of:
// { state: 'estimate', ...describe() } | { state: 'none', name } | { state: 'error', message }.
export function startEstimate({ client, fetch, render }) {
  let seq = 0
  async function show(inv) {
    const target = inv && inv.target
    const mmsi = mmsiFromTarget(target)
    const name = target && target.name
    const mine = ++seq
    if (!mmsi) return render({ state: 'none', name })
    try {
      const f = await loadEstimate(fetch, mmsi)
      if (mine !== seq) return // a newer target arrived meanwhile
      render(f ? Object.assign({ state: 'estimate' }, describe(f, name)) : { state: 'none', name: name || mmsi })
    } catch (err) {
      if (mine === seq) render({ state: 'error', message: err.message })
    }
  }
  const ctx = client.context || {}
  show(ctx.invocation)
  // A window that stays open hears later choices of the action as events.
  return client.subscribe(['action.invoked'], (_name, inv) => show(inv))
}
