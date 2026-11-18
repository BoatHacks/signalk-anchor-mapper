# Anchor Mapper Specification

> Status: draft, written from the 0.1.0 code and docs/VALIDATION.md. Sections marked
> **(open)** wait on decisions listed in §13.

## 1. Introduction

### 1.1 Purpose

Anchor Mapper is a SignalK Server plugin that works out where **other vessels** are
anchored from their AIS position reports. For each vessel that has been lying to a
fixed point it estimates the anchor position and swing radius, publishes them as
SignalK data on that vessel's context, and draws them on a chart.

The point is situational awareness at anchor: when you arrive in an anchorage, or
when someone anchors near you, you want to know where their anchor is and how much
room they swing through, which their AIS position alone does not tell you.

When the own vessel is at anchor too, the plugin relates the others to it: it warns
when another boat's swing circle overlaps the own one, and when another boat appears
to be dragging its anchor.

After 1.0.0 it is planned to also build an **anchoring atlas**: every anchoring it has observed is
kept, so the user can see where boats anchor in a bay, how much room they take, and
when, including in places they are visiting for the first time after having been in
AIS range of them before.

**Audience:** any SignalK user. 1.0.0 is published on npm and the SignalK plugin
registry, so defaults, documentation and failure modes must work for setups unlike
the author's: other regions and AIS densities, servers without the tracks plugin, and small hardware such as a Raspberry Pi.

### 1.2 Background

- **AIS** (ITU-R M.1371) gives position, and for class A transmitters also true
  heading and a navigational status ("at anchor", "moored", ...). Class B
  transmitters, which most yachts carry, send no navigational status and usually no
  heading. Ship type codes 36 (sailing) and 37 (pleasure craft) identify yachts.
- **SignalK** defines `navigation.anchor.position` and `navigation.anchor.maxRadius`
  for the own vessel's anchor watch. This plugin publishes the same paths on *other*
  vessels' contexts, so any client that already draws an own-vessel anchor circle can
  draw others' with no changes.
- Nobody transmits where their anchor is. Everything here is inferred from the track,
  and that inference was validated offline against about 1.9 million recorded fixes
  (see [docs/VALIDATION.md](docs/VALIDATION.md)).

### 1.3 Terminology

| Term | Meaning |
|---|---|
| **Fix** | One position report of a vessel, with time and, when known, true heading. |
| **Track** | The recent fixes of one vessel, thinned to at most one per 30 s. |
| **Stationary episode** | A maximal run of fixes that stays within the radius gate (250 m) of its running centroid with no reporting gap over 30 min. |
| **Dwell** | Duration of an episode. An episode only counts once it reaches the minimum dwell (default 2 h). |
| **Ongoing episode** | The episode the vessel is in now. Only ongoing episodes are published. |
| **Swing** | The movement of an anchored boat around its anchor as wind and current change. |
| **Swing radius** | 95th percentile distance of the vessel's fixes from the estimated anchor. Published as `maxRadius`. |
| **Still** | An episode whose core spread is under 8 m: a berth, a mooring line or GPS jitter. Not an anchor. |
| **Anchor estimate** | A result with a placed anchor point and swing radius (`kind: anchor`). |
| **Area estimate** | A result where the vessel clearly stays and swings but no anchor point can be placed; only the occupied area (an ellipse) is given (`kind: area`). |
| **Heading ray** | The line from a fix along the vessel's true heading. Bow points at anchor, so rays meet at the anchor. |
| **Ring fit** | A circle fitted to the track. Trusted only if the track covers a real ring (§2). |
| **Anchoring record** | One finished (or still ongoing) anchoring of one vessel, kept in the atlas (§4.2). |
| **Atlas** | The stored collection of anchoring records, on disk. |
| **Spot** | A cluster of anchoring records close together, derived from the atlas when it is viewed, not stored. |
| **Own anchor** | The own vessel's `navigation.anchor.position` and `maxRadius`, as set by an anchor alarm plugin or the user. |
| **Overlap** | Another vessel's swing circle (or occupied area) intersects the own swing circle, within a safety margin. |
| **Dragging** | A vessel with a placed anchor is seen persistently outside its estimated swing circle. |
| **Tag** | A flag on an estimate that names a known way it may be wrong (§2.6). |

