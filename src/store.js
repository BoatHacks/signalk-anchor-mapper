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
   * Merge older fixes (oldest first, e.g. from the tracks plugin) into a
   * vessel's track by time. A live fix wins over history within
   * minFixIntervalS of it. Merging, not cutting at the first live fix: on
   * subscribe the server replays cached values, and one restored at server
   * start (signalk-questdb.restore) can be hours older than the history.
   * Returns how many were added.
   */
  seed(id, fixes) {
    const live = this.tracks.get(id) || []
    const gap = this.minFixIntervalS
    const out = []
    let j = 0
    for (const f of fixes) {
      if (!Number.isFinite(f.t) || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue
      const last = out[out.length - 1]
      if (last && (f.t < last.t || f.t - last.t < gap)) continue
      while (j < live.length && live[j].t < f.t) j++
      if ((j < live.length && live[j].t - f.t < gap) || (j > 0 && f.t - live[j - 1].t < gap)) continue
      const fix = { t: f.t, lat: f.lat, lon: f.lon }
      if (Number.isFinite(f.heading)) fix.heading = f.heading
      out.push(fix)
    }
    if (out.length === 0) return 0
    const merged = []
    let i = 0
    j = 0
    while (i < out.length || j < live.length) {
      if (j >= live.length || (i < out.length && out[i].t < live[j].t)) merged.push(out[i++])
      else merged.push(live[j++])
    }
    this.tracks.set(id, merged)
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
