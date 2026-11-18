# Changelog

## 0.1.0 (unreleased)

- Initial scaffold: stationary-episode detection, trimmed circle fit, "possibly-moored" and "possible-mooring-buoy" tags
- Publishes `navigation.anchor.position`, `navigation.anchor.maxRadius` and `navigation.anchor.estimate` per anchored vessel
- Read-only `anchored-vessels` resource provider (GeoJSON)
- Heading-into-wind hint for sailing and pleasure craft: configurable low-weight anchor bearing from the own vessel's wind, `wind-disagrees` tag, `windHint` in the estimate; pluggable wind source for a later gridded model. The hint uses the last 6 h of a stay, needs a steady wind, and is skipped for possibly-moored swings
- Leaflet webapp with OpenStreetMap and OpenSeaMap layers
