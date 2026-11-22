# signalk-anchor-mapper

A [SignalK Server](https://github.com/SignalK/signalk-server) plugin that works out where **other vessels** are anchored, from their AIS position tracks. For each vessel that has been swinging around a fixed point it estimates the anchor position and the swing radius, publishes them as SignalK data, and shows them on an OpenSeaMap chart.

## Status

Early release (0.2.0). The detection core is implemented and tested, and was validated offline against several weeks of recorded AIS data (see [docs/VALIDATION.md](docs/VALIDATION.md)). Not yet installed on a live server and not yet published to npm.

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
- `navigation.anchor.maxRadius`: swing radius in metres (distance from the anchor to the farthest fix of the stay, so the circle holds every position the boat took)
- `navigation.anchor.estimate`: kind (`anchor` or `area`), method, quality, tags, start time, dwell hours, the occupied area ellipse, and a note about how it was estimated

For an area-only result `position` and `maxRadius` are `null` and the ellipse is in `estimate.area`. All values are set to `null` when the vessel is no longer anchored.

A read-only resource provider also serves the current estimates as GeoJSON features at `/signalk/v2/api/resources/anchored-vessels`. Resource providers are readable without admin rights under the server's read-only access setting, unlike plugin routes.

## Alerts

**Advisory, not an anchor watch.** The alerts rest on estimates made from other boats' AIS tracks, which can be wrong or late. Never rely on them as your only anchor watch.

**Anchor Mapper watches other boats, not yours.** It estimates where neighbouring boats are anchored and warns about drag and overlap. It does not alarm for your own boat, so you still need a regular anchor alarm plugin for that, for example [signalk-mareas-ihm](https://github.com/Aitonos/signalk-mareas-ihm), [hoekens-anchor-alarm](https://github.com/hoeken/hoekens-anchor-alarm) or [signalk-anchoralarm-plugin](https://github.com/sbender9/signalk-anchoralarm-plugin). Anchor Mapper reads the anchor position and radius they publish for your boat. **Avoid double alerts:** some of these also warn when another boat enters your swing circle, which Anchor Mapper does too. Keep that warning on in only one of them.

Alerts are SignalK notifications on your own vessel:

- `notifications.anchorMapper.overlap.<mmsi>`: state `warn`, method `visual`, when another boat's swing circle overlaps yours or comes within the overlap margin (10 m). Needs an anchor set on your own vessel, as an anchor alarm plugin does with `navigation.anchor.position` and `navigation.anchor.maxRadius`. Your alarm radius counts as your swing radius, so a generous alarm radius warns a little early.
- `notifications.anchorMapper.dragging.<mmsi>`: when an anchored boat has been outside its swing circle plus a margin (20 m, or 25 % of the radius if larger) for at least 90 s over at least two position reports. State `alarm` with `visual` and `sound` when it is within two swing radii of your own anchor, otherwise a silent `warn`.

Each alert returns to `normal` when its condition stops, with some hysteresis so it does not flap. A boat leaving under way (faster than 3 kn, or moving bow-first) is not reported as dragging, a boat that sits still outside its circle for 30 minutes has settled, not dragged, and an alarm needs the boat to be moving further out, not just sitting or jittering outside, and a drag alert stays 10 minutes after the estimate ends so it is seen. Both alerts are on the map too: orange for overlap and red for dragging, in the webapp and in Freeboard-SK.

Only strong estimates alert. Weak fits never do unless you turn on "Alert on doubtful estimates". Boats tagged possibly moored or possible mooring buoy can raise overlap warnings (a mooring in your way is real) but never drag alarms. Without that setting, only anchor estimates (not occupied areas) can be dragging.

After a restart the plugin needs estimates again before it can alert; see "Known limits".

## Webapp

`public/` is a buildless Leaflet webapp with the OpenStreetMap base map and the OpenSeaMap seamark layer. It opens centred on your own vessel's `navigation.position`; without a position fix it shows the estimates instead, and re-centres on your boat once a fix arrives (unless you have already moved the map). It draws each estimate as a circle or ellipse in the same style as the Freeboard layer (shapes and colours come from the shared `public/shapes.js`), with a legend, its track (fetched from the SignalK tracks plugin when that is installed) and the tags. Your own anchor and alarm radius are drawn in red when an anchor alarm plugin has set them, so overlapping swing circles are easy to spot. Leaflet is vendored in `public/vendor/leaflet`. Tiles load from the internet, so the map background is blank offline.

## Seeing anchors in Freeboard-SK

With Freeboard-SK **3.4 or later** the estimates appear on Freeboard's own chart, through its Plotter Extensions API. Nothing to install besides this plugin.

1. Enable the plugin, then **reload Freeboard** (it reads plugin layers when it connects).
2. Open the Chart List: the layer **Anchored vessels** is under *Plugin layers*, with its own show/hide and opacity. It draws from zoom 10.
3. Circles and ellipses look as in the webapp: solid circle for a strong fit, dotted for a weak one, dashed ellipse for an area only; blue, grey for `possibly-moored`, amber for `possible-mooring-buoy`. Names and radii appear from zoom 14. Darker colours in night mode.
4. Tap an anchor dot, or choose **Anchor estimate** in an AIS vessel's popover, for the details: method, quality, tags, since when, and the caveats.

The layer refreshes every minute. Older Freeboard versions and other chart plotters simply do not show it; the published `navigation.anchor.*` data is there for any client that wants to draw it. If a shape is missing, Freeboard's browser console says which style layer it skipped (look for `anchor-mapper:`).

## Configuration

All in the admin UI under Server, Plugin Config, Anchor Mapper:

- **Minimum time stationary**: default 120 minutes
- **Analysis interval**: default 5 minutes
- **Track history kept in memory**: default 12 hours
- **Tag swings tighter than**: default 15 m
- **Publish possibly moored estimates**: default on
- **Publish weak fits**: default on
- **Alerts** group: overlap alerts (default on), overlap margin (10 m), drag alerts (default on), drag margin (20 m), drag time outside (90 s), alert on doubtful estimates (default off)

## Known limits

- Tracks live in memory. After a restart the plugin fills them back from the [tracks plugin](https://www.npmjs.com/package/@signalk/tracks-plugin) (3.0 or later, on Signal K server 2.33 or later), which keeps AIS tracks in a database. Without it, a restart means no estimates for up to the minimum time stationary (2 h by default), and the plugin status says so. Seeded positions carry no heading, so a ship that had a heading-based estimate may show as a ring fit or an area until about 15 minutes of fresh headings have come in.
- A vessel with no position reports for more than 30 minutes ends its episode.
- `since` and `dwellHours` count from the oldest fix still kept, so for a stay longer than the track history (12 h by default) they are a lower bound, and `since` moves forward as old fixes drop off.
- A very slow drag (under about 10 m in 30 minutes) is not caught, and a boat that rests just outside its estimated circle may take several minutes longer to alarm. Alerts were tuned on 25 days of recorded AIS from one coast (docs/VALIDATION.md).
- Without heading (class B yachts), a boat in a narrow band gets an area only, not an anchor point. The shape of a short arc cannot fix the circle, and guessing would understate the swing radius badly.
- Heading based estimates assume the bow points at the anchor. Strong tide or current, or a boat sheering on its chain, adds scatter, which is why such estimates are rated `weak` when the rays miss by more than 15% of the distance.

## Development

```bash
npm test
```

Plain Node, no runtime dependencies. The pure detection code lives in `src/` and is tested with synthetic tracks (`node:test`). The Freeboard extension lives in `public/plotterext/`; its bus client is vendored from `signalk-plotterext-bus` (MIT).

## License

MIT
