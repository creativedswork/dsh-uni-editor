export type AppSurface = 'inline' | 'fullscreen'

export interface AppInstanceController {
  sessionId: string
  instanceId: string
  callId: string
  publicToolName: string
  ready: boolean
  surface: AppSurface
  result: unknown
  args: Record<string, unknown>
  acceptResult(result: unknown, args: Record<string, unknown>): void
  setOwner(owner: boolean): void
  requestSurface(surface: AppSurface): void
  locate(): void
}

export interface AppInstanceSnapshot {
  sessionId: string
  instanceId: string
  callId: string
  publicToolName: string
  ready: boolean
  surface: AppSurface
}

export interface SessionAppSnapshot {
  activeCallId?: string
  instances: readonly AppInstanceSnapshot[]
}

interface SessionState {
  activeCallId?: string
  controllers: Map<string, AppInstanceController>
  owners: Map<string, string>
}

const EMPTY_SNAPSHOT: SessionAppSnapshot = Object.freeze({
  instances: Object.freeze([]),
})

export class SessionAppRegistry {
  private readonly sessions = new Map<string, SessionState>()
  private readonly snapshots = new Map<string, SessionAppSnapshot>()
  private readonly listeners = new Map<string, Set<() => void>>()

  register(controller: AppInstanceController): () => void {
    const state = this.sessions.get(controller.sessionId) ?? {
      controllers: new Map<string, AppInstanceController>(),
      owners: new Map<string, string>(),
    }
    this.sessions.set(controller.sessionId, state)
    state.controllers.set(controller.callId, controller)
    const ownerCallId = state.owners.get(controller.instanceId)
    const owner = ownerCallId === undefined
      ? undefined
      : state.controllers.get(ownerCallId)
    if (owner === undefined || owner === controller) {
      state.owners.set(controller.instanceId, controller.callId)
      controller.setOwner(true)
      state.activeCallId ??= controller.callId
    } else {
      controller.setOwner(false)
      owner.acceptResult(controller.result, controller.args)
    }
    this.publish(controller.sessionId)

    return () => {
      const current = this.sessions.get(controller.sessionId)
      if (current?.controllers.get(controller.callId) !== controller) return
      current.controllers.delete(controller.callId)
      if (current.owners.get(controller.instanceId) === controller.callId) {
        const replacement = [...current.controllers.values()]
          .filter(candidate => candidate.instanceId === controller.instanceId)
          .at(-1)
        if (replacement === undefined) {
          current.owners.delete(controller.instanceId)
        } else {
          current.owners.set(controller.instanceId, replacement.callId)
          replacement.setOwner(true)
        }
        if (current.activeCallId === controller.callId) {
          current.activeCallId = replacement?.callId
            ?? [...current.owners.values()].at(-1)
        }
      }
      if (current.controllers.size === 0) this.sessions.delete(controller.sessionId)
      this.publish(controller.sessionId)
    }
  }

  changed(controller: AppInstanceController): void {
    const state = this.sessions.get(controller.sessionId)
    if (state?.controllers.get(controller.callId) !== controller
      || state.owners.get(controller.instanceId) !== controller.callId) return
    this.publish(controller.sessionId)
  }

  activate(sessionId: string, callId: string): boolean {
    const state = this.sessions.get(sessionId)
    const requested = state?.controllers.get(callId)
    if (state === undefined || requested === undefined) return false
    const ownerCallId = state.owners.get(requested.instanceId)
    if (ownerCallId === undefined) return false
    state.activeCallId = ownerCallId
    this.publish(sessionId)
    return true
  }

  requestSurface(sessionId: string, callId: string, surface: AppSurface): boolean {
    const state = this.sessions.get(sessionId)
    const requested = state?.controllers.get(callId)
    const ownerCallId = requested === undefined
      ? undefined
      : state?.owners.get(requested.instanceId)
    const target = ownerCallId === undefined ? undefined : state?.controllers.get(ownerCallId)
    if (state === undefined || target === undefined) return false
    if (surface === 'fullscreen') {
      for (const controller of state.controllers.values()) {
        if (controller !== target && controller.surface === 'fullscreen') {
          controller.requestSurface('inline')
        }
      }
    }
    state.activeCallId = target.callId
    target.requestSurface(surface)
    this.publish(sessionId)
    return true
  }

  locate(sessionId: string, callId: string): boolean {
    const state = this.sessions.get(sessionId)
    const requested = state?.controllers.get(callId)
    const ownerCallId = requested === undefined
      ? undefined
      : state?.owners.get(requested.instanceId)
    const target = ownerCallId === undefined ? undefined : state?.controllers.get(ownerCallId)
    if (state === undefined || target === undefined) return false
    state.activeCallId = target.callId
    target.locate()
    this.publish(sessionId)
    return true
  }

  snapshot(sessionId: string): SessionAppSnapshot {
    return this.snapshots.get(sessionId) ?? EMPTY_SNAPSHOT
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    this.listeners.set(sessionId, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  clear(): void {
    const sessionIds = new Set([...this.sessions.keys(), ...this.listeners.keys()])
    this.sessions.clear()
    this.snapshots.clear()
    for (const sessionId of sessionIds) {
      for (const listener of this.listeners.get(sessionId) ?? []) listener()
    }
  }

  private publish(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      this.snapshots.delete(sessionId)
    } else {
      this.snapshots.set(sessionId, Object.freeze({
        ...(state.activeCallId === undefined ? {} : { activeCallId: state.activeCallId }),
        instances: Object.freeze([...state.owners.values()].flatMap(callId => {
          const controller = state.controllers.get(callId)
          return controller === undefined ? [] : [Object.freeze({
          sessionId: controller.sessionId,
          instanceId: controller.instanceId,
          callId: controller.callId,
          publicToolName: controller.publicToolName,
          ready: controller.ready,
          surface: controller.surface,
          })]
        })),
      }))
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}

export const appRegistry = new SessionAppRegistry()
