# Offline validation of the detection heuristic

The algorithm was prototyped against about 1.9 million recorded AIS fixes (493 vessels, 25 Oct to 18 Nov 2026) from a SignalK server on the Spanish Mediterranean coast. This note records what was measured so the thresholds are not magic numbers.

## Ground truth

Class A transmitters report `navigation.state` ("anchored", "moored", ...). Class B transmitters do not, so there is no ground truth for yachts. Verification of yacht estimates was visual (track plots) only.

## Results

Episodes of at least 2 h, harbor boxes not excluded unless stated.

- **Ground-truth anchored ships:** 6 of 7 long episodes are detected as anchors. The miss has too little arc coverage. Where heading data exists (class A), the bow points at the fitted anchor to within about 6 to 19 degrees.
- **Berthed boats:** most stationary harbor episodes have under 8 m of spread and are classed "still". Of 220 harbor episodes, 33 had a fit that passed the ring test. After the two tags, 1 remained untagged.
- **Tags:** none of the 6 ground-truth anchored ship episodes receives either tag.
- **Anchor stability:** split-half estimates of the anchor centre differ by 1 to 10 m for small-swing yachts, and up to 150 m for a cargo ship whose swing was only partly captured.

## Threshold choices

| Parameter | Value | Why |
|---|---|---|
| Radius gate | 250 m | Wide enough for ship swings, tight enough to reject slow sailing and drifting |
| Minimum dwell | 2 h (1 h used for 6 h windows) | Shorter stays are mostly slow sailing or drift |
| Core spread for "swing" | 8 m | Below this, fix jitter at a berth |
| Arc coverage | 150 degrees | A shorter arc fixes the centre poorly |
| Tight swing tag | 15 m | At 12 m three harbor false positives remained, at 15 m one. At 20 m more real small-yacht anchorings were tagged for no further gain. |
| Ring ratio | 4 | The fitted radius must span at least 4 residual widths, else the track is a blob or a short arc and only the area is reported |
| Heading rays | 85% ahead, miss at most 40% of distance | Rays must meet convincingly. 0.4 rather than 0.3 so a ship sheering widely over 40 h still gets an anchor, with no new harbor false positives |
| Repeat-use radius, count | 100 m, 2 other vessels | Cleanly separates berths and buoys from free anchorages in the test data |

## Narrow swing sectors (correction)

A circle fitted to the track alone is unreliable when the vessel sits in a narrow band, which is what an anchored ship does in steady wind. One cargo ship stayed 23 h in a band about 50 degrees wide on a roughly 120 m rode. The first trimmed circle fit gave a radius of 32 m with a centre about 120 m off, understating the swing radius by a factor of 4. A bare "arc coverage" figure did not catch this: measured around the fitted centre, any blob scores high coverage.

Using the bow headings instead, the lines along the headings meet within about 11 m (median miss) of one point, with the anchor ahead of the bow in 100% of the fixes, giving a distance of about 116 m and a 95th percentile of about 126 m. For the ships that do swing through most of a circle, the heading based anchor and the circle fit agreed to 11 to 62 m. Hence the current design: headings first, ring fit only when the radius is at least 4 residual widths, otherwise report the occupied area.

## Heading versus wind (negative result)

Idea tested: a boat at anchor lies head to wind, so for class B yachts without a usable heading, the wind direction could stand in for the bow heading and point from the boat to its anchor.

Two anchored test vessels, called A and B here, were compared against two wind sources. The figure is the median absolute difference between the vessel's heading and the direction the wind came from.

| Wind source | Vessel A and B, median difference |
|---|---|
| Wind measured in the harbor | about 65 to 68 degrees |
| Open-Meteo 10 m wind, hourly, 0.05 degree grid | about 35 to 40 degrees |

The modelled wind agrees better than the local harbor measurement, probably because a harbor sensor is sheltered and deflected by buildings and masts, but even the better figure is far too loose. At a typical 30 to 50 m rode, a 35 to 40 degree error moves the implied anchor by roughly 17 to 32 m sideways, which is as large as the swing circle itself. Current, tide, gusts, sheering on the chain and wind shifts within the hour all pull the bow away from the wind direction.

Conclusion: heading into wind alone cannot place an anchor. Wind direction may still help as one weak signal combined with others (track shape, the occupied area, repeat use of the spot by other vessels), for example to choose which end of a narrow band the anchor is likely to be on, but it must not be used to derive an anchor point on its own. A weak bearing hint was built and tested (below), then removed.

### Wind as a weak bearing hint (built, then removed)

A synthetic sweep (120 m rode, 10 seeds, 50 and 120 degree swing sectors) confirmed it:

