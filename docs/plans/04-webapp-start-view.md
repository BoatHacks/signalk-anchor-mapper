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

## Steps
- [ ] Remove the hard-coded centre
- [ ] Self position → estimates bounds → world fallback
- [ ] Own anchor circle
- [ ] Manual check, screenshot for README/registry

## Files
Modify `public/app.js`, possibly `public/index.html`, README.md.
