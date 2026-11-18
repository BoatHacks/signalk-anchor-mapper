# Plan: Seed tracks from the tracks plugin

## Overview
After a server restart, fill the TrackStore from the SignalK tracks plugin so
estimates and alerts resume within one cycle instead of after the 2 h dwell.

## SPEC / ARCHITECTURE sections
- SPEC §8, §5 (tracks plugin row), §12 (restart recovery decision)
- ARCHITECTURE §2.8, §5 (tracks plugin row), §9 (seeder endpoint)

## Approach
First, **confirm the tracks plugin API** from its source: is there a bulk endpoint
for all vessels' tracks, or only `/signalk/v1/api/vessels/<id>/track`? How far back
and at what resolution does it keep data? How can a plugin call it from inside the
server (local HTTP with the server's port, or a shared API)?

Then `src/seed.js`: `seed(app, store, { maxAgeS })`, async, started from `start()`
without awaiting. Converts track points to fixes (position only), inserts them
oldest first, then triggers one analysis. On any failure: log once, set status
"no track history; estimates need <dwell> to build up", and return.

Rejected: own snapshot to disk (Tobi chose the tracks plugin, SPEC §12).

## Test strategy
Unit: track-response → fixes conversion, including GeoJSON coordinate order and
missing timestamps. Plugin: with a stubbed fetch, an anchored vessel is published
right after start; with fetch failing, start still succeeds and status says so.
Manual: restart the Pi server mid-anchorage and time until the first estimate.

## Steps
- [ ] Read the tracks plugin source; record the endpoint and limits here
- [ ] `src/seed.js` + tests
- [ ] Call from `start()`; analysis after seeding
- [ ] Plugin status and README note for users without the tracks plugin
- [ ] `npm test`

## Files
Create `src/seed.js`, `test/seed.test.js`. Modify `index.js`, README.md, CHANGELOG.md,
ARCHITECTURE.md §5 (the confirmed endpoint).