- Wind rays alone, unbiased with 10 degrees of scatter: anchor 12 to 50 m off. With a 30 degree bias: 60 to 70 m off at every scatter level. The miss and ahead checks cannot detect a bias.
- Wind rays mixed into the bow-heading intersection at only 9% of the weight, with a 65 degree bias, moved the anchor 65 m. In a narrow sector the heading rays are nearly parallel, so the intersection is weakly fixed along one axis and a skewed ray decides it.

So the wind only contributes a bearing (where the anchor probably lies) and an agreement check on anchors placed by other methods, with a default weight of 0.1 per wind sample against 1 per heading.

### Check against recorded AIS (2026-11-18)

The hint at 8da227f was run over the recorded data (1.95 M fixes, 818 vessels, 25 Oct to 18 Nov 2026) with the own vessel's harbor wind (AdvancedWind `directionTrue`, mean apparent 2.6 m/s, 0.5 to 20 km from the targets).

- 32 episodes from type 36/37 vessels got a hint (14 anchor, 18 area). Verdicts, centres, areas and radii were identical with `windWeight` 0.1 and 0.
- Wind-only bearing vs the bearing from the episode centroid to the placed anchor: median error 56 degrees (n=13), 33 degrees with steadiness at least 0.5 (n=7), 61 degrees below that (n=6). Random bearings would give 90. Two cases were almost exactly reversed.
- Median `anchorAgreement` over the 14 anchors: 0.29. `wind-disagrees` fired twice, both just below 0 on tight possibly-moored fits.
- 24 of the 32 hinted episodes were tagged possibly-moored, mostly berthed boats inside the harbor, and multi-day stays averaged the wind down to a steadiness of 0.2 to 0.4.

Changes tried after this: no hint for possibly-moored swings, wind taken from the last 6 h of a stay only, and no hint below a steadiness of 0.5.

**Decision (2026-11-18): the wind hint was removed.** It stayed too weak on recorded data to be worth its configuration and output fields, so the plugin uses no wind data. The code is in history at 8da227f and 90f25b7 if a gridded source (35 to 40 degrees offline) is ever worth a retry.

### Drag alerts replayed on recorded AIS (2026-11-19)

The alert monitor was replayed over the same recorded data (2.0 M fixes, 824 vessels, 25 Oct to 19 Nov 2026): every 5 minutes the anchor analysis on each vessel's last 12 h, every fix fed to the monitor, no own anchor set. Four runs, each after a fix:

| Run | Logic | Drag alarms | Vessels | Time with an alarm up |
|---|---|---|---|---|
| 1 | 90 s outside, 2 fixes, departure filter 3 kn / bow-first | 22 | 9 | about 158 h (longest 88 h) |
| 2 | plus 10 m movement, settle after 30 min, departure ends an alarm | 25 | 8 | 46 h (longest 16 h) |
| 3 | movement by half-run means (15 m), settled-before rule, silence after a departure | 12 | 7 | 21 h |
| 4 | rest in the band needs 3x movement, silence by estimate centre | 11 | 7 | 21 h |

Run 4 classified: 5 real departures, 5 repositionings, 1 doubtful slow creep (215621000, about 100 m over hours), 0 false. 19 of 26 days had no drag alarm.

- **Departure filter.** At 3 kn it removed 3 alarms, all real departures; 2 kn changed nothing; 4 and 5 kn let one 12 m yacht leaving without heading through. 3 kn stays.
- **False alarms in run 1** were small pleasure boats (16 to 27 m circles) resting just outside the circle for hours, a cargo ship hovering at the margin, and a stale circle on a ship that had moved. They are what the movement, settle and rest rules target.
- **Departure re-alarms.** After a departure the old estimate lingers up to one cycle and re-raised the alarm 2 to 3 times; the plugin now stays quiet until the estimate ends or its centre moves 50 m. Not by `since`, which slides for stays longer than the 12 h history.
- **Synthetic drags** (0.3 and 1 kn, 20 m and 120 m circles): 1.5 to 3 min after crossing the margin without a rest; with a 40 min rest in the band a 1 kn drag alarms after 3 min and a 0.3 kn drag after 9 min at 30 s reports (6 min at the 3 min class B rate). A rest followed by jitter of up to 20 m never alarmed; at 25 m, 1 of 5 seeds did.
- **Known misses:** a drag slower than about 10 m in 30 min, and a slow drag after a long rest, are late or missed. Accepted for 1.0.0; the live run on one server is the real test, and any false drag alarm there still blocks the release.

## Pitfalls found

- Approach and departure tracks pulled into an episode distort the circle fit badly and can make a berth look like a 250 m swing. The dense-core trim fixes this. It must be a single pass: iterating collapses a ring onto its densest arc.
- A covariance ellipse over the raw points is meaningless for ring-shaped tracks.
- Moored cargo ships at one fixed spot sit within 5 m for days. That is "still", not an anchor, and needs no special handling.
