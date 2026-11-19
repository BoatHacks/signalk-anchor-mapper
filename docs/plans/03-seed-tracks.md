# Plan: Seed tracks from the tracks plugin

## Overview
After a server restart, fill the TrackStore from the SignalK tracks plugin so
estimates and alerts resume within one cycle instead of after the 2 h dwell.

## SPEC / ARCHITECTURE sections
- SPEC §8, §5 (tracks plugin row), §12 (restart recovery decision)
- ARCHITECTURE §2.8, §5 (tracks plugin row), §9 (seeder endpoint)

## Approach
Confirmed 2026-11-19 from @signalk/tracks-plugin 3.9.1 and signalk-server 2.37.0
(details in ARCHITECTURE §2.8 and §5): the tracks plugin (3.0+) keeps AIS tracks in
SQLite (7 days by default, 10 s resolution) and is the provider for the server's
Track API (2.33+). A plugin reaches it in process with `app.getTrackApi()`;
`getTracks({ from, to, resolution, times: true })` returns every vessel in one
FeatureCollection. Tracks plugin 2.x and earlier kept tracks in memory only and
have no Track API (checked 2.1.0), so there is nothing to seed from there.

Then `src/seed.js`: `seed(app, store, { historyS })`, async, started from `start()`
without awaiting. Converts track points to fixes (position only), puts them in
front of any live fixes (`TrackStore.seed`), then triggers one analysis. Waits up
to 3 min for a tracks plugin that starts after us. Decided with Tobi 2026-11-19: whole history
window, no range filter, thinned to 30 s by the provider. On any failure: log once, set status
"no track history; estimates need <dwell> to build up", and return.

Rejected: own snapshot to disk (Tobi chose the tracks plugin, SPEC §12); the v1
HTTP route `/signalk/v1/api/tracks` (needs port and token, and pre-3.0 tracks
plugins held tracks in memory only, checked in 2.1.0).

## Test strategy
Unit: track-response → fixes conversion, including GeoJSON coordinate order and
missing timestamps. Plugin: with a stubbed fetch, an anchored vessel is published
right after start; with fetch failing, start still succeeds and status says so.
Manual: restart the Pi server mid-anchorage and time until the first estimate.

## Steps
- [x] Read the tracks plugin source; record the endpoint and limits here
- [x] `src/seed.js` + tests
- [x] Call from `start()`; analysis after seeding
- [x] Plugin status and README note for users without the tracks plugin
- [x] `npm test`
- [x] Real server check: signalk-server 2.37.0 + tracks plugin 3.9.1, 5 h swing fed,
      server restarted without the feed; estimate (70 m) published within 5 s
- [ ] Pi: restart tinarasia mid-anchorage and time until the first estimate

## Files
Create `src/seed.js`, `test/seed.test.js`. Modify `index.js`, `src/store.js`, README.md, CHANGELOG.md,
ARCHITECTURE.md §5 (the confirmed endpoint).
