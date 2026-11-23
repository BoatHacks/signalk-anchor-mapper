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
 │  └───────────┘──▶ resource provider: plotterExtensions (manifest) │
 └───────────────────────────────────▲───────────────────────────────┘
                                     │ HTTP (resources, tracks)
              ┌──────────────────────┴───────────────────┐
       ┌──────┴──────┐                          ┌────────┴────────────┐
       │  Webapp     │ Leaflet + OSM/OpenSeaMap │ Freeboard-SK ≥ 3.4  │
       └─────────────┘                          │ runtime iframe ──▶  │
          both use public/shapes.js             │ overlay.setData     │
                                                └─────────────────────┘
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

### 2.8 Seeder (`src/seed.js`) **(1.0.0)**
On `start`, ask the server's Track API for every other vessel's track over the
history window and merge it with the TrackStore's live fixes by time
(`TrackStore.seed`; a live fix wins over history within the thinning interval).
Not cut at the first live fix: on subscribe the server replays cached values, and
a position restored at server start (`signalk-questdb.restore`) can be hours older
than the history. Then run one analysis cycle immediately. No range filter, the
same as live tracking. Does not block `start`: runs async, waits up to 3 minutes
for a tracks plugin that registers after us, then gives up quietly; the plugin
status says whether history was seeded. The Track API takes Temporal values; the
seeder uses the server's polyfill and, if it cannot find one, sends plain
epoch-millisecond instants without a resolution and lets the TrackStore thin.
Rejected: the v1 HTTP route (needs the port and a token under security, and
tracks plugins before 3.0 kept tracks in memory, empty after a restart anyway).

### 2.9 AlertMonitor (`src/alerts.js`)
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
estimates' bounds; with neither, the world. It draws circles, ellipses (via `shapes.js`), the own
anchor circle, a legend and tags, and fetches one vessel's
track from the tracks plugin on demand. Plain ES2015 with no optional chaining,
because some chart plotter browsers are old. Leaflet is vendored; tiles come from the
internet.

### 2.11 Shapes (`public/shapes.js`)
Pure functions shared by the webapp, the Freeboard extension and the tests: circle
and ellipse polygons (same projection as `src/geo.js`), the colour per tag/alert
(`styleOf`, day and night palettes), and `toOverlayFeatures`, which turns the
`anchored-vessels` resources into the overlay's FeatureCollection (a Polygon
`<mmsi>:shape` and a Point `<mmsi>:anchor` per vessel). A classic ES2015 script:
`window.AnchorShapes` in a browser, `module.exports` under Node.

### 2.12 Freeboard-SK extension (`src/plotterext.js`, `public/plotterext/`)
`buildManifest(version)` is the Plotter Extensions API manifest, served by a second
read-only resource provider (type `plotterExtensions`) while the plugin runs. The
pages are served by the webapp mount at `/signalk-anchor-mapper/plotterext/`:
- `style.json`: MapLibre v8 style, one inline `geojson` source `estimates`, seven
  layers using only what Freeboard draws (checked by `test/plotterext.test.js`).
- `runtime.html` / `runtime.js`: background iframe. Fetches the resources every
  60 s, sends `overlay.setData` when they changed, recolours with
  `overlay.setLayer` on `nightMode.changed`, logs Freeboard's `skippedLayers`.
- `estimate.html` / `estimate.js`: details window for the `details`
  (overlay feature) and `vessel` (AIS vessel) actions.
- `vendor/signalk-plotterext-bus/`: the bus client (MIT, 0.27.0), vendored.
These files are ES modules (`public/plotterext/package.json` says so for Node); they
only ever run inside Freeboard.

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

// AlertMonitor state per vessel
AlertState = { overlap, dragging /* last notification value sent, or null = normal */,
               outside /* consecutive outside fixes */, frozen /* { center, radiusM } */,
               last /* last fix */, holdUntil }
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
| Freeboard layer | Plotter Extensions API v1 data overlay; `signalk-plotterext-bus` 0.27.0 vendored | Vector shapes on the plotter most SignalK users run; no build step, no npm dependency |
| Map tiles | OpenStreetMap + OpenSeaMap seamarks | Free, show buoys and harbours |

## 5. Integration Points

| System | Direction | Contract |
|---|---|---|
| SignalK subscriptions | in | `vessels.*`: `navigation.position`, `navigation.headingTrue` (10 s period); self: `navigation.anchor.*` (own anchor) |
| SignalK deltas (`app.handleMessage`) | out | `navigation.anchor.{position,maxRadius,estimate}` on other vessels; notifications on self |
| `app.getPath` | in | vessel `name` for display and alert messages |
| Resource provider API (v2) | out | `anchored-vessels`, read only; `plotterExtensions` (manifest), read only |
| Freeboard-SK ≥ 3.4 | out | Plotter Extensions API v1: `overlays.data`, `background.iframe`, optional `actions`, `actions.overlay`, `windows`, `nightMode` |
| Tracks plugin | in, optional | Webapp: `GET /signalk/v1/api/vessels/<id>/track`. Seeder: in process through the server's Track API (server ≥ 2.33, `@signalk/tracks-plugin` ≥ 3 as provider): `(await app.getTrackApi()).getTracks({ from, to, resolution: PT30S, times: true })`, one FeatureCollection of every vessel, `MultiLineString` in [lon, lat] with `properties.coordTimes` |
| SignalK REST (v1) | in, webapp | `GET /signalk/v1/api/vessels/self/navigation/position` for the start view and own-vessel marker; `.../self/navigation/anchor` for the own anchor circle |
| Tile servers | webapp only | `tile.openstreetmap.org`, `tiles.openseamap.org` |

## 6. Security Considerations

- **Inputs are untrusted radio data.** AIS positions can be spoofed or garbage. Every
  value is checked with `Number.isFinite` before use; spikes are filtered; per-vessel
  errors are caught. A malicious AIS sender can at most create a false estimate or a
  false alert about itself.
- **Read-only surface.** Both resource providers refuse writes. No plugin HTTP routes.
  Resource reads follow the server's own access settings. The Freeboard extension
  pages are static files on the webapp mount; they read only the same resources,
  with the user's own session.
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
  alerts.js           overlap and drag state machine
  publish.js          (1.0.0, extracted) deltas and resource provider
  plotterext.js       Freeboard-SK extension manifest
public/
  index.html, app.js  webapp
  shapes.js           shapes and colours shared by webapp, extension and tests
  plotterext/         Freeboard-SK extension: style, runtime, details window, vendored bus
  vendor/leaflet/
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
- **Detector tuning per region.** Thresholds were validated on one coast; if beta
  testers in other waters need different values, expose them as advanced settings
  rather than forking constants.
