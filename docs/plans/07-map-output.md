# Plan: Anchor circles on the chart (Freeboard-SK and the webapp)

## Overview
Show every published estimate as a vector shape on the user's chart plotter, not only
in our own webapp: a circle of the swing radius around a placed anchor, a dashed
ellipse for an area estimate, styled by quality and tags. Freeboard-SK is the target
plotter because it is the one most SignalK users run. The webapp gets the same
shapes and colours from shared code, so the two never disagree.

Researched 2026-11-19 against Freeboard-SK `master` (3.5.0-beta.2, d22ab98) and its
docs `docs/api/plotter-extensions-api.md` and
`docs/api/plotter_extension_provider_plugins.md`.

Decided 2026-11-19 (Tobi): part of 1.0.0, built before the two-week live
validation so the validation also covers the Freeboard layer.

## SPEC / ARCHITECTURE sections
- SPEC §1.2 (the "existing clients draw them for free" claim), §6.2, §7, §12
- ARCHITECTURE §2.7, §2.10, §5, §6, §7

## What Freeboard does today (verified in source)
- **Other vessels' `navigation.anchor.*` is not drawn.** The stream worker parses
  `navigation.anchor.position/maxRadius` into every vessel object
  (`skstream.worker.ts`, `processVessel`), but the only anchor layer is
  `layer-anchor-alarm`, fed from the own vessel (`selfAnchor`). So SPEC §1.2 and
  the §12 decision "existing clients draw them for free" are wrong for Freeboard.
  The deltas stay (they are the standard paths and other clients may use them).
- **Regions** (`layer-regions.component.ts`) draw any Polygon/MultiPolygon with a
  style picked by `feature.properties.skIcon` from a fixed preset list
  (`regionStyles` in `mapconfig.ts`: hazard, notice-to-mariners, ...) or one
  default magenta. The map refetches regions on start and after the user edits
  one; resource deltas only refresh the regions *list* while it is open.
- **Notes** are points with an icon, fetched by radius around the map centre above
  a minimum zoom. No shapes.
- **Plotter Extensions API** (Freeboard ≥ 3.4.0, Oct 2026). A plugin publishes a
  manifest as a `plotterExtensions` resource. Capability `overlays.data` lets it
  supply GeoJSON plus a MapLibre v8 style, and Freeboard draws it as a "Plugin
  layer" in the Chart List with its own show/hide, opacity and settings.
  `overlay.setData` replaces or upserts features live from a background iframe.
  `actions.overlay` makes features tappable with the plugin's own commands, and
  `actions` can add commands to AIS vessels (`{ kind: 'vessel', self: false }`).
  - Drawn layer types: `fill`, `line`, `circle`, `symbol` (text), on `geojson` or
    `vector` sources. Drawn properties include `fill-color/opacity`,
    `line-color/width/opacity/dasharray`, `circle-*`, `text-field/size/offset`
    (`DRAWN` in `plotterext/data-overlay-style.ts`). Anything else is skipped
    whole and reported in `overlay.list` → `skippedLayers`.
  - Band `aboveResources` sits above routes, waypoints, notes and regions; an
    overlay never covers the own vessel, AIS targets or alarms.
  - Manifests are read once when Freeboard connects (`PlotterExtService.init`),
    so enabling the plugin needs a Freeboard reload.
  - At most four plugin layers draw at once; extras are paused.
  - A server-relative URL is fetched with the user's credentials.

## Approach
**Chosen: a Freeboard data overlay driven by a background runtime.**

1. **Manifest.** `src/plotterext.js` exports a pure `buildManifest(version)`. The shell
   registers a second read-only resource provider, type `plotterExtensions`, key
   `signalk-anchor-mapper`, returning it while the plugin runs (same pattern and
   same refusal of writes as `anchored-vessels`). Sketch:
   ```js
   { name: 'Anchor Mapper', apiVersion: '1', version,
     requires: ['overlays.data', 'background.iframe'],
     optional: ['actions', 'actions.overlay', 'windows', 'panels.iframe', 'nightMode', 'units'],
     background: [{ id: 'live', type: 'iframe', url: BASE + '/runtime.html' }],
     overlays: [{ id: 'anchors', title: 'Anchored vessels', type: 'data',
                  band: 'aboveResources', visible: true, opacity: 0.9, minZoom: 10,
                  style: BASE + '/style.json', interactive: true,
                  interactiveLayers: ['anchor-point'], titleProperty: 'name' }],
     panels: [{ id: 'estimate', title: 'Anchor estimate', type: 'iframe', url: BASE + '/estimate.html' }],
     actions: [
       { id: 'details', title: 'Anchor estimate', default: true,
         targets: [{ kind: 'overlayFeature', overlays: ['anchors'] }],
         action: { type: 'openWindow', panel: 'estimate' } },
       { id: 'vessel', title: 'Anchor estimate',
         targets: [{ kind: 'vessel', self: false }],
         action: { type: 'openWindow', panel: 'estimate' } } ] }
   ```
   `BASE` is `/signalk-anchor-mapper/plotterext`: the files live in
   `public/plotterext/` and are served by the webapp mount the package already has
   (`signalk-webapp` keyword), so no `app.use` route and no new HTTP surface
   (ARCHITECTURE §6 stays true). The guide's warning against the webapp keyword
   is about extension-only packages appearing in the Webapps menu; ours is meant
   to be there anyway.

