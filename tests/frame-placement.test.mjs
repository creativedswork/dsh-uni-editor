import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appRuntimeInteractionsSuspended,
  computeInlineFrameClip,
  createFramePlacementObserver,
  suspendAppRuntimeInteractions,
} from '../src/client/frame-placement.ts'

const viewport = { width: 1440, height: 1000 }

test('clips a fixed App frame at the conversation scrollport', () => {
  assert.deepEqual(
    computeInlineFrameClip(
      { left: 300, top: -200, right: 1200, bottom: 600 },
      { left: 350, top: 94, right: 1400, bottom: 900 },
      viewport,
    ),
    {
      clipPath: 'inset(294px 0px 0px 50px)',
      visible: true,
    },
  )
})

test('disables hit testing when a fixed App frame is outside the scrollport', () => {
  assert.deepEqual(
    computeInlineFrameClip(
      { left: 300, top: -800, right: 1200, bottom: -100 },
      { left: 350, top: 94, right: 1400, bottom: 900 },
      viewport,
    ),
    {
      clipPath: 'inset(50%)',
      visible: false,
    },
  )
})

test('leaves an inline App frame uncut without a scrollport', () => {
  assert.deepEqual(
    computeInlineFrameClip(
      { left: 300, top: 100, right: 1200, bottom: 800 },
      undefined,
      viewport,
    ),
    {
      clipPath: 'none',
      visible: true,
    },
  )
})

test('clips an inline App frame above the sticky composer', () => {
  assert.deepEqual(
    computeInlineFrameClip(
      { left: 300, top: 100, right: 1200, bottom: 950 },
      { left: 280, top: 76, right: 1440, bottom: 1000 },
      viewport,
      { left: 280, top: 800, right: 1432, bottom: 1000 },
    ),
    {
      clipPath: 'inset(0px 0px 150px 0px)',
      visible: true,
    },
  )
})

test('disables hit testing when the sticky composer fully covers an inline App frame', () => {
  assert.deepEqual(
    computeInlineFrameClip(
      { left: 300, top: 850, right: 1200, bottom: 950 },
      { left: 280, top: 76, right: 1440, bottom: 1000 },
      viewport,
      { left: 280, top: 800, right: 1432, bottom: 1000 },
    ),
    {
      clipPath: 'inset(50%)',
      visible: false,
    },
  )
})

test('ignores an occluder outside the inline App frame', () => {
  assert.deepEqual(
    computeInlineFrameClip(
      { left: 300, top: 100, right: 1200, bottom: 700 },
      { left: 280, top: 76, right: 1440, bottom: 1000 },
      viewport,
      { left: 280, top: 800, right: 1432, bottom: 1000 },
    ),
    {
      clipPath: 'inset(0px 0px 0px 0px)',
      visible: true,
    },
  )
})

test('keeps App frame interactions suspended until every Host overlay closes', () => {
  const releaseFirst = suspendAppRuntimeInteractions()
  const releaseSecond = suspendAppRuntimeInteractions()
  assert.equal(appRuntimeInteractionsSuspended(), true)

  releaseFirst()
  assert.equal(appRuntimeInteractionsSuspended(), true)
  releaseSecond()
  assert.equal(appRuntimeInteractionsSuspended(), false)

  releaseSecond()
  assert.equal(appRuntimeInteractionsSuspended(), false)
})

test('shares one frame loop, observes layout-only movement, and stops when unmounted', () => {
  const frames = new Map()
  let nextFrame = 0
  const cancelled = []
  const observe = createFramePlacementObserver({
    request(callback) {
      nextFrame += 1
      frames.set(nextFrame, callback)
      return nextFrame
    },
    cancel(handle) {
      cancelled.push(handle)
      frames.delete(handle)
    },
  })
  let firstRect = { left: 10, top: 20, right: 110, bottom: 220 }
  let secondRect = { left: 30, top: 40, right: 130, bottom: 240 }
  let firstPlacements = 0
  let secondPlacements = 0
  const stopFirst = observe(() => firstRect, () => { firstPlacements += 1 })
  const stopSecond = observe(() => secondRect, () => { secondPlacements += 1 })
  assert.equal(frames.size, 1)

  const flush = () => {
    const [handle, callback] = frames.entries().next().value
    frames.delete(handle)
    callback(0)
  }
  flush()
  assert.equal(firstPlacements, 0)
  assert.equal(secondPlacements, 0)
  assert.equal(frames.size, 1)

  firstRect = { ...firstRect, top: 75, bottom: 275 }
  flush()
  assert.equal(firstPlacements, 1)
  assert.equal(secondPlacements, 0)

  stopFirst()
  secondRect = { ...secondRect, left: 80, right: 180 }
  flush()
  assert.equal(firstPlacements, 1)
  assert.equal(secondPlacements, 1)

  stopSecond()
  assert.equal(frames.size, 0)
  assert.equal(cancelled.length, 1)
})
