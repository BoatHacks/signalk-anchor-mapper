# Plan: Two-week live validation

## Overview
Release gate for 1.0.0 (SPEC §10.2): run the finished plugin for at least 2 weeks on
the author's own server and record how it does.

## SPEC / ARCHITECTURE sections
- SPEC §10.2 (gate), §12 (decision)
- docs/VALIDATION.md (where results go)

## Approach
Install the build from `main` on the Pi. Log every published estimate and every
alert raise/clear (plugin debug log or a small script reading deltas). Weekly:
- class A vessels: our verdict vs their reported navigational status
- yachts: visual spot checks of a sample of estimates against track plots
- every overlap and drag alert: real or false, and why

## Pass criteria
- No unexplained false drag alarm (any one blocks release until explained and fixed).
- Class A agreement and false-positive rate no worse than the offline figures in
  VALIDATION.md.
- Seeding verified by at least one deliberate restart.

## Steps
- [ ] Install on the Pi, enable debug logging
- [ ] Week 1 review, fixes committed to main
- [ ] Week 2 review
- [ ] Results section in docs/VALIDATION.md (no MMSIs, names or own position)

## Files
Modify docs/VALIDATION.md; code fixes as found.
