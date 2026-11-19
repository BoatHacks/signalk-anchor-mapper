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

Decided with Tobi on 2026-11-19, on top of the SPEC text:
- drag needs 90 s outside over at least 2 fixes, not 3 fixes (class A at anchor and
  class B below 2 kn report about every 3 min);
- once a vessel has a fix outside, its anchor and radius are frozen for the check, so a
  refit with a bigger radius cannot cancel a real drag (episode gate is 250 m);
- departure filter: a fix moving faster than 3 kn, or bow-first above 1 kn, is a boat
  leaving; the 3 kn is tuned on recorded data before release;
- sound alarm only within two swing radii of the own anchor, else a silent `warn`;
- after replaying 25 days of recorded AIS (22 drag alarms, most false): an alarm needs
  10 m of movement while outside, a boat still outside for 30 min has settled and its
  alarm ends, and a departure ends an active alarm;
- tagged boats can raise overlap warnings but never drag alarms; weak never alerts
  unless "alert on doubtful estimates" is on;
- wording short, no disclaimer on the alert (advisory note in the README);
- `plugin.stop` sets every active alert to normal and clears the published paths
  (plan 1 landed first, `src/publish.js`).

Rejected: evaluating drag only per analysis cycle (up to 5 min late for the one
alert where minutes matter).

Overlap with an area estimate uses the ellipse semi-major axis as the radius
(over-warns rather than under-warns).

## Test strategy
Unit tests in `test/alerts.test.js`:
- circles just apart / just overlapping / overlap within margin
- no own anchor → no overlap alerts; own anchor cleared → alerts cleared
- drag: one outside fix no alarm; two fixes 90 s apart raise; back inside by > half margin clears
- frozen reference; departing boats (fast, bow-first) do not alarm; sound only near the own anchor
- weak, `possibly-moored`, `possible-mooring-buoy` estimates never alarm by default;
  do alarm with "alert on doubtful estimates" on
- hold time after the estimate disappears
- flapping at the boundary does not toggle
Plugin test: notification delta shape and path, `state`/`method`, message names
the vessel.

## Steps
- [x] Confirm notification value shape against the SignalK spec (`state`, `method`, `message`)
- [x] `src/alerts.js` + tests
- [x] Config schema: the six alert settings from SPEC §9
- [x] Wire into `index.js` (self subscription, per-fix hook, per-cycle hook)
- [x] Put the active alerts on each `anchored-vessels` feature as `alerts: ['overlap'|'dragging']`.
      The map side is ready (plan 7): `styleOf` in `public/shapes.js` already colours
      them orange/red in the webapp and the Freeboard layer; add a test there.
- [x] README section on alerts, including "advisory, not an anchor watch"
- [x] `npm test`
- [ ] Replay recorded AIS history (tinarasia) to tune the departure filter; results into docs/VALIDATION.md

## Files
Create `src/alerts.js`, `test/alerts.test.js`. Modify `index.js`,
`test/plugin.test.js`, README.md, CHANGELOG.md.