2. **Style** (`public/plotterext/style.json`, static). One `geojson` source
   `estimates`, inline and empty; layers bottom to top:
   `area-fill`, `area-line` (dashed), `circle-fill`, `circle-line` (solid, filter
   `quality == strong`), `circle-line-weak` (dashed; `line-dasharray` cannot be
   data-driven, hence two layers), `anchor-point` (circle at the anchor or area
   centre), `label` (symbol, name and radius, `minzoom` 14). Colours come from a
   `style` property via `match`: `normal` blue, `moored` grey, `buoy` amber, and
   once plan 2 lands `overlap` orange and `dragging` red. Same palette as the
   webapp (`colorFor` in `public/app.js`).

3. **Shapes** (`public/shapes.js`, shared). Pure functions:
   `circlePolygon(center, radiusM, n)`, `ellipsePolygon(center, a, b, bearingDeg, n)`
   (moved from `app.js`), and `toOverlayFeatures(features)` turning the
   `anchored-vessels` resources into a FeatureCollection: per vessel a Polygon
   (`<mmsi>:shape`) and a Point (`<mmsi>:anchor`), with properties `mmsi`,
   `name`, `kind`, `quality`, `tags`, `radiusMeters`, `style`, `label`. Written as
   a classic ES2015 script that sets `window.AnchorShapes` and, under Node,
   `module.exports`, so the webapp, the runtime and `node --test` all load the
   same file with no build step.

4. **Runtime** (`public/plotterext/runtime.html` + `runtime.js`). Loads
   `shapes.js` as a classic script, then the vendored bus client as an ES module.
   On start and every 60 s: fetch `/signalk/v2/api/resources/anchored-vessels`
   (same origin; `resources.list` is the fallback if a direct fetch is ever
   refused), build the collection, `overlay.setData({ overlayId: 'anchors',
   source: 'estimates', data })`. Skips the call when nothing changed. On
   `nightMode.changed`, swaps colours with `overlay.setLayer`. Logs
   `overlay.list().skippedLayers` once so a host that draws less is visible in
   the browser console. Polling is fine: estimates change once per analysis
   cycle (5 min).

5. **Details window** (`public/plotterext/estimate.html`). Reads the target from
   `client.context.invocation` or `action.invoked` (overlay feature: `mmsi` in its
   properties; AIS vessel: its context), fetches
   `/signalk/v2/api/resources/anchored-vessels/<mmsi>`, and shows kind, method,
   quality, tags, radius or area, since, dwell and the plain-language note the
   webapp shows. "No anchor estimate for this vessel" when there is none.
   Falls back to `openPanel` when the host has no `windows`.

6. **Bus client.** Vendor `signalk-plotterext-bus` 0.27.0 (MIT, ESM, no
   dependencies; `dist/extension.js` plus its two chunks, about 32 KB) into
   `public/plotterext/vendor/` with its licence, like Leaflet. Not an npm
   dependency, so "no runtime dependencies" holds. Extension files may use ES
   modules: they only ever run inside Freeboard, which needs a modern browser
   anyway. The webapp stays ES2015.

7. **Package.** Add keyword `signalk-category-plotter-extensions` (lists it under
   Plotter Extensions in the App Store and lets hosts find it). Keep
   `signalk-webapp` and `signalk-category-utility`; add `signalk-category-ais`.

8. **Alert state on the map (after plan 2).** Add `alerts: ['overlap'|'dragging']`
   to the `anchored-vessels` feature properties so the overlay and the webapp can
   colour those boats without a second data path. The own anchor circle is
   Freeboard's own; we do not redraw it there.

**Webapp (`public/app.js`)**: use `shapes.js` for the polygons and colours, finish
the own anchor circle from plan 4, add a small legend (solid / dashed / ellipse /
grey / amber) since colour alone carries the tags, and highlight overlap and
dragging boats once plan 2 adds `alerts`. Fix SPEC §7's leftover "anchor-bearing
hint" (wind was removed).

**Rejected**
- *Publish estimates as `regions`.* Fixed preset styles chosen by `skIcon`, so no
  dashed area vs solid anchor distinction or tag colours; no live refresh of the
  map; our shapes would mix into the user's own region list, GPX export and
  resource groups, with Edit/Delete offered that our provider must refuse; every
  other region-aware app would show them too. A regions provider for a standard
  type also competes with the user's own regions provider.
- *Notes.* Points only.
- *`overlays.image`.* We would render pixels ourselves in a worker; vector shapes
  are exactly what `overlays.data` is for and stay sharp on zoom.
- *GeoJSON served by the plugin as the source URL.* Would draw without a runtime,
  but needs a new HTTP route (`/plugins/*` is admin-only) or a non-standard
  resource shape. The runtime is needed for refresh anyway.
