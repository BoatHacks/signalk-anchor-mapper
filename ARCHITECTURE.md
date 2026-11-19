# Anchor Mapper Architecture

> How the plugin is built. For what it must do and why, see [SPEC.md](SPEC.md).
> This describes the 1.0.0 target; parts not built yet are marked **(1.0.0, to build)**.

## 1. Overview

A single SignalK Server plugin, plain Node.js with no runtime dependencies, plus a
buildless static webapp. The detection logic is pure functions over arrays of
fixes, so it is tested without a server. A thin plugin shell does all SignalK I/O.

```
                 SignalK server
 ┌───────────────────────────────────────────────────────────────────┐
 │  AIS deltas (vessels.*)          own vessel (anchor.*)            │
 │        │                               │                          │
 │        ▼                               ▼                          │
 │  ┌───────────┐   seed on start  ┌──────────────┐                  │
 │  │TrackStore │◀──────────────── │ Seeder       │◀── tracks plugin │
 │  └─────┬─────┘                  └──────────────┘    (HTTP)        │
 │        │ every N min                  │ every fix                 │
 │        ▼                              ▼                           │
 │  ┌───────────┐  estimates   ┌──────────────────┐                  │
 │  │ Detector  │────────────▶ │ AlertMonitor     │──▶ notifications │
 │  │+RepeatUse │              │ (overlap, drag)  │                  │
 │  └─────┬─────┘              └──────────────────┘                  │
 │        ▼                                                          │
 │  ┌───────────┐──▶ deltas: navigation.anchor.* on other vessels    │
 │  │ Publisher │──▶ resource provider: anchored-vessels (GeoJSON)   │
 │  └───────────┘                                                    │
 └───────────────────────────────────▲───────────────────────────────┘
                                     │ HTTP (resources, tracks)
                              ┌──────┴──────┐
                              │  Webapp     │  Leaflet + OSM/OpenSeaMap tiles
                              └─────────────┘
```

## 2. System Components

### 2.1 Plugin shell (`index.js`)
Owns the SignalK lifecycle: config schema, `start`/`stop`, subscriptions, the
analysis timer, and wiring the components below. Pairs each position with a heading
received within 60 s. Catches and logs every per-vessel error so one bad vessel never
stops the cycle. Today it also holds the publisher and resource provider; those
should move to their own modules as alerts are added, to keep the shell thin.

### 2.2 TrackStore (`src/store.js`)
Bounded in-memory history per vessel context: at most one fix per 30 s, dropped
after the history window. Ignores out-of-order fixes. Has no I/O.

### 2.3 Detector (`src/detector.js`)
Pure functions. `analyzeTrack(fixes, opts)` returns episodes with a verdict
(`still`, `anchor`, `anchor-area`, ...), method, quality, tags, swing radius, area
ellipse. Internally: spike removal → episode split → dense-core trim → heading-ray
intersection → ring fit with arc and ring-ratio gates → area ellipse. Constants in
`DEFAULTS`, overridable per call (the shell passes only the user-tunable ones).

### 2.4 RepeatUse (`src/repeat-use.js`)
Pure. Adds `possible-mooring-buoy` to estimates near ≥ 2 other vessels' long stays.

### 2.5 Geo helpers (`src/geo.js`)
Local equirectangular projection to metres, distance, median, percentile. Accurate
enough at anchorage scale (< 1 km).

### 2.6 Publisher (in `index.js`, to extract)
Turns the cycle's estimates into deltas on each vessel's context and nulls out
vessels that dropped out. Keeps the current estimate map for the resource provider
and the alert monitor.

### 2.7 Resource provider (in `index.js`, to extract)
Read-only `anchored-vessels` resource type serving GeoJSON Features from the current
estimate map.

### 2.8 Seeder (`src/seed.js`) **(1.0.0, to build)**
On `start`, if the tracks plugin answers, fetch recent tracks for vessels in range
and push them into the TrackStore, then run one analysis cycle immediately. Must not
block `start`: runs async, logs and gives up quietly if the tracks plugin is absent
or slow, and sets the plugin status to say whether seeding happened.

### 2.9 AlertMonitor (`src/alerts.js`) **(1.0.0, to build)**
Pure state machine plus a small adapter that emits notifications. Inputs: the current
estimates, the own anchor (`navigation.anchor.position`/`maxRadius` on self), and
each new fix of an estimated vessel. Keeps per-vessel state (`normal`/`active`,
consecutive outside-fix count, hold timer). Overlap is evaluated per analysis cycle
and when the own anchor changes; dragging is evaluated on every fix (SPEC §2.7).
Emits deltas on `notifications.anchorMapper.{overlap,dragging}.<mmsi>` on self.

### 2.10 Webapp (`public/`)
Static Leaflet page served by the SignalK webapp mechanism. Polls the own
`navigation.position` (`/signalk/v1/api/vessels/self/navigation/position`) and the
resource provider every 60 s. Start view: own vessel at zoom 14; without it, the
estimates' bounds; with neither, the world. It draws circles, ellipses and tags, and fetches one vessel's
track from the tracks plugin on demand. Plain ES2015 with no optional chaining,
because some chart plotter browsers are old. Leaflet is vendored; tiles come from the
internet.

## 3. Data Models

