# Plan: Release 1.0.0

## Overview
Publish 1.0.0 to npm and the SignalK plugin registry once plan 5 passes.

## SPEC / ARCHITECTURE sections
- SPEC §1.1, §10.2
- ARCHITECTURE §8

## Approach
Follow the BoatHacks plugin release procedure (npm OIDC trusted publishing from
GitHub Actions; first publish of a new package needs the trusted-publisher setup).
Check the registry score criteria beforehand (screenshots, changelog, CI).

## Steps
- [ ] README: privacy note is not needed yet (atlas is post-1.0); alerts are advisory;
      tracks plugin recommended
- [ ] Screenshots for README and registry
- [ ] CHANGELOG 1.0.0 section
- [ ] Release workflow and npm trusted publisher
- [ ] Tag and publish; confirm it appears in the app store
- [ ] After release: go back to branch + PR workflow (standing rule ends at 1.0.0)

## Files
package.json, CHANGELOG.md, README.md, .github/workflows/.
