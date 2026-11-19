'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { AlertMonitor } = require('../src/alerts')
const { makeProjection } = require('../src/geo')

const proj = makeProjection(40.6, 0.6)
const at = (x, y) => proj.toLatLon(x, y)
const own = (x, y, r) => ({ ...at(x, y), radiusM: r })

function est(id, x, y, r, extra = {}) {
  return {
    id,
    context: `vessels.urn:mrn:imo:mmsi:${id}`,
    kind: 'anchor',
    quality: 'strong',
    tags: [],
    center: at(x, y),
    radiusM: r,
    ...extra
  }
}

const fix = (t, x, y, extra = {}) => ({ t, ...at(x, y), ...extra })
const last = (changes, kind) => changes.filter((c) => c.path.includes(`.${kind}.`)).pop()

// --- overlap ---------------------------------------------------------------

test('overlap: circles just apart stay quiet, just overlapping warn', () => {
  const m = new AlertMonitor({})
  m.setOwnAnchor(own(0, 0, 30), 0)
  // 100 m apart, radii 30 + 50 = 80, margin 10: gap 20 -> quiet
  assert.deepStrictEqual(m.onCycle([est('1', 100, 0, 50)], 0), [])
  // 85 m apart: gap 5 < margin 10 -> warn (within margin, not yet overlapping)
  const near = m.onCycle([est('1', 85, 0, 50)], 0)
  assert.strictEqual(near.length, 1)
  assert.strictEqual(near[0].path, 'notifications.anchorMapper.overlap.1')
  assert.strictEqual(near[0].value.state, 'warn')
  assert.deepStrictEqual(near[0].value.method, ['visual'])
  assert.match(near[0].value.message, /MMSI 1/)
  // 70 m apart: real overlap, same alert, message changes
  const over = m.onCycle([est('1', 70, 0, 50)], 0)
  assert.match(over[0].value.message, /overlap/)
  assert.deepStrictEqual(m.alertsOf('1'), ['overlap'])
})

test('overlap: hysteresis keeps the alert until the gap exceeds 1.5 x margin', () => {
  const m = new AlertMonitor({})
  m.setOwnAnchor(own(0, 0, 30), 0)
  m.onCycle([est('1', 85, 0, 50)], 0) // gap 5: warn
  const stay = m.onCycle([est('1', 92, 0, 50)], 0) // gap 12, inside 15: stays (message may refresh)
  assert.ok(stay.every((c) => c.value.state === 'warn'))
  assert.deepStrictEqual(m.alertsOf('1'), ['overlap'])
  const cleared = m.onCycle([est('1', 96, 0, 50)], 0) // gap 16 > 15: clears
  assert.strictEqual(cleared[0].value.state, 'normal')
  assert.deepStrictEqual(m.alertsOf('1'), [])
})

test('overlap: no own anchor means no alerts, clearing the own anchor clears them', () => {
  const m = new AlertMonitor({})
  assert.deepStrictEqual(m.onCycle([est('1', 50, 0, 50)], 0), [])
  const set = m.setOwnAnchor(own(0, 0, 30), 0)
  assert.strictEqual(set[0].value.state, 'warn')
  const gone = m.setOwnAnchor(null, 0)
  assert.strictEqual(gone[0].value.state, 'normal')
})

test('overlap: an area estimate uses its semi-major axis', () => {
  const m = new AlertMonitor({})
  m.setOwnAnchor(own(0, 0, 30), 0)
  const area = { id: '2', kind: 'area', quality: 'strong', tags: [], center: at(120, 0), area: { semiMajorM: 100, semiMinorM: 40 } }
  assert.strictEqual(m.onCycle([area], 0)[0].value.state, 'warn') // 120 < 30 + 100 + 10
})

test('overlap: the estimate disappearing clears the alert', () => {
  const m = new AlertMonitor({})
  m.setOwnAnchor(own(0, 0, 30), 0)
  m.onCycle([est('1', 70, 0, 50)], 0)
  assert.strictEqual(m.onCycle([], 300)[0].value.state, 'normal')
})

test('overlap: switched off, nothing is raised', () => {
  const m = new AlertMonitor({ overlapEnabled: false })
  m.setOwnAnchor(own(0, 0, 30), 0)
  assert.deepStrictEqual(m.onCycle([est('1', 70, 0, 50)], 0), [])
})

