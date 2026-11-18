'use strict'

// Local equirectangular projection. Good to well under a metre over the few
// hundred metres an anchor swing covers.
const M_PER_DEG_LAT = 110540
const M_PER_DEG_LON_EQ = 111320

function makeProjection(lat0, lon0) {
  const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180)
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLatLon: (x, y) => ({ latitude: lat0 + y / M_PER_DEG_LAT, longitude: lon0 + x / kx })
  }
}

function distanceM(a, b) {
  const kx = M_PER_DEG_LON_EQ * Math.cos((a.latitude * Math.PI) / 180)
  return Math.hypot((a.longitude - b.longitude) * kx, (a.latitude - b.latitude) * M_PER_DEG_LAT)
}

function median(arr) {
  if (arr.length === 0) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function percentile(arr, p) {
  if (arr.length === 0) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

module.exports = { makeProjection, distanceM, median, percentile }
