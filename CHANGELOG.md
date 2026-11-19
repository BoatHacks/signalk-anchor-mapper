# Changelog

## 0.1.0 (unreleased)

- Initial scaffold: stationary-episode detection, trimmed circle fit, "possibly-moored" and "possible-mooring-buoy" tags
- Publishes `navigation.anchor.position`, `navigation.anchor.maxRadius` and `navigation.anchor.estimate` per anchored vessel
- Read-only `anchored-vessels` resource provider (GeoJSON)
- Leaflet webapp with OpenStreetMap and OpenSeaMap layers
- Webapp opens centred on the own vessel's position, with a marker for it; falls back to the estimates, then a world view, when there is no position