- *Upstream Freeboard change to draw AIS `navigation.anchor.*`.* Worth suggesting
  to the Freeboard maintainers later, but it would only give circles (no areas,
  no tags) and we would wait on their release. Not instead of this plan.

## Test strategy
- **Unit** `test/shapes.test.js`: circle polygon closes and every vertex is
  `radiusM` from the centre within 0.5 %; ellipse axes and bearing (north/east
  cases); area estimate gives a Polygon and no radius label; style property per
  tag combination (moored beats normal, buoy beats moored); ids stable across
  calls; garbage input (non-finite radius, missing area) is skipped, not thrown.
- **Unit** `test/plotterext.test.js`: manifest has `apiVersion` "1", every action
  panel and overlay `configPanel` names an entry that exists, every URL is under
  `BASE`; `style.json` parses, is `version: 8`, and every layer type and paint or
  layout key is in Freeboard's drawn set (copy of the `DRAWN` table with its
  source commit, so a style typo fails here, not silently on the boat).
- **Plugin** `test/plugin.test.js`: `plotterExtensions` provider registered on
  start, lists the manifest while running, empty after stop, refuses writes.
- **Manual** on the Pi with Freeboard ≥ 3.4: layer appears under Plugin layers;
  shapes match the webapp for the same vessels; tap on an anchor point opens the
  details window; AIS vessel popover offers "Anchor estimate"; hide/opacity work;
  night mode colours; `skippedLayers` empty in the console; Freeboard 3.3 or
  older simply shows nothing and no errors. Screenshot for the README.

## Steps
- [x] `public/shapes.js` + `test/shapes.test.js`; webapp switched to it
- [x] `src/plotterext.js` manifest + provider registration + tests
- [x] Vendor the bus client with licence; `style.json` + style test
- [x] Runtime: poll, build, `setData`, night mode, `skippedLayers` log
- [x] Details window and both actions
- [x] Webapp: legend, own anchor circle (plan 4)
- [ ] After plan 2: `alerts` on features, overlap/dragging colours in both views
- [x] SPEC §1.2, §6, §7, §12 and ARCHITECTURE §2, §4, §5, §7 updated; README section
      "Seeing anchors in Freeboard" (needs 3.4+, reload after enabling, where the
      layer toggle is); package keywords
- [x] Manual check on the Pi (2026-11-23, Freeboard-SK 3.4.1, server 2.37.0, plugin 0.2.1):
      extension listed, runtime iframe loaded, "all style layers drawn", area ellipse and
      label drawn in night mode, tapping the dot opens the Anchor estimate window.
      Label showed the MMSI, not the name: fixed on main in 846af69 (after 0.2.1)

## As built (2026-11-19)
Differences from the approach above, and how it was checked:
- **Weak fits are dotted** (`line-dasharray [0.5, 2]`, round caps), not dashed, so
  they stay distinct from the dashed area ellipse. Same in the webapp and legend.
- **Layer filters use a `part` property** (`shape` / `anchor`) set by
  `toOverlayFeatures`, not `geometry-type`.
- **No `units` capability.** Labels stay in metres like the webapp; declaring it
  unused would be misleading. Add it if labels ever follow the user's units.
- **No `resources.list` fallback.** Freeboard gives background, panel and window
  iframes `allow-scripts allow-same-origin`, so a same-origin fetch with the user's
  session works.
- **No explicit `openPanel` fallback** for hosts without `windows`: the API says
  such a host treats an `openWindow` action as `openPanel` itself.
- **Webapp circles stay `L.circle`** (exact and smoother in Leaflet); ellipses come
  from `shapes.js`. The Freeboard layer uses `circlePolygon` (64 vertices, same
  projection as the detector).
- **Polls never overlap** (a slow server does not get a second request stacked).
- `public/plotterext/package.json` (`"type": "module"`) lets `node --test` import
  the ES-module pages; browsers ignore it.
- **Checked:** `style.json` and the night recolouring pass Freeboard's own
  `analyzeLayer` (its `data-overlay-style.ts` at d22ab98 with
  `@maplibre/maplibre-gl-style-spec` 23), all 7 layers drawable; a style with
  `line-blur` or a broken expression is rejected by the same check. Headless
  Chromium with the bus's real `HostConnection` as host and MapLibre GL drawing the
  style: runtime handshake, `setData` (5 vessels, 10 features), night `setLayer`,
  details window from an overlay feature, reuse for an AIS vessel, "No anchor
  estimate" for an unknown one. Not yet in a real Freeboard: that is the manual
  check on the Pi below.

## Files
Create `public/shapes.js`, `public/plotterext/{runtime.html,runtime.js,estimate.html,estimate.js,style.json}`,
`public/plotterext/vendor/signalk-plotterext-bus/*`, `src/plotterext.js`,
`test/shapes.test.js`, `test/plotterext.test.js`.
Modify `index.js` (register provider, or `src/publish.js` after plan 1),
`public/app.js`, `public/index.html`, `package.json`, `test/plugin.test.js`,
SPEC.md, ARCHITECTURE.md, README.md, CHANGELOG.md.
