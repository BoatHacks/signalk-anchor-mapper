# Changelog

## 0.1.0 (unreleased)

- Initial scaffold: stationary-episode detection, trimmed circle fit, "possibly-moored" and "possible-mooring-buoy" tags
- Publishes `navigation.anchor.position`, `navigation.anchor.maxRadius` and `navigation.anchor.estimate` per anchored vessel
- Read-only `anchored-vessels` resource provider (GeoJSON)
- Leaflet webapp with OpenStreetMap and OpenSeaMap layers
- Webapp opens centred on the own vessel's position, with a marker for it; falls back to the estimates, then a world view, when there is no position
- Freeboard-SK (3.4+) layer "Anchored vessels": swing circles and area ellipses on Freeboard's chart through a plotter extension data overlay, refreshed every minute, night-mode colours, and an "Anchor estimate" details window from the anchor dot or an AIS vessel's popover
- Shapes and colours shared between the webapp and Freeboard (`public/shapes.js`); weak fits drawn dotted
- Webapp: legend, and the own anchor with its alarm radius
- After a restart, the track history is seeded from the tracks plugin (Signal K 2.33+ Track API, @signalk/tracks-plugin 3+), so estimates come back within seconds instead of after the minimum dwell. The plugin status says when there was no history to seed from
