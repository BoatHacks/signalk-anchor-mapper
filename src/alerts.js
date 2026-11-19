'use strict'

const { distanceM, makeProjection } = require('./geo')

const KN = 1852 / 3600 // m/s per knot

const DEFAULTS = {
  overlapEnabled: true,
  overlapMarginM: 10,
  dragEnabled: true,
  dragMarginM: 20, // or dragMarginFrac of the radius if larger
  dragMarginFrac: 0.25,
  dragSeconds: 90, // outside for at least this long...
  dragMinFixes: 2, // ...over at least this many fixes
  alertDoubtful: false,
  holdS: 600, // a drag alert outlives its estimate this long
  departureKn: 3, // faster than this is a boat leaving, not dragging
  bowFirstKn: 1, // bow-first movement only counts above this (position noise)
  soundRadii: 2 // sound only within this many swing radii of the own anchor
}

const PATH = (kind, id) => `notifications.anchorMapper.${kind}.${id}`

const NORMAL = { state: 'normal', method: [], message: '' }

function angleDiff(a, b) {
  let d = Math.abs(a - b) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d
}

/**
 * Overlap and drag alerts about other vessels (SPEC 2.7, 3.1).
 *
 * Pure: it takes the own anchor, the published estimates and the fixes of other
 * vessels, and returns notification changes `[{ path, value }]` for the shell to send
 * on the own vessel. It never talks to the server itself.
 */
class AlertMonitor {
  constructor(options = {}, nameOf = () => undefined) {
    this.o = { ...DEFAULTS }
    for (const k of Object.keys(DEFAULTS)) if (options[k] !== undefined && options[k] !== null) this.o[k] = options[k]
    this.nameOf = nameOf
    this.own = null // { latitude, longitude, radiusM }
    this.estimates = new Map() // id -> estimate of the last cycle
    this.vessels = new Map() // id -> per-vessel alert state
  }

  _v(id) {
    let v = this.vessels.get(id)
    if (!v) {
      v = {
        overlap: null, // last notification value sent, or null when normal
        dragging: null,
        outside: [], // consecutive outside fixes { t, latitude, longitude }
        frozen: null, // { center, radiusM } the drag check is judged against
        last: null, // last fix { t, latitude, longitude }
        holdUntil: null
      }
      this.vessels.set(id, v)
    }
    return v
  }

  _label(id) {
    const name = this.nameOf(id)
    return name ? `${name} (MMSI ${id})` : `MMSI ${id}`
  }

  /** Active alert kinds for a vessel, for the map: ['overlap', 'dragging']. */
  alertsOf(id) {
    const v = this.vessels.get(id)
    if (!v) return []
    const out = []
    if (v.overlap) out.push('overlap')
    if (v.dragging) out.push('dragging')
    return out
  }

  _set(id, kind, value, changes) {
    const v = this._v(id)
    const prev = v[kind]
    if (value === null) {
      if (prev) {
        v[kind] = null
        changes.push({ path: PATH(kind, id), value: { ...NORMAL } })
      }
      return
    }
    if (prev && prev.state === value.state && prev.message === value.message) return
    v[kind] = value
    changes.push({ path: PATH(kind, id), value })
  }

  _forget(id) {
    const v = this.vessels.get(id)
    if (v && !v.overlap && !v.dragging && !v.frozen && v.outside.length === 0) this.vessels.delete(id)
  }

  // Strong, solid estimates only unless the user asked for doubtful ones as well.
  _solid(e, kind) {
    if (this.o.alertDoubtful) return true
    if (e.quality !== 'strong') return false
    // A mooring can overlap your circle but cannot drag.
    if (kind === 'dragging') return !(e.tags || []).includes('possibly-moored') && !(e.tags || []).includes('possible-mooring-buoy')
    return true
  }

  _radiusOf(e) {
    return e.kind === 'anchor' ? e.radiusM : e.area && e.area.semiMajorM
  }

  /** The own anchor changed (null = no anchor set). */
  setOwnAnchor(anchor, nowS) {
    const ok = anchor && Number.isFinite(anchor.latitude) && Number.isFinite(anchor.longitude) && Number.isFinite(anchor.radiusM)
    this.own = ok ? { latitude: anchor.latitude, longitude: anchor.longitude, radiusM: anchor.radiusM } : null
    const changes = []
    this._overlap(changes)
    // A sound drag alarm falls back to a warning without an own anchor, and back.
    for (const [id, v] of this.vessels) {
      if (v.dragging && v.last) this._raiseDrag(id, v, v.last, changes)
    }
    this._tick(nowS, changes)
    return changes
  }

  /** Per analysis cycle: the estimates just published. */
  onCycle(estimates, nowS) {
    const changes = []
    this.estimates = new Map(estimates.map((e) => [e.id, e]))
    this._overlap(changes)
    this._tick(nowS, changes)
    return changes
  }

  _overlap(changes) {
    const seen = new Set()
    if (this.o.overlapEnabled && this.own) {
      for (const e of this.estimates.values()) {
        const r = this._radiusOf(e)
        if (!Number.isFinite(r) || !e.center || !this._solid(e, 'overlap')) continue
        const id = e.id
        seen.add(id)
        const v = this._v(id)
        const m = this.o.overlapMarginM
        const gap = distanceM(this.own, e.center) - this.own.radiusM - r // < 0 means the circles overlap
        const active = !!v.overlap
        const raise = gap < m
        const stay = gap < m * 1.5 // hysteresis: half the margin
        if (raise || (active && stay)) {
          const n = Math.round(Math.abs(gap) / 5) * 5
          const message =
            gap < 0
              ? `Anchor overlap: ${this._label(id)} swings into your swing circle by about ${n} m`
              : `Anchor close: ${this._label(id)} swings within about ${n} m of your swing circle`
          this._set(id, 'overlap', { state: 'warn', method: ['visual'], message }, changes)
        } else {
          this._set(id, 'overlap', null, changes)
        }
      }
    }
    // Everything not (or no longer) evaluated clears.
    for (const [id, v] of this.vessels) {
      if (v.overlap && !seen.has(id)) this._set(id, 'overlap', null, changes)
    }
    for (const id of [...this.vessels.keys()]) this._forget(id)
  }

