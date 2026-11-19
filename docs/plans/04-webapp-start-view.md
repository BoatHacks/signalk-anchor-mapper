# Plan: Webapp start view for any user

## Overview
The webapp opens at a fixed position on the Spanish coast (`public/app.js`,
`setView([40.6, 0.6], 11)`). For a plugin meant for anyone it must open where the
user is.

## SPEC / ARCHITECTURE sections
- SPEC §1.1 (audience), §7
- ARCHITECTURE §2.10, §9

## Approach
On load, fetch `/signalk/v1/api/vessels/self/navigation/position`; centre there at
zoom 14. If that fails, fit the bounds of the estimates on first data (existing
`fitted` logic). Only if both are empty, show the whole world at a low zoom with a
"no position yet" note. Also draw the own anchor circle when set, so overlaps are
visible.

## Test strategy
Manual in a browser: with own position, without own position but with estimates,
with neither. Check an old MFD-class browser still parses (ES2015, no optional chaining).

Decided 2026-11-19 (Tobi): the map always starts on the own vessel. The estimate
auto-fit only runs when there is no own position, so it never pulls the view away
from the boat. A position that shows up after load still centres the map once,
unless the user has already panned or clicked a row. The own position is fetched
before the estimates on every refresh, which also moves the own-vessel marker.

## Steps
- [x] Remove the hard-coded centre
- [x] Self position → estimates bounds → world fallback (checked headless with mocked
      endpoints: self+estimates, estimates only, neither, late fix, late fix after pan)
- [x] Own-vessel marker
- [x] Own anchor circle (built with plan 7: `/signalk/v1/api/vessels/self/navigation/anchor`,
      drawn in the own-vessel colour)
- [ ] Manual check on the Pi, screenshot for README/registry

## Files
Modify `public/app.js`, possibly `public/index.html`, README.md.