```js
// TrackStore entry
Fix = { t /* s */, lat, lon, heading? /* rad true */ }

// Detector output per episode (subset used downstream)
Episode = {
  t0, t1, ongoing, verdict: 'still'|'anchor'|'anchor-area'|...,
  method: 'headings'|'ring', quality: 'strong'|'weak', tags: string[],
  center: { latitude, longitude }, swingRadiusM, area: { center, semiMajorM, semiMinorM, bearingDeg },
  centroid
}

// Shell's per-vessel estimate (SPEC §4)
Estimate = { context, id /* mmsi */, kind: 'anchor'|'area', method, quality, tags,
             since, dwellHours, center, radiusM?, arcDeg?, area? }

// AlertMonitor state per vessel (1.0.0)
AlertState = { overlap: 'normal'|'active', dragging: 'normal'|'active',
               outsideCount, holdUntil }
```

## 4. Technology Stack

| Area | Choice | Why |
|---|---|---|
| Runtime | Node.js ≥ 18 | SignalK server's floor |
| Language | Plain CommonJS JavaScript | No build step, matches most SignalK plugins |
| Runtime dependencies | none | Small install on a Pi, nothing to audit or break |
| Tests | `node:test`, synthetic tracks | Built in, no dev dependencies |
| CI | SignalK `plugin-ci.yml` reusable workflow | Same checks the registry scores |
| Webapp | Leaflet 1.x, vendored | Works without a CDN on board |
| Map tiles | OpenStreetMap + OpenSeaMap seamarks | Free, show buoys and harbours |

## 5. Integration Points

| System | Direction | Contract |
|---|---|---|
| SignalK subscriptions | in | `vessels.*`: `navigation.position`, `navigation.headingTrue` (10 s period); self: `navigation.anchor.position`, `navigation.anchor.maxRadius` (1.0.0) |
| SignalK deltas (`app.handleMessage`) | out | `navigation.anchor.{position,maxRadius,estimate}` on other vessels; notifications on self (1.0.0) |
| `app.getPath` | in | vessel `name` for display and alert messages |
| Resource provider API (v2) | out | `anchored-vessels`, read only |
| Tracks plugin | in, optional | Webapp: `GET /signalk/v1/api/vessels/<id>/track`. Seeder: bulk fetch of recent tracks; exact endpoint and how a plugin reaches it from inside the server to be confirmed when building (§9) |
| SignalK REST (v1) | in, webapp | `GET /signalk/v1/api/vessels/self/navigation/position` for the start view and own-vessel marker |
| Tile servers | webapp only | `tile.openstreetmap.org`, `tiles.openseamap.org` |

## 6. Security Considerations

- **Inputs are untrusted radio data.** AIS positions can be spoofed or garbage. Every
  value is checked with `Number.isFinite` before use; spikes are filtered; per-vessel
  errors are caught. A malicious AIS sender can at most create a false estimate or a
  false alert about itself.
- **Read-only surface.** The resource provider refuses writes. No plugin HTTP routes.
  Resource reads follow the server's own access settings.
- **No outbound traffic from the plugin.** The seeder talks only to the local
  server. Only the webapp's browser fetches tiles.
- **Alerts are advisory.** The notification text says it is an estimate; the plugin
  must never be the only anchor watch.
- **Privacy.** The live picture is in memory only. The post-1.0 atlas will keep MMSIs
  indefinitely (SPEC §12); its storage stays local.

## 7. File Structure

```
index.js              plugin shell
src/
  detector.js         episode detection and anchor location (pure)
  repeat-use.js       possible-mooring-buoy tag (pure)
  store.js            in-memory track buffer
  geo.js              projection and stats helpers
  seed.js             (1.0.0) seed tracks from the tracks plugin
  alerts.js           (1.0.0) overlap and drag state machine
  publish.js          (1.0.0, extracted) deltas and resource provider
public/               webapp (index.html, app.js, vendor/leaflet)
test/                 node:test suites, one per src module plus plugin.test.js
docs/VALIDATION.md    measurements behind every threshold
SPEC.md, ARCHITECTURE.md, CHANGELOG.md, README.md
```

## 8. Deployment

- Installed from the SignalK app store (npm package `signalk-anchor-mapper`), or
  `npm install` into `~/.signalk/node_modules` for development.
- Configured in the admin UI (SPEC §9). No files on disk in 1.0.0.
- Optional companion: the SignalK tracks plugin, for restart seeding and track lines.
- Released with the BoatHacks plugin release procedure (npm OIDC trusted publishing
  from GitHub Actions). Until 1.0.0, commits go straight to `main`.
- Memory: about 12 h × 120 fixes/h × vessel count; a few hundred vessels is a few MB.

## 9. Future Considerations

- **Atlas (post-1.0).** Records will need the plugin data directory
  (`app.getDataDirPath()`), an append-friendly format (JSON lines per month is
  enough at this volume), and a read API. Keeping estimates as plain objects with a
  stable shape now makes recording them later trivial.
- **Seeder endpoint.** If the tracks plugin has no bulk endpoint, fall back to
  per-vessel requests for vessels known from the server's current data model.
- **Detector tuning per region.** Thresholds were validated on one coast; if beta
  testers in other waters need different values, expose them as advanced settings
  rather than forking constants.