  /** Expire drag alerts whose estimate is gone and whose hold time has run out. */
  _tick(nowS, changes) {
    for (const [id, v] of this.vessels) {
      if (!v.dragging) continue
      if (this.estimates.has(id)) {
        v.holdUntil = null
      } else if (v.holdUntil === null) {
        v.holdUntil = nowS + this.o.holdS
      } else if (nowS >= v.holdUntil) {
        this._clearDrag(id, v, changes)
      }
    }
    // Frozen references of vessels that never alarmed die with their estimate.
    for (const [id, v] of this.vessels) {
      if (!v.dragging && v.frozen && !this.estimates.has(id)) {
        v.frozen = null
        v.outside = []
      }
    }
    for (const id of [...this.vessels.keys()]) this._forget(id)
  }

  _clearDrag(id, v, changes) {
    this._set(id, 'dragging', null, changes)
    v.frozen = null
    v.outside = []
    v.holdUntil = null
  }

  _marginFor(radiusM) {
    return Math.max(this.o.dragMarginM, this.o.dragMarginFrac * radiusM)
  }

  // Is this fix a boat leaving rather than dragging? Fast, or moving bow-first.
  _departing(fix, last) {
    if (!last) return false
    const dt = fix.t - last.t
    if (dt <= 0) return false
    const p = makeProjection(last.latitude, last.longitude)
    const [dx, dy] = p.toXY(fix.latitude, fix.longitude)
    const speed = Math.hypot(dx, dy) / dt
    if (speed > this.o.departureKn * KN) return true
    if (Number.isFinite(fix.heading) && speed > this.o.bowFirstKn * KN) {
      const course = Math.atan2(dx, dy)
      if (angleDiff(course, fix.heading) < Math.PI / 2) return true
    }
    return false
  }

  /**
   * A new fix of another vessel: `{ t (s), latitude, longitude, heading? (rad true) }`.
   * Evaluated on every fix, not per cycle, because a drag matters within minutes.
   */
  onFix(id, fix, nowS) {
    const changes = []
    if (!this.o.dragEnabled) return changes
    const est = this.estimates.get(id)
    let v = this.vessels.get(id)
    // Only vessels with a solid anchor estimate, or one already being judged.
    if (!(v && v.frozen) && !(est && est.kind === 'anchor' && this._solid(est, 'dragging'))) {
      if (v) v.last = null
      return changes
    }
    v = this._v(id)
    if (v.last && fix.t <= v.last.t) return changes // repeated or stale fix
    const prev = v.last
    v.last = { t: fix.t, latitude: fix.latitude, longitude: fix.longitude }

    const ref = v.frozen || { center: est.center, radiusM: est.radiusM }
    const margin = this._marginFor(ref.radiusM)
    const d = distanceM(fix, ref.center) - ref.radiusM // metres outside the swing circle

    if (this._departing(fix, prev) && !v.dragging) {
      v.outside = []
      v.frozen = null
      return changes
    }
    if (d > margin) {
      if (v.outside.length === 0) v.frozen = ref
      v.outside.push({ t: fix.t, latitude: fix.latitude, longitude: fix.longitude })
      const first = v.outside[0]
      if (v.dragging || (v.outside.length >= this.o.dragMinFixes && fix.t - first.t >= this.o.dragSeconds)) {
        this._raiseDrag(id, v, v.last, changes)
      }
    } else if (d <= margin / 2) {
      // Back inside by more than half the margin: the alert clears.
      v.outside = []
      if (v.dragging) this._clearDrag(id, v, changes)
      else v.frozen = null
    } else if (!v.dragging) {
      v.outside = [] // inside the hysteresis band: not a run of outside fixes
      v.frozen = null
    }
    this._forget(id)
    return changes
  }

  _raiseDrag(id, v, fix, changes) {
    const ref = v.frozen
    if (!ref) return
    const out = Math.round((distanceM(fix, ref.center) - ref.radiusM) / 5) * 5
    let loud = false
    if (this.own) {
      const near = this.o.soundRadii * Math.max(this.own.radiusM, ref.radiusM)
      loud = distanceM(this.own, fix) <= near
    }
    this._set(
      id,
      'dragging',
      {
        state: loud ? 'alarm' : 'warn',
        method: loud ? ['visual', 'sound'] : ['visual'],
        message: `Possible drag: ${this._label(id)} is ${Math.max(out, 0)} m outside its swing circle`
      },
      changes
    )
  }

  /** Plugin stop: every active alert goes back to normal. */
  clearAll() {
    const changes = []
    for (const [id, v] of this.vessels) {
      this._set(id, 'overlap', null, changes)
      this._set(id, 'dragging', null, changes)
      v.frozen = null
      v.outside = []
    }
    this.vessels.clear()
    this.estimates.clear()
    this.own = null
    return changes
  }
}

module.exports = { AlertMonitor, DEFAULTS }