test('doubtful estimates: weak never alerts by default; tags still overlap but never drag', () => {
  const m = new AlertMonitor({})
  m.setOwnAnchor(own(0, 0, 30), 0)
  assert.deepStrictEqual(m.onCycle([est('1', 70, 0, 50, { quality: 'weak' })], 0), [])
  const moored = est('2', 70, 0, 50, { tags: ['possibly-moored'] })
  assert.strictEqual(m.onCycle([moored], 0)[0].value.state, 'warn')
  const buoy = est('3', 400, 0, 20, { tags: ['possible-mooring-buoy'] })
  m.onCycle([buoy], 0)
  let out = []
  for (let i = 0; i < 6; i++) out = out.concat(m.onFix('3', fix(i * 60, 480, 0), i * 60))
  assert.deepStrictEqual(out, [])
  // with doubtful estimates on, a weak one alerts
  const d = new AlertMonitor({ alertDoubtful: true })
  d.setOwnAnchor(own(0, 0, 30), 0)
  assert.strictEqual(d.onCycle([est('1', 70, 0, 50, { quality: 'weak' })], 0)[0].value.state, 'warn')
})

// --- drag ------------------------------------------------------------------

// Vessel 7 at anchor at (500, 0), radius 40, margin 20: outside beyond 60 m from it.
function setup(options = {}, ownAnchor = null) {
  const m = new AlertMonitor(options)
  if (ownAnchor) m.setOwnAnchor(ownAnchor, 0)
  m.onCycle([est('7', 500, 0, 40)], 0)
  return m
}

test('drag: fixes inside the circle plus margin never alarm', () => {
  const m = setup()
  let out = []
  for (let i = 0; i < 20; i++) out = out.concat(m.onFix('7', fix(i * 180, 500 + 55, 0), i * 180))
  assert.deepStrictEqual(out, [])
})

test('drag: one outside fix is not enough, a second 90 s later raises', () => {
  const m = setup()
  assert.deepStrictEqual(m.onFix('7', fix(0, 500 + 70, 0), 0), []) // 30 m outside, 1st
  assert.deepStrictEqual(m.onFix('7', fix(60, 500 + 75, 0), 60), []) // 2 fixes but only 60 s
  const out = m.onFix('7', fix(120, 500 + 90, 0), 120)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].path, 'notifications.anchorMapper.dragging.7')
  assert.match(out[0].value.message, /Possible drag: MMSI 7 is \d+ m outside its swing circle/)
  assert.deepStrictEqual(m.alertsOf('7'), ['dragging'])
})

test('drag: at the 3 minute AIS rate two fixes are enough', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  assert.strictEqual(m.onFix('7', fix(180, 500 + 90, 0), 180)[0].value.state, 'warn')
})

test('drag: repeated or stale fixes do not add up', () => {
  const m = setup()
  m.onFix('7', fix(100, 500 + 70, 0), 100)
  assert.deepStrictEqual(m.onFix('7', fix(100, 500 + 70, 0), 300), [])
  assert.deepStrictEqual(m.onFix('7', fix(90, 500 + 70, 0), 300), [])
})

test('drag: a fix back inside resets the count', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  m.onFix('7', fix(60, 500 + 30, 0), 60) // back inside
  assert.deepStrictEqual(m.onFix('7', fix(150, 500 + 72, 0), 150), []) // counting restarts
})

test('drag: sound alarm only near the own anchor, otherwise a silent warning', () => {
  // own anchor at the origin, radius 100: loud within 200 m of the drifting boat
  const loud = setup({}, own(0, 0, 100))
  loud.estimates.set('7', est('7', 250, 0, 40)) // vessel anchored 250 m away, drifts toward us
  loud.onFix('7', fix(0, 250 - 70, 0), 0)
  const a = loud.onFix('7', fix(180, 250 - 90, 0), 180)
  assert.strictEqual(a[0].value.state, 'alarm')
  assert.deepStrictEqual(a[0].value.method, ['visual', 'sound'])
  // far from the own anchor: warn without sound
  const quiet = setup({}, own(0, 0, 100))
  quiet.onFix('7', fix(0, 570, 0), 0)
  const b = quiet.onFix('7', fix(180, 590, 0), 180)
  assert.strictEqual(b[0].value.state, 'warn')
  assert.deepStrictEqual(b[0].value.method, ['visual'])
  // no own anchor at all: warn
  const none = setup()
  none.onFix('7', fix(0, 570, 0), 0)
  assert.strictEqual(none.onFix('7', fix(180, 590, 0), 180)[0].value.state, 'warn')
})

