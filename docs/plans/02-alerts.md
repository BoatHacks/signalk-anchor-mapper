# Plan: Overlap and drag alerts

## Overview
Warn when another boat's swing circle overlaps the own one, and alarm when a boat
appears to drag its anchor (SPEC §2.7). Delivered as SignalK notifications on self.

## SPEC / ARCHITECTURE sections
- SPEC §1.3 (terms), §2.7, §3.1, §5 (own anchor input), §6.1 (notification paths), §9 (config)
- ARCHITECTURE §2.9, §3 (`AlertState`), §5

## Approach
`src/alerts.js`: a pure `AlertMonitor` with
- `setOwnAnchor({ position, radiusM } | null)`
- `onCycle(estimates, nowS)` → overlap evaluation
- `onFix(context, fix)` → drag evaluation for vessels with a strong, untagged anchor
- each returns a list of `{ path, value }` notification changes (raise or clear)

The shell subscribes to self `navigation.anchor.position` and `maxRadius`, feeds
the monitor, and sends the returned changes with `app.handleMessage`. Hysteresis is
half the margin; a dragging alert holds 10 min after the estimate is cleared.

Rejected: evaluating drag only per analysis cycle (up to 5 min late for the one
alert where minutes matter).

Overlap with an area estimate uses the ellipse semi-major axis as the radius
(over-warns rather than under-warns).

## Test strategy
Unit tests in `test/alerts.test.js`:
- circles just apart / just overlapping / overlap within margin
- no own anchor → no overlap alerts; own anchor cleared → alerts cleared
- drag: 2 outside fixes no alarm, 3rd raises; back inside by > half margin clears
- weak, `possibly-moored`, `possible-mooring-buoy` estimates never alarm by default;
  do alarm with "alert on doubtful estimates" on
- hold time after the estimate disappears
- flapping at the boundary does not toggle
Plugin test: notification delta shape and path, `state`/`method`, message names
the vessel.

## Steps
- [ ] Confirm notification value shape against the SignalK spec (`state`, `method`, `message`)
- [ ] `src/alerts.js` + tests
- [ ] Config schema: the six alert settings from SPEC §9
- [ ] Wire into `index.js` (self subscription, per-fix hook, per-cycle hook)
- [ ] Put the active alerts on each `anchored-vessels` feature as `alerts: ['overlap'|'dragging']`.
      The map side is ready (plan 7): `styleOf` in `public/shapes.js` already colours
      them orange/red in the webapp and the Freeboard layer; add a test there.
- [ ] README section on alerts, including "advisory, not an anchor watch"
- [ ] `npm test`

## Files
Create `src/alerts.js`, `test/alerts.test.js`. Modify `index.js`,
`test/plugin.test.js`, README.md, CHANGELOG.md.
