'use strict'

/**
 * Bounded in-memory position history per vessel. Fixes are thinned to at most
 * one per minFixIntervalS so a chatty class A transmitter does not dominate
 * memory, and anything older than maxAgeS is dropped.
 */
class TrackStore {
  constructor({ maxAgeS = 12 * 3600, minFixIntervalS = 30 } = {}) {
    this.maxAgeS = maxAgeS
    this.minFixIntervalS = minFixIntervalS
    this.tracks = new Map() // id -> [{ t, lat, lon, heading? }]
  }

  add(id, t, lat, lon, heading) {
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) return false
    let track = this.tracks.get(id)
    if (!track) {
      track = []
      this.tracks.set(id, track)
    }
    const last = track[track.length - 1]
    if (last && t < last.t) return false // out of order, ignore
    if (last && t - last.t < this.minFixIntervalS) return false
    const fix = { t, lat, lon }
    if (Number.isFinite(heading)) fix.heading = heading
    track.push(fix)
    return true
  }

  /**
   * Put older fixes (oldest first, e.g. from the tracks plugin) in front of a
   * vessel's track. Only fixes before the first live one are taken, so live
   * data that arrived meanwhile always wins and order is kept. Returns how
   * many were added.
   */
  seed(id, fixes) {
    const live = this.tracks.get(id) || []
    const firstLive = live.length ? live[0].t : Infinity
    const out = []
    for (const f of fixes) {
      if (!Number.isFinite(f.t) || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue
      if (f.t > firstLive - this.minFixIntervalS) break
      const last = out[out.length - 1]
      if (last && (f.t < last.t || f.t - last.t < this.minFixIntervalS)) continue
      const fix = { t: f.t, lat: f.lat, lon: f.lon }
      if (Number.isFinite(f.heading)) fix.heading = f.heading
      out.push(fix)
    }
    if (out.length === 0) return 0
    this.tracks.set(id, out.concat(live))
    return out.length
  }

  prune(nowS) {
    const cutoff = nowS - this.maxAgeS
    for (const [id, track] of this.tracks) {
      let k = 0
      while (k < track.length && track[k].t < cutoff) k++
      if (k > 0) track.splice(0, k)
      if (track.length === 0) this.tracks.delete(id)
    }
  }

  get(id) {
    return this.tracks.get(id) || []
  }

  ids() {
    return [...this.tracks.keys()]
  }
}

module.exports = { TrackStore }
