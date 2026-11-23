# Plans for 1.0.0

One plan per item in SPEC.md §10.2, in suggested order. Follow
[IMPLEMENTATION_CHECKLIST.md](../../IMPLEMENTATION_CHECKLIST.md) for each.

| # | Plan | Depends on | Status |
|---|---|---|---|
| 1 | [Extract publisher and resource provider](01-extract-publisher.md) | — | todo |
| 2 | [Overlap and drag alerts](02-alerts.md) | 1 | todo |
| 3 | [Seed tracks from the tracks plugin](03-seed-tracks.md) | — | built 2026-11-19; Pi check 2026-11-23 found a seeding gap, fixed in 6f2544d (unreleased) |
| 4 | [Webapp start view for any user](04-webapp-start-view.md) | — | built (own anchor circle via plan 7); Pi check open |
| 5 | [Two-week live validation](05-live-validation.md) | 2, 3, 4, 7 | todo |
| 6 | [Release 1.0.0](06-release.md) | 5 | todo |
| 7 | [Anchor circles in Freeboard and the webapp](07-map-output.md) | 1 (soft), 2 for alert colours | built 2026-11-19; alert colours wait on 2; Pi check done 2026-11-23 |