## 2. Domain Rules

These come from how boats lie at anchor and from the limits of AIS, not from
implementation convenience. Thresholds are justified in docs/VALIDATION.md.

### 2.1 What counts as stationary
- A vessel is stationary while it stays within 250 m of its running centroid. Wider
  than the largest realistic ship swing would be slow sailing or drifting.
- A reporting gap over 30 min ends the episode; we can't know what happened in between.
- An isolated jump of over 100 m that returns is a bad fix and is dropped.
- Shorter than the minimum dwell (2 h) is mostly slow sailing or drift and is ignored.

### 2.2 Still versus swinging
- Under 8 m core spread is "still" (berth, mooring line, jitter) and is not published.

### 2.3 Locating the anchor, in order of preference
1. **Heading rays** (needs ≥ 30 fixes with heading, mostly class A). A boat lying to
   its anchor points its bow at it. The anchor must be ahead of the bow in ≥ 85 % of
   fixes, and the rays must miss the common point by at most 40 % of the distance.
   This works in a narrow swing band, the common case in steady wind.
2. **Ring fit.** Only if the arc covers ≥ 150° and the radius spans ≥ 4 residual
   widths. A circle fitted to a short arc or a blob is wrong, often by a factor of 4
   on the radius.
3. **Area only.** If neither works, report the occupied area and do **not** invent an
   anchor point or radius.

### 2.4 Never guess an anchor
Understating a swing radius is worse than reporting none: a skipper would anchor
inside someone's circle. When the evidence does not place the anchor, the plugin
says so (area estimate) rather than guessing.

### 2.5 Wind is not used
A yacht at anchor points roughly into the wind, so wind looks like a way to place
or orient anchors for boats without heading. It is not reliable enough: heading
differed from harbor wind by a median 65 to 68° and from gridded model wind by 35
to 40°, and even a gated bearing-only hint was off by a median 56° on recorded
data. The plugin uses no wind data (see §12 and docs/VALIDATION.md).

### 2.6 Doubt is flagged, not hidden
| Tag | Rule |
|---|---|
| `possibly-moored` | Swing radius under 15 m. Indistinguishable from a berth or mooring ball. |
| `possible-mooring-buoy` | ≥ 2 other vessels have had long stays within 100 m of this spot. |
| quality `weak` | Plausible but noisy ring, or heading rays missing by > 15 % of the distance. |

There are no harbor or marina polygons; berthed boats fall out as "still" or tagged.

### 2.7 Alerts about other vessels

- **Overlap** is only checked while the own anchor is set. Two placed anchors overlap
  when the distance between them is less than the sum of both swing radii plus a
  margin (default 10 m). For an area estimate, the ellipse's semi-major axis around
  its centre stands in for the circle; that over-warns rather than under-warns.
- **Dragging** is only checked for `anchor` estimates of quality `strong` without the
  `possibly-moored` or `possible-mooring-buoy` tags. A vessel counts as dragging when
  its last N fixes (default 3, about 90 s) are all more than its swing radius plus a
  margin (default 20 m, or 25 % of the radius if larger) from the anchor, while its
  estimate was published in the previous cycle. It is checked on every fix, not every
  analysis cycle, because a drag matters within minutes.
- Doubtful estimates do not raise alerts by default; better a missed warning about a
  shaky estimate than nightly false alarms that teach people to turn alerts off.
- Every alert clears itself when its condition stops holding, with hysteresis (half
  the margin) so it does not flap.

## 3. Estimate Lifecycle

Per vessel:

```
 (no track) ──fix──▶ tracking ──stays in gate──▶ episode (< min dwell)
                        ▲                              │ dwell ≥ min
                        │                              ▼
                 left gate / gap > 30 min ◀── classified: still │ anchor │ area │ not anchored
                        │                                         │      │
                        │                                         ▼      ▼
                        └──────────── cleared (paths set to null) ◀── published
```

- **Published** when the ongoing episode is classified `anchor` or `area` and passes
  the publish filters (§9). Re-evaluated every analysis cycle; method, radius and
  tags may change between cycles as the track grows.
- **Cleared** when a published vessel's ongoing episode ends or no longer qualifies:
  all three paths are set to `null`.
- An `anchor` result that degrades to `area` sets `position` and `maxRadius` to
  `null` in the same delta, so no client keeps a stale anchor.
- (Post-1.0, with the atlas.) When a published estimate ends, its final state is
  written to the atlas as an anchoring record (§4.2). Records are written for the
  ongoing estimate too, so a restart loses at most one analysis cycle of atlas data.
- Tracks older than the history window (default 12 h) drop off; a vessel with no
  fixes left disappears.

### 3.1 Alert lifecycle

Per other vessel and alert kind (`overlap`, `dragging`):
`normal → active → normal`. Active raises a SignalK notification; returning to
normal clears it. A dragging vessel's estimate is cleared when its episode ends, and
the dragging alert clears with it after a hold time (default 10 min) so it is seen.

## 4. Data Model

**Fix**: `t` (s), `lat`, `lon`, optional `heading` (rad true).

**Estimate** (one per anchored vessel, keyed by vessel context / MMSI):

| Field | Anchor | Area | Notes |
|---|---|---|---|
| `kind` | `anchor` | `area` | |
| `method` | `headings` or `ring` | `occupied-area` | |
| `position` | lat/lon | `null` | |
| `maxRadius` | m | `null` | 95th percentile |
| `quality` | `strong`/`weak` | `strong`/`weak` | |
| `tags` | list | list | §2.6 |
| `since` | ISO time | ISO time | start of episode |
| `dwellHours` | number | number | |
| `arcDegrees` | number or null | null | ring coverage |
| `area` | null | `{ center, semiMajorM, semiMinorM, bearingDeg }` | |

### 4.2 Anchoring record (atlas, post-1.0)

The estimate's final state, plus `end` time, vessel MMSI, AIS ship type and length
when known. Kept whatever its tags and quality, so the atlas view can filter rather
than the recorder deciding. Records keep the vessel's MMSI with no expiry, so the
atlas can answer "who anchored here" and show one vessel's history. The atlas stays
on the user's own server; the plugin never sends it anywhere.

### 4.3 Spot (derived, post-1.0)

Records whose anchors (or area centres) lie close together form a spot, with a
count, distinct vessels, typical and maximum swing radius, and the months it was
used. Computed on demand, so the clustering can change without rewriting data.

## 5. Sources / Inputs

| Input | From | Used for | If missing |
|---|---|---|---|
| `navigation.position` | every other vessel (AIS) | everything | vessel not tracked |
| `navigation.headingTrue` | other vessels, mostly class A | heading rays | ring fit or area only |
| `navigation.anchor.position`, `navigation.anchor.maxRadius` | own vessel (anchor alarm plugin or user) | overlap alerts | no overlap alerts |
| `navigation.position` | own vessel | display only | — |
| Tracks plugin API | optional | seeding tracks after a restart; track lines in the webapp | blind for up to the minimum dwell after a restart; no track lines |

Heading is paired with a position only if it is within 60 s of it.

## 6. API Specification

### 6.1 SignalK data (deltas)
On each anchored vessel's own context (`vessels.urn:mrn:imo:mmsi:<mmsi>`):
- `navigation.anchor.position` — `{ latitude, longitude }` or `null`
- `navigation.anchor.maxRadius` — metres or `null`
- `navigation.anchor.estimate` — the estimate object from §4 (minus position and
  radius), plus `source: "signalk-anchor-mapper"` and a human-readable `note`; `null`
  when cleared.