test('drag: back inside by more than half the margin clears, in the band it stays', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  m.onFix('7', fix(180, 500 + 90, 0), 180) // raised
  assert.deepStrictEqual(m.onFix('7', fix(360, 500 + 55, 0), 360), []) // 15 m outside the circle > margin/2 = 10: stays
  const out = m.onFix('7', fix(540, 500 + 45, 0), 540) // 5 m outside <= 10: clears
  assert.strictEqual(out[0].value.state, 'normal')
  assert.deepStrictEqual(m.alertsOf('7'), [])
})

test('drag: a refit with a bigger radius cannot cancel the alarm (frozen reference)', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  m.onFix('7', fix(180, 500 + 90, 0), 180) // raised against 40 m
  m.onCycle([est('7', 500, 0, 120)], 300) // next cycle refits a big circle around the drift
  const out = m.onFix('7', fix(360, 500 + 90, 0), 360)
  assert.deepStrictEqual(m.alertsOf('7'), ['dragging'])
  assert.ok(out.length === 0 || out[0].value.state !== 'normal')
})

test('drag: the alert holds 10 minutes after the estimate is gone, then clears', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  m.onFix('7', fix(180, 500 + 90, 0), 180)
  assert.deepStrictEqual(m.onCycle([], 300), []) // estimate gone, hold starts
  assert.deepStrictEqual(m.alertsOf('7'), ['dragging'])
  assert.deepStrictEqual(m.onCycle([], 300 + 599), [])
  assert.strictEqual(m.onCycle([], 300 + 600)[0].value.state, 'normal')
})

test('drag: a boat leaving, fast or bow-first, does not alarm', () => {
  const fast = setup()
  // 70 m outside, then 200 m in 60 s = 6.5 kn
  fast.onFix('7', fix(0, 500 + 70, 0), 0)
  assert.deepStrictEqual(fast.onFix('7', fix(60, 500 + 270, 0), 60), [])
  assert.deepStrictEqual(fast.onFix('7', fix(120, 500 + 470, 0), 120), [])
  assert.deepStrictEqual(fast.alertsOf('7'), [])
  // bow-first at ~2 kn heading east (pi/2), moving east
  const slow = setup()
  slow.onFix('7', fix(0, 500 + 70, 0, { heading: Math.PI / 2 }), 0)
  let out = []
  for (let i = 1; i <= 6; i++) out = out.concat(slow.onFix('7', fix(i * 60, 500 + 70 + i * 60, 0, { heading: Math.PI / 2 }), i * 60))
  assert.deepStrictEqual(out, [])
  // the same speed stern-first (heading west) is a drag
  const back = setup()
  back.onFix('7', fix(0, 500 + 70, 0, { heading: -Math.PI / 2 }), 0)
  out = []
  for (let i = 1; i <= 6; i++) out = out.concat(back.onFix('7', fix(i * 60, 500 + 70 + i * 40, 0, { heading: -Math.PI / 2 }), i * 60))
  assert.ok(out.some((c) => c.value.state === 'warn'))
})

test('drag: flapping at the boundary does not toggle the alert', () => {
  const m = setup()
  let out = []
  let t = 0
  const next = (x) => out.push(...m.onFix('7', fix((t += 180), 500 + x, 0), t))
  next(70) // outside, counting
  next(85) // raised
  for (let i = 0; i < 10; i++) next(i % 2 ? 62 : 68) // wobble 22-28 m outside, margin band
  assert.strictEqual(out.filter((c) => c.value.state === 'normal').length, 0)
})

test('drag: drag alerts off, nothing is raised', () => {
  const m = setup({ dragEnabled: false })
  m.onFix('7', fix(0, 570, 0), 0)
  assert.deepStrictEqual(m.onFix('7', fix(180, 590, 0), 180), [])
})

test('area estimates are never drag-checked', () => {
  const m = new AlertMonitor({})
  m.onCycle([{ id: '9', kind: 'area', quality: 'strong', tags: [], center: at(500, 0), area: { semiMajorM: 40, semiMinorM: 20 } }], 0)
  m.onFix('9', fix(0, 700, 0), 0)
  assert.deepStrictEqual(m.onFix('9', fix(180, 710, 0), 180), [])
})

test('clearAll sets every active alert back to normal', () => {
  const m = setup({}, own(500, 0, 100))
  m.onCycle([est('7', 500, 0, 40), est('8', 560, 0, 40)], 0)
  m.onFix('7', fix(0, 570, 0), 0)
  m.onFix('7', fix(180, 590, 0), 180)
  const out = m.clearAll()
  assert.ok(out.length >= 2)
  assert.ok(out.every((c) => c.value.state === 'normal'))
  assert.deepStrictEqual(m.alertsOf('7'), [])
})

