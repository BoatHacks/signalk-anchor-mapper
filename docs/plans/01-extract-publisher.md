# Plan: Extract publisher and resource provider

## Overview
Move delta publishing and the `anchored-vessels` resource provider out of
`index.js`, so the alert monitor can be added without the shell growing further.
Pure refactor: no behaviour change.

## SPEC / ARCHITECTURE sections
- SPEC §6.1, §6.2
- ARCHITECTURE §2.1, §2.6, §2.7, §7

## Approach
`src/publish.js` exports `createPublisher(app, pluginId)` returning
`{ publish(list), current(), clearAll() }` and `toFeature(app, estimate)`.
`index.js` keeps the subscription, timer and analysis loop and calls into it. The
current-estimate map lives in the publisher so the alert monitor can read it.

## Test strategy
Existing `test/plugin.test.js` must pass unchanged; that is the regression check.
Add `test/publish.test.js` for: anchor → area degradation nulls position and radius
in the same delta; vessel dropping out gets all three paths nulled once.

## Steps
- [ ] Create `src/publish.js`, move `publish`, `delta`, `toFeature`, `registerResources`
- [ ] Wire from `index.js`
- [ ] Add `test/publish.test.js`
- [ ] `npm test`

## Files
Create `src/publish.js`, `test/publish.test.js`. Modify `index.js`.