Published once per analysis cycle (default 5 min).

Notifications on the own vessel context:
- `notifications.anchorMapper.overlap.<mmsi>` — state `warn`, method `visual`
- `notifications.anchorMapper.dragging.<mmsi>` — state `alarm`, method `visual` and
  `sound`

The message names the vessel (AIS name, else MMSI) and the distance. Set to state
`normal` when cleared.

### 6.2 Resource provider
Read-only resource type `anchored-vessels`, at
`/signalk/v2/api/resources/anchored-vessels[/<mmsi>]`. Each resource is a GeoJSON
Feature: a Point at the anchor (or area centre), with properties `context`, `mmsi`,
`name`, `kind`, `method`, `radiusMeters`, `area`, `quality`, `tags`,
`since`, `dwellHours`. Writes are refused. Resource providers are chosen over plugin
routes because they are readable under the server's read-only access setting.

### 6.3 Atlas (post-1.0)
Read-only access to anchoring records, filterable by bounding box and time range,
and to spots computed from them. **(Shape to be fixed in ARCHITECTURE.md.)**

### 6.4 Plugin status
`N anchored, M area only, from K tracked`.

## 7. User Interface

A buildless webapp (listed in the SignalK webapp menu):
- OpenStreetMap base map with the OpenSeaMap seamark overlay.
- Each anchor estimate as a circle of its swing radius; each area estimate as its
  ellipse with the anchor-bearing hint.
- The vessel's recent track, when the tracks plugin is installed.
- Tags and quality listed per vessel, so doubtful estimates are visibly doubtful.

- (Post-1.0) An atlas view: spots in the visible area with their count, typical swing radius
  and months used, and the individual records behind a spot on demand. Tagged
  records (`possibly-moored`, `possible-mooring-buoy`) hidden by default.

Constraint: works on the boat without internet for everything except map tiles.

## 8. Persistence

- (Post-1.0) **The atlas persists** on disk in the plugin's data directory and must
  survive restarts and plugin upgrades.
- **Tracks are seeded on start** from the SignalK tracks plugin when it is installed:
  the plugin pulls the recent tracks of nearby vessels (up to the history window),
  so estimates and alerts resume within one analysis cycle instead of after the
  minimum dwell. The plugin keeps no track store of its own.
- Seeded fixes carry position only. Heading-ray estimates need fresh heading fixes
  (≥ 30) after a restart, so a class A ship may show as area or ring fit at first.
- Without the tracks plugin, a restart means no estimates and no alerts for up to
  the minimum dwell time. The README and plugin status must say so.

## 9. Configuration

User-tunable (admin UI):

| Setting | Default |
|---|---|
| Minimum time stationary | 120 min (min 20) |
| Analysis interval | 5 min |
| Track history kept | 12 h (2–72) |
| "Possibly moored" threshold | 15 m |
| Publish possibly moored estimates | on |
| Publish weak fits | on |
| Overlap alerts | on |
| Overlap margin | 10 m |
| Drag alerts | on |
| Drag margin | 20 m or 25 % of the radius |
| Drag fixes needed | 3 |
| Alert on doubtful estimates | off |

Fixed (detector constants, validated and not exposed): radius gate, gap limit, spike
filter, still threshold, arc and ring-ratio gates, heading-ray thresholds, repeat-use
radius and count.

## 10. MVP Scope

### 10.1 Done (0.1.0)
- Episode detection, heading-ray / ring / area classification, tags.
- Deltas on other vessels' contexts, read-only GeoJSON resource provider.
- Leaflet webapp.
- Offline validation against recorded AIS.

