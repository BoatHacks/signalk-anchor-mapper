# signalk-anchor-mapper

A [SignalK Server](https://github.com/SignalK/signalk-server) plugin that works out where **other vessels** are anchored, from their AIS position tracks. For each vessel that has been swinging around a fixed point it estimates the anchor position and the swing radius, publishes them as SignalK data, and shows them on an OpenSeaMap chart.

## Status

Early scaffold (0.1.0). The detection core is implemented and tested, and was validated offline against several weeks of recorded AIS data (see [docs/VALIDATION.md](docs/VALIDATION.md)). Not yet installed on a live server and not yet published to npm.

## How it works

1. Subscribes to `navigation.position` for every other vessel and keeps a bounded in-memory track (default 12 h, one fix per 30 s).
2. Every few minutes, per vessel, finds **stationary episodes**: stretches that stay within 250 m of their running centroid for at least the configured dwell time (default 2 h).
3. Locates the anchor, in order of preference:
   - **Bow headings** (vessels that transmit heading, mostly class A). A boat lying to its anchor points its bow at it, so the lines along the headings meet at the anchor. This works even when the boat sits in a narrow band, which is the normal case in steady wind and where a circle fitted to the track alone fails badly.
   - **Ring fit.** If the track is a genuine ring (most of the circle covered, and the radius clearly larger than the scatter), the circle centre is the anchor.
   - **Occupied area only.** If the vessel stays put and swings but neither method resolves an anchor, the plugin reports the area it occupied as an ellipse and does not invent an anchor point or radius.
4. Tags the doubtful cases (below), then publishes the result.

### Tags and caveats

The estimate comes from position tracks only, so it can be wrong in predictable ways. Instead of hiding doubtful results the plugin flags them:

| Tag | Meaning |
|---|---|
| `possibly-moored` | The swing is under 15 m. That is hard to tell apart from a boat tied up at a berth or a mooring ball. |
| `possible-mooring-buoy` | At least two other vessels have also stayed for hours within 100 m of this spot. That points at a berth, buoy or other fixed structure rather than a free anchor. |
| quality `weak` | The track is a plausible but noisy ring (partial arc, wind shifts, drift). |

There are no harbor or marina polygons. Boats berthed in a marina show up as "still" (no swing) or get one of the tags above.

## Published data

For every vessel judged to be anchored, on that vessel's own context (`vessels.urn:mrn:imo:mmsi:...`):

- `navigation.anchor.position`: `{ latitude, longitude }` of the estimated anchor
- `navigation.anchor.maxRadius`: swing radius in metres (95th percentile distance of the vessel from the anchor)
- `navigation.anchor.estimate`: kind (`anchor` or `area`), method, quality, tags, start time, dwell hours, the occupied area ellipse, and a note about how it was estimated

For an area-only result `position` and `maxRadius` are `null` and the ellipse is in `estimate.area`. All values are set to `null` when the vessel is no longer anchored.

A read-only resource provider also serves the current estimates as GeoJSON features at `/signalk/v2/api/resources/anchored-vessels`. Resource providers are readable without admin rights under the server's read-only access setting, unlike plugin routes.

## Webapp

`public/` is a buildless Leaflet webapp with the OpenStreetMap base map and the OpenSeaMap seamark layer. It draws each estimate as a circle with its track (fetched from the SignalK tracks plugin when that is installed) and lists the tags. Leaflet is vendored in `public/vendor/leaflet`. Tiles load from the internet, so the map background is blank offline.

## Configuration

All in the admin UI under Server, Plugin Config, Anchor Mapper:

- **Minimum time stationary**: default 120 minutes
- **Analysis interval**: default 5 minutes
- **Track history kept in memory**: default 12 hours
- **Tag swings tighter than**: default 15 m
- **Publish possibly moored estimates**: default on
- **Publish weak fits**: default on

## Known limits

- Tracks live in memory, so a server restart loses history and detection needs the dwell time again to rebuild it. Seeding from the tracks plugin or a history database is planned.
- A vessel with no position reports for more than 30 minutes ends its episode.
- Without heading (class B yachts), a boat in a narrow band gets an area only, not an anchor point. The shape of a short arc cannot fix the circle, and guessing would understate the swing radius badly.
- Heading based estimates assume the bow points at the anchor. Strong tide or current, or a boat sheering on its chain, adds scatter, which is why such estimates are rated `weak` when the rays miss by more than 15% of the distance.

## Development

```bash
npm test
```

Plain Node, no runtime dependencies. The pure detection code lives in `src/` and is tested with synthetic tracks (`node:test`).

## License

MIT
