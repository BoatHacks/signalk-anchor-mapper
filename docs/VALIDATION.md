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

## Pitfalls found

- Approach and departure tracks pulled into an episode distort the circle fit badly and can make a berth look like a 250 m swing. The dense-core trim fixes this. It must be a single pass: iterating collapses a ring onto its densest arc.
- A covariance ellipse over the raw points is meaningless for ring-shaped tracks.
- Moored cargo ships at one fixed spot sit within 5 m for days. That is "still", not an anchor, and needs no special handling.
