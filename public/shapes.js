/*
 * Anchor Mapper shapes and colours, shared by the webapp, the Freeboard-SK
 * plotter extension and the tests, so the two map views never disagree.
 *
 * A classic ES2015 script with no build step: in a browser it sets
 * window.AnchorShapes, under Node it is module.exports. No optional chaining
 * (old MFD browsers load the webapp).
 *
 * Coordinates in and out of the polygon helpers are GeoJSON order, [lon, lat].
 */
(function (root) {
  'use strict'

  // Same local projection as src/geo.js (and so the detector that measured the radius).
  var M_PER_DEG_LAT = 110540
  var M_PER_DEG_LON_EQ = 111320
  var DEFAULT_VERTICES = 64

  // Colour per style key. 'overlap' and 'dragging' are for alert states (plan 2).
  var DAY = {
    normal: '#3fb6ff',
    moored: '#7f8fa0',
    buoy: '#d9a441',
    overlap: '#ff8c1a',
    dragging: '#ff3b30'
  }
  // Night: same hues, darker, so the overlay does not glow on a dark bridge.
  var NIGHT = {
    normal: '#2a6f99',
    moored: '#56616c',
    buoy: '#8c6a2c',
    overlap: '#9c5412',
    dragging: '#a3271f'
  }
  var STYLE_KEYS = ['dragging', 'overlap', 'buoy', 'moored', 'normal']

  // Style layers (public/plotterext/style.json) whose colour follows the 'style'
  // property, and which paint key holds it. The runtime recolours these for night mode.
  var COLOR_PAINT = [
    ['area-fill', 'fill-color'],
    ['area-line', 'line-color'],
    ['circle-fill', 'fill-color'],
    ['circle-line', 'line-color'],
    ['circle-line-weak', 'line-color'],
    ['anchor-point', 'circle-color'],
    ['label', 'text-color']
  ]

  function isNum(x) {
    return typeof x === 'number' && isFinite(x)
  }

  function validCenter(c) {
    return c && c.length >= 2 && isNum(c[0]) && isNum(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180
  }

  function kx(lat) {
    return M_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180)
  }

  // Ellipse as a closed GeoJSON ring. a = semi-major, b = semi-minor (metres),
  // bearingDeg = direction of the major axis, clockwise from north.
  function ellipsePolygon(center, a, b, bearingDeg, n) {
    if (!validCenter(center) || !isNum(a) || !isNum(b) || a <= 0 || b <= 0) return null
    n = n || DEFAULT_VERTICES
    var th = ((isNum(bearingDeg) ? bearingDeg : 0) * Math.PI) / 180
    var k = kx(center[1])
    var ring = []
    for (var i = 0; i < n; i++) {
      var t = (i / n) * 2 * Math.PI
      var u = a * Math.cos(t) // along the major axis
      var v = b * Math.sin(t) // across it
      var east = u * Math.sin(th) + v * Math.cos(th)
      var north = u * Math.cos(th) - v * Math.sin(th)
      ring.push([center[0] + east / k, center[1] + north / M_PER_DEG_LAT])
    }
    ring.push([ring[0][0], ring[0][1]])
    return ring
  }

  function circlePolygon(center, radiusM, n) {
    return ellipsePolygon(center, radiusM, radiusM, 0, n)
  }

  function tagsOf(p) {
    return p && Array.isArray(p.tags) ? p.tags : []
  }

  // Which colour an estimate gets. Alerts beat tags; a buoy tag beats "possibly moored".
  function styleOf(p) {
    var alerts = p && Array.isArray(p.alerts) ? p.alerts : []
    var tags = tagsOf(p)
    if (alerts.indexOf('dragging') >= 0) return 'dragging'
    if (alerts.indexOf('overlap') >= 0) return 'overlap'
    if (tags.indexOf('possible-mooring-buoy') >= 0) return 'buoy'
    if (tags.indexOf('possibly-moored') >= 0) return 'moored'
    return 'normal'
  }

  function colorFor(p, palette) {
    return (palette || DAY)[styleOf(p)]
  }

  // MapLibre expression picking the colour from a feature's 'style' property.
  function colorExpression(palette) {
    var e = ['match', ['get', 'style']]
    for (var i = 0; i < STYLE_KEYS.length - 1; i++) e.push(STYLE_KEYS[i], palette[STYLE_KEYS[i]])
    e.push(palette.normal)
    return e
  }

  function labelOf(p) {
    var name = p.name || p.mmsi
    if (p.kind === 'area') return name + '\narea ' + p.area.semiMajorM + ' x ' + p.area.semiMinorM + ' m'
    return name + '\nr ' + p.radiusMeters + ' m'
  }

  function listOf(input) {
    if (!input) return []
    if (Array.isArray(input)) return input
    if (input.type === 'FeatureCollection' && Array.isArray(input.features)) return input.features
    return Object.keys(input).map(function (k) { return input[k] })
  }

  // The shape of one anchored-vessels resource feature, or null when it is unusable.
  function shapeOf(f) {
    var p = f && f.properties
    var center = f && f.geometry && f.geometry.coordinates
    if (!p || !validCenter(center)) return null
    if (p.kind === 'area') {
      if (!p.area) return null
      return ellipsePolygon(center, p.area.semiMajorM, p.area.semiMinorM, p.area.bearingDeg)
    }
    if (!isNum(p.radiusMeters) || p.radiusMeters <= 0) return null
    return circlePolygon(center, p.radiusMeters)
  }

  // anchored-vessels resources (object keyed by id, array, or FeatureCollection)
  // -> the FeatureCollection the Freeboard overlay draws: per vessel a Polygon
  // '<mmsi>:shape' and a Point '<mmsi>:anchor'. Unusable entries are skipped.
  function toOverlayFeatures(input) {
    var out = []
    listOf(input).forEach(function (f) {
      var ring = shapeOf(f)
      if (!ring) return
      var p = f.properties
      var mmsi = String(p.mmsi || f.id)
      var props = {
        mmsi: mmsi,
        name: p.name || mmsi,
        kind: p.kind === 'area' ? 'area' : 'anchor',
        quality: p.quality === 'strong' ? 'strong' : 'weak',
        tags: tagsOf(p).join(','),
        style: styleOf(p),
        label: labelOf(p)
      }
      if (props.kind === 'anchor') props.radiusMeters = p.radiusMeters
      out.push({
        type: 'Feature',
        id: mmsi + ':shape',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: assign({ part: 'shape' }, props)
      })
      out.push({
        type: 'Feature',
        id: mmsi + ':anchor',
        geometry: { type: 'Point', coordinates: [f.geometry.coordinates[0], f.geometry.coordinates[1]] },
        properties: assign({ part: 'anchor' }, props)
      })
    })
    return { type: 'FeatureCollection', features: out }
  }

  function assign(a, b) {
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]
    return a
  }

  var api = {
    DAY: DAY,
    NIGHT: NIGHT,
    STYLE_KEYS: STYLE_KEYS,
    COLOR_PAINT: COLOR_PAINT,
    circlePolygon: circlePolygon,
    ellipsePolygon: ellipsePolygon,
    styleOf: styleOf,
    colorFor: colorFor,
    colorExpression: colorExpression,
    labelOf: labelOf,
    toOverlayFeatures: toOverlayFeatures
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.AnchorShapes = api
})(typeof window !== 'undefined' ? window : this)
