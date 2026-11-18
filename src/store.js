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
    this.tracks = new Map() // id -> [{ t, lat, lon, heading?, sog? }]
  }

  add(id, t, lat, lon, heading, sog) {
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
    if (Number.isFinite(sog)) fix.sog = sog
    track.push(fix)
    return true
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
