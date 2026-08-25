export interface FrameRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface FrameViewport {
  width: number
  height: number
}

export interface FrameClip {
  clipPath: string
  visible: boolean
}

export interface FramePlacementScheduler {
  request(callback: FrameRequestCallback): number
  cancel(handle: number): void
}

export const APP_RUNTIME_INTERACTION_EVENT = 'dsh:mcp-app-interaction-change'

const interactionLocks = new Set<symbol>()

function notifyInteractionChange(): void {
  if (typeof globalThis.dispatchEvent === 'function') {
    globalThis.dispatchEvent(new Event(APP_RUNTIME_INTERACTION_EVENT))
  }
}

export function appRuntimeInteractionsSuspended(): boolean {
  return interactionLocks.size > 0
}

function sameRect(left: FrameRect | undefined, right: FrameRect | undefined): boolean {
  return left === right || (left !== undefined
    && right !== undefined
    && left.left === right.left
    && left.top === right.top
    && left.right === right.right
    && left.bottom === right.bottom)
}

/** Share one animation-frame loop across mounted fixed App frames. */
export function createFramePlacementObserver(
  scheduler: FramePlacementScheduler,
): (
  read: () => FrameRect | undefined,
  changed: () => void,
) => () => void {
  const observations = new Map<symbol, {
    read: () => FrameRect | undefined
    changed: () => void
    previous: FrameRect | undefined
  }>()
  let frame: number | undefined
  const schedule = (): void => {
    if (frame === undefined && observations.size > 0) frame = scheduler.request(check)
  }
  const check: FrameRequestCallback = () => {
    frame = undefined
    for (const observation of observations.values()) {
      const current = observation.read()
      if (sameRect(current, observation.previous)) continue
      observation.previous = current
      observation.changed()
    }
    schedule()
  }
  return (read, changed) => {
    const id = Symbol()
    observations.set(id, { read, changed, previous: read() })
    schedule()
    return () => {
      if (!observations.delete(id) || observations.size > 0 || frame === undefined) return
      scheduler.cancel(frame)
      frame = undefined
    }
  }
}

const observeBrowserFramePlacement = createFramePlacementObserver({
  request: callback => requestAnimationFrame(callback),
  cancel: handle => cancelAnimationFrame(handle),
})

export function observeFramePlacement(
  read: () => FrameRect | undefined,
  changed: () => void,
): () => void {
  return observeBrowserFramePlacement(read, changed)
}

/** Pause fixed App frame hit testing while Host chrome overlays are open. */
export function suspendAppRuntimeInteractions(): () => void {
  const lock = Symbol()
  interactionLocks.add(lock)
  notifyInteractionChange()
  return () => {
    if (!interactionLocks.delete(lock)) return
    notifyInteractionChange()
  }
}

/** Keep a fixed inline App frame inside its original scrollport hit-test area. */
export function computeInlineFrameClip(
  bounds: FrameRect,
  scrollport: FrameRect | undefined,
  viewport: FrameViewport,
  occluder?: FrameRect,
): FrameClip {
  if (scrollport === undefined) return { clipPath: 'none', visible: true }
  const left = Math.max(bounds.left, scrollport.left, 0)
  const top = Math.max(bounds.top, scrollport.top, 0)
  const right = Math.min(bounds.right, scrollport.right, viewport.width)
  const viewportBottom = Math.min(bounds.bottom, scrollport.bottom, viewport.height)
  const overlapsOccluder = occluder !== undefined
    && left < occluder.right
    && right > occluder.left
    && top < occluder.bottom
    && viewportBottom > occluder.top
  const bottom = Math.min(
    viewportBottom,
    overlapsOccluder ? occluder.top : Number.POSITIVE_INFINITY,
  )
  if (right <= left || bottom <= top) {
    return { clipPath: 'inset(50%)', visible: false }
  }
  return {
    clipPath: `inset(${String(top - bounds.top)}px ${String(bounds.right - right)}px ${String(bounds.bottom - bottom)}px ${String(left - bounds.left)}px)`,
    visible: true,
  }
}
