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

**Audience:** any SignalK user. 1.0.0 is published on npm and the SignalK plugin
registry, so defaults, documentation and failure modes must work for setups unlike
the author's: other regions and AIS densities, servers without own wind instruments
or without the tracks plugin, and small hardware such as a Raspberry Pi.

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
| **Fix** | One position report of a vessel, with time and, when known, true heading and SOG. |
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
| **Wind hint** | A low-weight bearing towards the likely anchor side, derived from the wind (§2.5). |
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

### 2.5 Wind is a hint, never a locator
A yacht at anchor points roughly into the wind, but in testing heading differed from
harbor wind by a median 65 to 68° and from gridded model wind by 35 to 40°. That
moves an implied anchor as far as the swing circle itself. So wind is used only:
- for ship types 36 and 37, at reported SOG ≤ 0.5 kn or no SOG;
- as a bearing (`anchorBearingDegrees`) on area estimates, weighted 0.1 per wind
  sample against 1 per heading;
- as an agreement check on placed anchors (`anchorAgreement`, tag `wind-disagrees`).

### 2.6 Doubt is flagged, not hidden
| Tag | Rule |
|---|---|
| `possibly-moored` | Swing radius under 15 m. Indistinguishable from a berth or mooring ball. |
| `possible-mooring-buoy` | ≥ 2 other vessels have had long stays within 100 m of this spot. |
| `wind-disagrees` | Mean cosine between boat→anchor and towards-the-wind is below 0. |
| quality `weak` | Plausible but noisy ring, or heading rays missing by > 15 % of the distance. |

There are no harbor or marina polygons; berthed boats fall out as "still" or tagged.

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
- Tracks older than the history window (default 12 h) drop off; a vessel with no
  fixes left disappears.

## 4. Data Model

**Fix**: `t` (s), `lat`, `lon`, optional `heading` (rad true), optional `sog` (m/s),
optional `windFrom` (rad true, added for wind-hint vessels).

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
| `windHint` | object or null | object or null | §2.5 |

## 5. Sources / Inputs

| Input | From | Used for | If missing |
|---|---|---|---|
| `navigation.position` | every other vessel (AIS) | everything | vessel not tracked |
| `navigation.headingTrue` | other vessels, mostly class A | heading rays, wind hint | ring fit or area only |
| `navigation.speedOverGround` | other vessels | wind hint gating | fixes treated as "no SOG" (eligible) |
| `design.aisShipType` | other vessels | wind hint eligibility | no wind hint |
| `environment.wind.directionTrue`, or `angleTrueGround`/`angleTrueWater` + own heading | own vessel | wind hint | no wind hint (`windHint: null`) |
| Tracks plugin API | optional | track lines in the webapp | no track lines |

Heading and SOG are paired with a position only if they are within 60 s of it.

## 6. API Specification

### 6.1 SignalK data (deltas)
On each anchored vessel's own context (`vessels.urn:mrn:imo:mmsi:<mmsi>`):
- `navigation.anchor.position` — `{ latitude, longitude }` or `null`
- `navigation.anchor.maxRadius` — metres or `null`
- `navigation.anchor.estimate` — the estimate object from §4 (minus position and
  radius), plus `source: "signalk-anchor-mapper"` and a human-readable `note`; `null`
  when cleared.

Published once per analysis cycle (default 5 min).

### 6.2 Resource provider
Read-only resource type `anchored-vessels`, at
`/signalk/v2/api/resources/anchored-vessels[/<mmsi>]`. Each resource is a GeoJSON
Feature: a Point at the anchor (or area centre), with properties `context`, `mmsi`,
`name`, `kind`, `method`, `radiusMeters`, `area`, `windHint`, `quality`, `tags`,
`since`, `dwellHours`. Writes are refused. Resource providers are chosen over plugin
routes because they are readable under the server's read-only access setting.

### 6.3 Plugin status
`N anchored, M area only, from K tracked`.

## 7. User Interface

A buildless webapp (listed in the SignalK webapp menu):
- OpenStreetMap base map with the OpenSeaMap seamark overlay.
- Each anchor estimate as a circle of its swing radius; each area estimate as its
  ellipse with the anchor-bearing hint.
- The vessel's recent track, when the tracks plugin is installed.
- Tags and quality listed per vessel, so doubtful estimates are visibly doubtful.

Constraint: works on the boat without internet for everything except map tiles.

## 8. Persistence

Currently nothing persists; tracks and own-vessel wind are in memory and a restart
needs the full dwell time before the first estimate. **(open, §13)**

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
| Wind source | `self` (or `none`) |
| Wind hint weight | 0.1 (0 = off) |
| Wind hint max SOG | 0.5 kn |

Fixed (detector constants, validated and not exposed): radius gate, gap limit, spike
filter, still threshold, arc and ring-ratio gates, heading-ray thresholds, repeat-use
radius and count.

## 10. MVP Scope

### 10.1 Done (0.1.0)
- Episode detection, heading-ray / ring / area classification, tags.
- Deltas on other vessels' contexts, read-only GeoJSON resource provider.
- Wind hint from own wind instruments, pluggable wind source.
- Leaflet webapp.
- Offline validation against recorded AIS.

### 10.2 Needed for 1.0.0 **(open, §13)**

### 10.3 Post-1.0 / deferred **(open, §13)**

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
- **Wind never places an anchor.** Mixing wind rays into the heading intersection at
  9 % weight with a 65° bias moved the anchor 65 m. Bias is undetectable by the
  miss/ahead checks. Hence bearing hint and agreement check only.
- **Tags instead of suppression.** Doubtful cases are published and flagged so the
  user can judge; two config switches hide them for those who prefer.
- **No harbor polygons.** They'd need per-region data; "still" + tags removes all but
  one harbor false positive in testing.
- **Reuse `navigation.anchor.*` on other vessels.** Existing clients draw them for free.
- **Resource provider over plugin routes** for anonymous read access.
- **No runtime dependencies**, plain Node, buildless webapp: runs on a Pi, easy to audit.
- **Written for any SignalK user (decided 2026-11-18).** The plugin is published,
  not a personal tool, so nothing may assume the author's boat, region or data.
- **Single-pass dense-core trim.** Iterating collapses a ring onto its densest arc.

## 13. Open Questions

1. Live only, or also an accumulated atlas of anchoring spots?
2. Should anything relate others' swing circles to the own vessel (overlap, dragging)?
3. What must 1.0.0 include? Candidates: restart persistence / seeding from history,
   gridded wind source, drag detection, npm publish.
4. Live validation: the detector has only been run offline; how much live testing
   counts as enough for 1.0.0?