### 10.2 Needed for 1.0.0
- Overlap and drag alerts (§2.7, decided 2026-11-18).
- Seed tracks from the tracks plugin on start (§8, decided 2026-11-18).
- Published on npm and the SignalK plugin registry (§1.1).
- Wind hint removed from code, config and published data (§2.5).
- Further items **(open, §13)**.

### 10.3 Post-1.0 / deferred
- **Anchoring atlas** (§4.2, §4.3, §6.3): recording, persistence, read API, atlas
  view. Taken off the 1.0.0 roadmap on 2026-11-18 to keep 1.0.0 focused on the
  live picture; the design decisions for it below still stand.
- Further items **(open, §13)**.

## 11. References

- docs/VALIDATION.md — offline validation, threshold rationale, wind negative result
- SignalK specification, `navigation.anchor.*` paths
- ITU-R M.1371 — AIS message content, ship type codes
- OpenSeaMap, Leaflet

## 12. Design Decisions

- **Headings before circle fit.** A circle fitted to a narrow swing band understated
  one ship's radius by a factor of 4 (32 m vs about 120 m). Bow rays met within 11 m.
- **Area instead of a guess.** For class B yachts in a narrow band, an arc can't fix
  the circle. Reporting the area is honest; a guessed small radius is dangerous (§2.4).
- **No wind (decided 2026-11-18).** Wind as an anchor locator was rejected first:
  mixing wind rays into the heading intersection at 9 % weight with a 65° bias moved
  the anchor 65 m, and bias is undetectable by the miss/ahead checks. A weak bearing
  hint plus agreement check was then built (0.1.x), but on recorded data it was off
  by a median 56°, and 24 of 32 hinted episodes were berths. A gridded model wind
  source was considered and rejected with it. The hint is removed for 1.0.0; the
  experiment stays in docs/VALIDATION.md so nobody retries it unknowingly.
- **Tags instead of suppression.** Doubtful cases are published and flagged so the
  user can judge; two config switches hide them for those who prefer.
- **No harbor polygons.** They'd need per-region data; "still" + tags removes all but
  one harbor false positive in testing.
- **Reuse `navigation.anchor.*` on other vessels.** Existing clients draw them for free.
- **Resource provider over plugin routes** for anonymous read access.
- **No runtime dependencies**, plain Node, buildless webapp: runs on a Pi, easy to audit.
- **Written for any SignalK user (decided 2026-11-18).** The plugin is published,
  not a personal tool, so nothing may assume the author's boat, region or data.
- **Overlap and drag alerts in 1.0.0 (decided 2026-11-18)**, chosen over staying a
  pure observer. Alerts depend on detection being right, so they are restricted to
  strong untagged estimates by default, and drag is a separate, louder alert than
  overlap. Own anchor comes from the standard SignalK paths, so the plugin works
  next to any anchor alarm rather than replacing one.
- **Restart recovery via the tracks plugin (decided 2026-11-18)**, chosen over a
  snapshot of the plugin's own buffer. It reuses data most servers already record
  and adds no storage to this plugin. Cost: no recovery for users without the
  tracks plugin, and no headings in seeded data.
- **Atlas wanted, after 1.0.0 (decided 2026-11-18).** First put in 1.0.0, then moved
  to post-1.0 the same day. Known risk: detection errors become a permanent map. Mitigation: records keep their tags
  and quality and the view filters, so a bad record can be hidden or purged later.
- **Atlas keeps MMSI forever (decided 2026-11-18).** Considered anonymising after
  30 days or never storing MMSI; chosen to keep full per-vessel history. The atlas
  is therefore a long-term log of identifiable vessels' whereabouts, which the README
  must state plainly so installers can decide (data protection rules may apply to
  them). The data stays local and is never shared by the plugin.
- **Spots are derived, not stored**, so the clustering rule can change freely.
- **Single-pass dense-core trim.** Iterating collapses a ring onto its densest arc.

## 13. Open Questions

1. Live validation: the detector has only been run offline; how much live testing
   counts as enough for 1.0.0?
