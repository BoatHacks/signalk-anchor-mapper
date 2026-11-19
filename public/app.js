/* Anchor Mapper webapp. Plain ES2015, no build step, no optional chaining (old MFD browsers). */
(function () {
  'use strict'

  var RESOURCE_URL = '/signalk/v2/api/resources/anchored-vessels'
  var REFRESH_MS = 60000
  var SELF_POSITION_URL = '/signalk/v1/api/vessels/self/navigation/position'
  var SELF_ANCHOR_URL = '/signalk/v1/api/vessels/self/navigation/anchor'
  var SELF_COLOR = '#ff4f6d'
  // Shapes and colours shared with the Freeboard layer (shapes.js).
  var Shapes = window.AnchorShapes
  var SELF_ZOOM = 14

  // World view only until the start view is decided (see placeStartView).
  var map = L.map('map', { zoomControl: true }).setView([20, 0], 2)
  // Base chart plus the OpenSeaMap seamark overlay (buoys, lights, harbours).
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map)
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenSeaMap contributors'
  }).addTo(map)

  // Legend swatches take their colour from the shared palette.
  var swatches = document.querySelectorAll('#legend [data-style]')
  for (var i = 0; i < swatches.length; i++) {
    swatches[i].setAttribute('stroke', Shapes.DAY[swatches[i].getAttribute('data-style')])
  }

  var layer = L.layerGroup().addTo(map)
  var selfMarker = null
  var selfAnchor = L.layerGroup().addTo(map)
  // Start view: own vessel first, else the estimates, else the world.
  // 'centred' means the map sits on the own vessel; 'fitted' that it shows the estimates.
  var centred = false
  var fitted = false
  var userMoved = false
  var hasSelf = false
  map.on('dragstart', function () { userMoved = true })

  // Resolves to [lat, lon] or null. Accepts the full SignalK node ({ value: {...} }) or a bare value.
  function fetchSelfPosition() {
    return fetch(SELF_POSITION_URL)
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (node) {
        var v = node && node.value ? node.value : node
        if (!v || typeof v.latitude !== 'number' || typeof v.longitude !== 'number') return null
        if (!isFinite(v.latitude) || !isFinite(v.longitude)) return null
        return [v.latitude, v.longitude]
      })
      .catch(function () { return null })
  }

  function showSelf(ll) {
    hasSelf = !!ll
    if (!ll) return
    if (!selfMarker) {
      selfMarker = L.circleMarker(ll, { radius: 7, color: '#ffffff', weight: 3, fillColor: SELF_COLOR, fillOpacity: 1 })
        .bindTooltip('own vessel').addTo(map)
    } else {
      selfMarker.setLatLng(ll)
    }
    // Centre on the boat once. If the position arrives late, still do it unless the user has panned.
    if (!centred && !userMoved) {
      map.setView(ll, SELF_ZOOM)
      centred = true
      fitted = true
    }
  }

  // Own anchor (set by an anchor alarm plugin): resolves to { ll, radius } or null.
  function fetchSelfAnchor() {
    return fetch(SELF_ANCHOR_URL)
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (node) {
        if (!node) return null
        var pos = node.position && node.position.value
        var radius = node.maxRadius && node.maxRadius.value
        if (!pos || typeof pos.latitude !== 'number' || typeof pos.longitude !== 'number') return null
        if (!isFinite(pos.latitude) || !isFinite(pos.longitude)) return null
        return { ll: [pos.latitude, pos.longitude], radius: typeof radius === 'number' && isFinite(radius) && radius > 0 ? radius : null }
      })
      .catch(function () { return null })
  }

  // Drawn in the own-vessel colour so overlaps with other boats' circles stand out.
  function showSelfAnchor(a) {
    selfAnchor.clearLayers()
    if (!a) return
    if (a.radius) {
      L.circle(a.ll, { radius: a.radius, color: SELF_COLOR, weight: 2, fillOpacity: 0.06, interactive: false }).addTo(selfAnchor)
    }
    L.circleMarker(a.ll, { radius: 4, color: SELF_COLOR, fillColor: SELF_COLOR, fillOpacity: 1 })
      .bindTooltip('own anchor' + (a.radius ? ', alarm radius ' + Math.round(a.radius) + ' m' : '')).addTo(selfAnchor)
  }

  // GeoJSON ring ([lon, lat]) to Leaflet points ([lat, lon]).
  function toLatLngs(ring) {
    return ring.map(function (c) { return [c[1], c[0]] })
  }

  function text(el, s) {
    el.textContent = s
    return el
  }

  function tagsOf(p) {
    var out = []
    for (var i = 0; i < (p.tags || []).length; i++) out.push(p.tags[i])
    if (p.kind === 'area') out.push('area only')
    if (p.quality === 'weak') out.push('weak fit')
    return out
  }

  // Best effort: ask the tracks plugin for the vessel's recent track.
  function loadTrack(context, color) {
    var id = context.replace(/^vessels\./, '')
    return fetch('/signalk/v1/api/vessels/' + encodeURIComponent(id) + '/track')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (gj) {
        if (!gj || !gj.coordinates) return
        var lines = gj.type === 'MultiLineString' ? gj.coordinates : [gj.coordinates]
        lines.forEach(function (line) {
          var pts = line.map(function (c) { return [c[1], c[0]] })
          L.polyline(pts, { color: color, weight: 2, opacity: 0.8 }).addTo(layer)
        })
      })
      .catch(function () {})
  }

  function render(features) {
    layer.clearLayers()
    var list = document.getElementById('list')
    list.innerHTML = ''
    var bounds = []
    features.forEach(function (f) {
      var p = f.properties
      var ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]]
      var color = Shapes.colorFor(p)
      var isArea = p.kind === 'area'
      var title
      var note
      if (isArea) {
        // No anchor point could be resolved: show the occupied area as a dashed ellipse.
        L.polygon(toLatLngs(Shapes.ellipsePolygon(f.geometry.coordinates, p.area.semiMajorM, p.area.semiMinorM, p.area.bearingDeg)),
          { color: color, weight: 2, dashArray: '6 4', fillOpacity: 0.06, smoothFactor: 0 }).addTo(layer)
        title = (p.name || p.mmsi) + ', area ' + p.area.semiMajorM + ' x ' + p.area.semiMinorM + ' m'
        note = 'Long stay with a swing, but the anchor position cannot be placed from the track alone.'
      } else {
        // Solid for a strong fit, dotted for a weak one (same as the Freeboard layer).
        // Leaflet draws a true circle; the Freeboard layer uses Shapes.circlePolygon.
        L.circle(ll, {
          radius: p.radiusMeters, color: color, weight: 2, fillOpacity: 0.08,
          dashArray: p.quality === 'strong' ? null : '1 6', lineCap: 'round'
        }).addTo(layer)
        title = (p.name || p.mmsi) + ', r ' + p.radiusMeters + ' m'
        note = 'Estimated from position tracks and headings only; may be a mooring buoy or other fixed mooring.'
      }
      var marker = L.circleMarker(ll, { radius: isArea ? 3 : 4, color: color, fillOpacity: isArea ? 0.4 : 1 }).addTo(layer)
      marker.bindPopup(title + '<br>since ' + p.since + '<br>' + p.dwellHours + ' h<br><small>' + note + '</small>')
      loadTrack(p.context, color)
      bounds.push(ll)

      var row = document.createElement('div')
      row.className = 'row'
      text(row, title)
      tagsOf(p).forEach(function (t) {
        var s = document.createElement('span')
        s.className = 'tag' + (t === 'possible-mooring-buoy' ? ' buoy' : '')
        text(s, t)
        row.appendChild(s)
      })
      row.onclick = function () { userMoved = true; map.setView(ll, 16); marker.openPopup() }
      list.appendChild(row)
    })
    // Fallback start view when there is no own position: fit the estimates once.
    if (!fitted && !userMoved && bounds.length) {
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 })
      fitted = true
    }
    text(document.getElementById('status'), features.length + ' estimate' + (features.length === 1 ? '' : 's') +
      (hasSelf ? '' : ', no own position yet'))
  }

  function refresh() {
    // Own position first, so the start view is settled before the estimates can fit.
    fetchSelfPosition()
      .then(showSelf)
      .then(fetchSelfAnchor)
      .then(showSelfAnchor)
      .then(function () { return fetch(RESOURCE_URL) })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (obj) { render(Object.keys(obj).map(function (k) { return obj[k] })) })
      .catch(function (e) { text(document.getElementById('status'), 'offline: ' + e.message) })
  }

  refresh()
  setInterval(refresh, REFRESH_MS)
})()