test('drag: a boat sitting still outside its circle is not dragging', () => {
  const m = setup()
  let out = []
  for (let i = 0; i < 30; i++) out = out.concat(m.onFix('7', fix(i * 180, 500 + 75 + (i % 2), 0), i * 180))
  assert.deepStrictEqual(out, [])
  assert.deepStrictEqual(m.alertsOf('7'), [])
})

test('drag: an alarm ends when the boat has settled still outside for 30 minutes', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  m.onFix('7', fix(180, 500 + 90, 0), 180) // raised: drifting
  assert.deepStrictEqual(m.alertsOf('7'), ['dragging'])
  let out = []
  // then it stays put at 100 m for well over 30 min
  for (let i = 1; i <= 14; i++) out = out.concat(m.onFix('7', fix(180 + i * 180, 500 + 100 + (i % 2), 0), 180 + i * 180))
  assert.ok(out.some((c) => c.value.state === 'normal'), 'alarm cleared')
  assert.deepStrictEqual(m.alertsOf('7'), [])
  // and it does not come back while it sits there
  out = []
  for (let i = 15; i <= 30; i++) out = out.concat(m.onFix('7', fix(180 + i * 180, 500 + 100 + (i % 2), 0), 180 + i * 180))
  assert.deepStrictEqual(out, [])
})

test('drag: a boat that leaves while an alarm is up ends the alarm', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  m.onFix('7', fix(180, 500 + 90, 0), 180)
  const out = m.onFix('7', fix(240, 500 + 285, 0), 240) // 200 m in 60 s
  assert.strictEqual(out[0].value.state, 'normal')
  assert.deepStrictEqual(m.alertsOf('7'), [])
})

test('drag: GPS jitter outside the circle is not movement outward', () => {
  const m = setup()
  let out = []
  const xs = [66, 80, 64, 82, 62, 84, 66, 80, 64, 82, 66, 80]
  xs.forEach((x, i) => (out = out.concat(m.onFix('7', fix(i * 180, 500 + x, 0), i * 180))))
  assert.deepStrictEqual(out, [])
})

test('drag: a boat that sat beyond the circle for 30 minutes before crossing the margin needs a clear move', () => {
  const m = setup()
  let out = []
  // 45 min in the band (10 to 20 m outside the circle), then a small step across the margin
  for (let i = 0; i < 15; i++) out = out.concat(m.onFix('7', fix(i * 180, 500 + 54, 0), i * 180))
  out = out.concat(m.onFix('7', fix(15 * 180, 500 + 70, 0), 15 * 180))
  out = out.concat(m.onFix('7', fix(16 * 180, 500 + 90, 0), 16 * 180))
  assert.deepStrictEqual(out, [])
})

test('drag: a real drag after a long rest in the band still alarms', () => {
  const m = setup()
  let out = []
  for (let i = 0; i < 15; i++) out = out.concat(m.onFix('7', fix(i * 180, 500 + 54, 0), i * 180)) // resting
  // then drifts away at about 9 m/min (0.3 kn)
  for (let i = 1; i <= 12; i++) out = out.concat(m.onFix('7', fix((14 + i) * 180, 500 + 54 + i * 27, 0), (14 + i) * 180))
  const raised = out.find((c) => c.value.state !== 'normal')
  assert.ok(raised, 'alarm raised')
  assert.ok(out.indexOf(raised) < 8 * 1, 'within a few reports of crossing')
})

test('drag: after a departure the vessel stays quiet while its estimate lingers, and speaks again for a new one', () => {
  const m = setup()
  m.onFix('7', fix(0, 500 + 70, 0), 0)
  m.onFix('7', fix(180, 500 + 90, 0), 180) // raised
  m.onFix('7', fix(240, 500 + 290, 0), 240) // leaves fast: alarm ends
  // the stale estimate lingers; slow fixes out in the open must not re-raise
  let out = []
  for (let i = 1; i <= 6; i++) out = out.concat(m.onFix('7', fix(240 + i * 180, 500 + 300 + i * 30, 0), 240 + i * 180))
  assert.deepStrictEqual(out, [])
  // a new estimate (a new stay) starts afresh
  m.onCycle([est('7', 900, 0, 40)], 2000)
  m.onFix('7', fix(3000, 900 + 70, 0), 3000)
  assert.strictEqual(m.onFix('7', fix(3180, 900 + 90, 0), 3180)[0].value.state, 'warn')
})
