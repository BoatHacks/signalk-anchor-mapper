'use strict'

const { distanceM } = require('./geo')

/**
 * Tag anchor estimates that sit where several other vessels have also been
 * stationary for a long time. That pattern means a berth, mooring buoy or
 * other fixed structure rather than a free anchor. Real anchorages rarely have
 * other vessels' long stays within 100 m of the same fitted centre.
 *
 * estimates: [{ id, center: { latitude, longitude }, tags: [] }]  (mutated: tag added)
 * stays:     [{ id, centroid: { latitude, longitude } }]  long stationary episodes of ALL vessels
 */
function tagRepeatUse(estimates, stays, opts = {}) {
  const radiusM = opts.radiusM ?? 100
  const minOthers = opts.minOtherVessels ?? 2
  for (const est of estimates) {
    const others = new Set()
    for (const s of stays) {
      if (s.id !== est.id && distanceM(est.center, s.centroid) <= radiusM) others.add(s.id)
    }
    if (others.size >= minOthers && !est.tags.includes('possible-mooring-buoy')) {
      est.tags.push('possible-mooring-buoy')
    }
  }
  return estimates
}

module.exports = { tagRepeatUse }
