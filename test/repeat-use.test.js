'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { tagRepeatUse } = require('../src/repeat-use')
const { TrackStore } = require('../src/store')

const here = { latitude: 40.572, longitude: 0.552 }
const near = (dxM) => ({ latitude: here.latitude, longitude: here.longitude + dxM / 84600 })

test('two or more other vessels staying at the spot tags a possible mooring buoy', () => {
  const est = [{ id: 'A', center: here, tags: [] }]
  const stays = [
    { id: 'B', centroid: near(30) },
    { id: 'C', centroid: near(60) },
    { id: 'B', centroid: near(40) } // same vessel twice counts once
  ]
  tagRepeatUse(est, stays)
  assert.deepStrictEqual(est[0].tags, ['possible-mooring-buoy'])
})

test('a single other vessel is not enough, nor are far-away stays or its own history', () => {
  const est = [{ id: 'A', center: here, tags: [] }]
  tagRepeatUse(est, [{ id: 'B', centroid: near(30) }, { id: 'C', centroid: near(400) }, { id: 'A', centroid: near(5) }])
  assert.deepStrictEqual(est[0].tags, [])
})

test('existing tags are kept and the tag is not duplicated', () => {
  const est = [{ id: 'A', center: here, tags: ['possibly-moored'] }]
  const stays = [{ id: 'B', centroid: near(10) }, { id: 'C', centroid: near(10) }]
  tagRepeatUse(est, stays)
  tagRepeatUse(est, stays)
  assert.deepStrictEqual(est[0].tags, ['possibly-moored', 'possible-mooring-buoy'])
})

test('TrackStore thins fixes, drops out-of-order ones and prunes by age', () => {
  const s = new TrackStore({ maxAgeS: 100, minFixIntervalS: 30 })
  assert.ok(s.add('v', 0, 40, 0.5))
  assert.ok(!s.add('v', 10, 40, 0.5), 'too soon')
  assert.ok(s.add('v', 40, 40, 0.5))
  assert.ok(!s.add('v', 20, 40, 0.5), 'out of order')
  assert.ok(!s.add('v', NaN, 40, 0.5), 'bad time')
  assert.ok(s.add('v', 150, 40, 0.5))
  s.prune(160)
  assert.deepStrictEqual(s.get('v').map((f) => f.t), [150])
  s.prune(1000)
  assert.deepStrictEqual(s.ids(), [])
})
