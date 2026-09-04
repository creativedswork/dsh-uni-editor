import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AppBridge,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  ClientContext,
  ISessions,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {
  McpAppCatalogItem,
  McpAppPresentationMetaV1,
  McpAppView,
} from '../types.js'
import { ActiveAppAction } from './active-app-action.js'
import {
  appRegistry,
  type AppInstanceController,
  type AppSurface,
} from './app-registry.js'
import {
  APP_RUNTIME_INTERACTION_EVENT,
  appRuntimeInteractionsSuspended,
  computeInlineFrameClip,
  observeFramePlacement,
  type FrameClip,
} from './frame-placement.js'
import { currentViewId } from './view-binding.js'

const API_PREFIX = '/api/mcp-apps'
const CATALOG_REFRESH_MS = 5_000
const READY_TIMEOUT_MS = 10_000
const MIN_HEIGHT = 120
const MAX_HEIGHT = 800
const MAX_MESSAGE_CHARS = 16_384
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024
const FULLSCREEN_CHROME_HEIGHT = 44

type AppMessageParams = Parameters<NonNullable<AppBridge['onmessage']>>[0]
type AppMessageResult = Awaited<ReturnType<NonNullable<AppBridge['onmessage']>>>
type AppDownloadParams = Parameters<NonNullable<AppBridge['ondownloadfile']>>[0]
type AppDownloadResult = Awaited<ReturnType<NonNullable<AppBridge['ondownloadfile']>>>
type AppHostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>['hostContext']
>
type DisplayMode = 'inline' | 'fullscreen'

interface McpAppRowInjected {
  sendMessage: (params: AppMessageParams) => Promise<AppMessageResult>
}

/** Browser Cordis plugin name used by client diagnostics. */
export const name = 'mcp-apps-client'

/** Required Browser service. */
export const inject = ['slots', 'sessions']

async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_PREFIX}/${path}`, body === undefined
    ? { credentials: 'same-origin' }
    : {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
  const value = await response.json() as { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof value.error === 'string' ? value.error : `MCP Apps request failed (${response.status})`)
  }
  return value as T
}

function presentationMeta(value: unknown): McpAppPresentationMetaV1 | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const meta = value as Partial<McpAppPresentationMetaV1>
  if (meta.kind !== 'dsh/mcp-app'
    || meta.version !== 1
    || typeof meta.serverName !== 'string'
    || !/^[A-Za-z0-9_-]{1,32}$/.test(meta.serverName)
    || typeof meta.connectionGeneration !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.connectionGeneration)
    || (meta.sessionId !== undefined
      && (typeof meta.sessionId !== 'string'
        || meta.sessionId.length === 0
        || meta.sessionId.length > 256))
    || typeof meta.viewId !== 'string'
    || typeof meta.publicToolName !== 'string'
    || typeof meta.resourceUri !== 'string'
    || (meta.projectId !== undefined
      && (typeof meta.projectId !== 'string'
        || meta.projectId.length === 0
        || meta.projectId.length > 256))
    || (meta.revision !== undefined && typeof meta.revision !== 'string')
    || meta.result === null
    || typeof meta.result !== 'object') return undefined
  return meta as McpAppPresentationMetaV1
}

function fallbackText(block: ToolResultNode): string {
  return block.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n') || 'MCP App result unavailable.'
}

function loopbackSandboxOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('MCP Apps Sandbox Proxy is not a loopback HTTP origin')
  }
  return url.origin
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function waitForSandbox(iframe: HTMLIFrameElement, origin: string): Promise<void> {
  return timeout(new Promise<void>((resolve) => {
    const listener = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow
        || event.origin !== origin
        || event.data?.method !== 'ui/notifications/sandbox-proxy-ready') return
      window.removeEventListener('message', listener)
      resolve()
    }
    window.addEventListener('message', listener)
  }), READY_TIMEOUT_MS, 'MCP App Sandbox Proxy did not become ready')
}

function argsOf(block: ToolResultNode): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(block.call?.argsRaw ?? '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function textPrompt(params: AppMessageParams): Array<{ type: 'text'; text: string }> | undefined {
  if (params.role !== 'user' || params.content.length === 0) return undefined
  let chars = 0
  const content: Array<{ type: 'text'; text: string }> = []
  for (const block of params.content) {
    if (block.type !== 'text') return undefined
    chars += block.text.length
    if (chars > MAX_MESSAGE_CHARS) return undefined
    content.push({ type: 'text', text: block.text })
  }
  return content.some(block => block.text.trim() !== '') ? content : undefined
}

function downloadEmbedded(params: AppDownloadParams): AppDownloadResult {
  try {
    if (params.contents.length !== 1) return { isError: true }
    const content = params.contents[0]
    if (content?.type !== 'resource') return { isError: true }
    const resource = content.resource
    const uri = new URL(resource.uri)
    const filename = decodeURIComponent(uri.pathname.split('/').pop() ?? '')
    const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase()
    const expectedMimeType = new Map([
      ['.excalidraw', 'application/json'],
      ['.json', 'application/json'],
      ['.svg', 'image/svg+xml'],
      ['.png', 'image/png'],
    ]).get(extension)
    if (uri.protocol !== 'file:'
      || resource.mimeType !== expectedMimeType
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(filename)) {
      return { isError: true }
    }
    let blob: Blob
    if ('text' in resource && resource.mimeType !== 'image/png') {
      blob = new Blob([resource.text], { type: resource.mimeType })
    } else if ('blob' in resource && resource.mimeType === 'image/png') {
      if (resource.blob.length > Math.ceil(MAX_DOWNLOAD_BYTES * 4 / 3) + 4) {
        return { isError: true }
      }
      const binary = atob(resource.blob)
      blob = new Blob([
        Uint8Array.from(binary, byte => byte.charCodeAt(0)),
      ], { type: resource.mimeType })
    } else {
      return { isError: true }
    }
    if (blob.size > MAX_DOWNLOAD_BYTES) return { isError: true }
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = filename
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(href), 0)
    return {}
  } catch {
    return { isError: true }
  }
}

function appHostContext(
  iframe: HTMLIFrameElement,
  displayMode: DisplayMode,
  inlineContainer?: HTMLElement | null,
): AppHostContext {
  const bounds = iframe.getBoundingClientRect()
  const inlineBounds = inlineContainer?.getBoundingClientRect() ?? bounds
  return {
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    locale: navigator.language,
    platform: 'web',
    displayMode,
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: displayMode === 'fullscreen'
      ? {
          width: Math.max(1, Math.round(window.innerWidth)),
          height: Math.max(1, Math.round(window.innerHeight - FULLSCREEN_CHROME_HEIGHT)),
        }
      : {
          width: Math.max(1, Math.round(inlineBounds.width)),
          maxHeight: MAX_HEIGHT,
        },
  }
}

interface PersistentAppRuntime {
  identity: string
  clip: HTMLDivElement
  iframe: HTMLIFrameElement
  bridge?: AppBridge
  ready: boolean
  error?: string
  displayMode: DisplayMode
  frameHeight: number
  host?: HTMLElement
  stopPlacementObservation?: () => void
}

const persistentAppRuntimes = new Map<string, PersistentAppRuntime>()
let parkingRoot: HTMLElement | undefined


function appParkingRoot(): HTMLElement {
  if (parkingRoot === undefined) {
    parkingRoot = document.body.appendChild(document.createElement('div'))
    parkingRoot.dataset.mcpAppParking = ''
    Object.assign(parkingRoot.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483001',
      pointerEvents: 'none',
    })
  }
  return parkingRoot
}

function parkAppRuntime(runtime: PersistentAppRuntime): void {
  runtime.stopPlacementObservation?.()
  runtime.stopPlacementObservation = undefined
  runtime.host = undefined
  Object.assign(runtime.clip.style, {
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  })
  runtime.iframe.style.pointerEvents = 'none'
}

function inlineAppRuntimeClip(
  host: HTMLElement,
  bounds: DOMRect,
): FrameClip {
  const scrollport = host.closest<HTMLElement>('[data-conversation-scroll]')
  const composer = scrollport?.querySelector<HTMLElement>('[data-composer-seat]')
  return computeInlineFrameClip(
    bounds,
    scrollport?.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
    composer?.getBoundingClientRect(),
  )
}

function placeAppRuntime(runtime: PersistentAppRuntime): void {
  const host = runtime.host
  if (host === undefined || !host.isConnected) {
    parkAppRuntime(runtime)
    return
  }
  const bounds = host.getBoundingClientRect()
  const placement = runtime.displayMode === 'fullscreen'
    ? {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        visible: true,
      }
    : inlineAppRuntimeClip(host, bounds)
  const interactive = runtime.ready
    && placement.visible
    && !appRuntimeInteractionsSuspended()
  Object.assign(runtime.clip.style, {
    left: `${String(placement.left)}px`,
    top: `${String(placement.top)}px`,
    width: `${String(Math.max(1, placement.width))}px`,
    height: `${String(Math.max(1, placement.height))}px`,
    opacity: runtime.ready && placement.visible ? '1' : '0',
    pointerEvents: 'none',
  })
  Object.assign(runtime.iframe.style, {
    left: `${String(bounds.left - placement.left)}px`,
    top: `${String(bounds.top - placement.top)}px`,
    width: `${String(Math.max(1, bounds.width))}px`,
    height: `${String(Math.max(1, bounds.height))}px`,
    clipPath: 'none',
    opacity: '1',
    pointerEvents: interactive ? 'auto' : 'none',
  })
}

function disposeAppRuntime(runtime: PersistentAppRuntime): void {
  const bridge = runtime.bridge
  runtime.bridge = undefined
  runtime.ready = false
  runtime.stopPlacementObservation?.()
  runtime.stopPlacementObservation = undefined
  runtime.host = undefined
  runtime.clip.remove()
  if (bridge !== undefined) {
    void timeout(bridge.teardownResource({}), 1_000, 'MCP App teardown timed out')
      .catch(() => {})
      .finally(() => {
        void (bridge as unknown as { close(): Promise<void> }).close()
      })
  }
}

function clearPersistentAppRuntimes(): void {
  for (const runtime of persistentAppRuntimes.values()) disposeAppRuntime(runtime)
  persistentAppRuntimes.clear()
  parkingRoot?.remove()
  parkingRoot = undefined
}

function persistentAppRuntime(
  key: string,
  identity: string,
  title: string,
): PersistentAppRuntime {
  const current = persistentAppRuntimes.get(key)
  if (current?.identity === identity) return current
  if (current !== undefined) disposeAppRuntime(current)
  const clip = document.createElement('div')
  Object.assign(clip.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    opacity: '0',
    pointerEvents: 'none',
  })
  const iframe = document.createElement('iframe')
  iframe.title = title
  iframe.style.position = 'absolute'
  iframe.style.left = '0'
  iframe.style.top = '0'
  iframe.style.width = '1px'
  iframe.style.height = '320px'
  iframe.style.border = '0'
  iframe.style.background = 'transparent'
  iframe.style.opacity = '1'
  iframe.style.pointerEvents = 'none'
  clip.appendChild(iframe)
  appParkingRoot().appendChild(clip)
  const runtime: PersistentAppRuntime = {
    identity,
    clip,
    iframe,
    ready: false,
    displayMode: 'inline',
    frameHeight: 320,
  }
  persistentAppRuntimes.set(key, runtime)
  return runtime
}

function McpAppRow({
  block,
  callId,
  descriptor,
  sendMessage,
  sessionId,
}: ToolCallViewProps & McpAppRowInjected & { descriptor: McpAppCatalogItem }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const iframeHostRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<AppBridge>()
  const displayModeRef = useRef<DisplayMode>('inline')
  const inlineHeightRef = useRef(320)
  const requestSurfaceRef = useRef<(surface: AppSurface) => void>(() => {})
  const locateRef = useRef<() => void>(() => {})
  const locateFrameRef = useRef<number>()
  const locateTimerRef = useRef<number>()
  const scrollPositionRef = useRef<{ element: HTMLElement; top: number }>()
  const scrollRestoreFrameRef = useRef<number>()
  const sendMessageRef = useRef(sendMessage)
  const latestResultRef = useRef<CallToolResult>()
  const latestArgsRef = useRef<Record<string, unknown>>({})
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  const [ownsInstance, setOwnsInstance] = useState(false)
  const [displayMode, setDisplayMode] = useState<DisplayMode>('inline')
  const [frameHeight, setFrameHeight] = useState(320)
  const [located, setLocated] = useState(false)
  const [retry, setRetry] = useState(0)
  sendMessageRef.current = sendMessage

  const settled: ToolResultNode | undefined = 'kind' in block ? block : undefined
  const meta = presentationMeta(settled?.meta)
  const sessionKey = String(sessionId)
  const instanceId = meta?.projectId === undefined
    ? `${descriptor.serverName}:call:${callId}`
    : `${descriptor.serverName}:project:${meta.projectId}`
  const runtimeKey = `${sessionKey}\0${instanceId}`
  let viewId: string | undefined
  let bindingError: string | undefined
  if (meta !== undefined) {
    try {
      viewId = currentViewId(meta, descriptor)
    } catch (cause) {
      bindingError = cause instanceof Error ? cause.message : String(cause)
    }
  }
  const hasAppResult = settled !== undefined
    && meta !== undefined
    && bindingError === undefined
  const currentRuntimeIdentity = JSON.stringify([
    descriptor.connectionGeneration,
    descriptor.sandboxOrigin,
    descriptor.viewId,
    descriptor.resourceUri,
  ])
  const runtimeIdentity = viewId === undefined || meta === undefined
    ? ''
    : JSON.stringify([
        descriptor.connectionGeneration,
        descriptor.sandboxOrigin,
        viewId,
        meta.resourceUri,
      ])
  const runtime = useMemo(() => !ownsInstance || viewId === undefined
    ? undefined
    : persistentAppRuntime(
        runtimeKey,
        runtimeIdentity,
        `MCP App: ${descriptor.publicToolName}`,
      ), [descriptor.publicToolName, ownsInstance, retry, runtimeIdentity, runtimeKey, viewId])
  if (meta !== undefined && settled !== undefined) {
    latestResultRef.current = meta.result as CallToolResult
    latestArgsRef.current = argsOf(settled)
  }
  const controller = useMemo<AppInstanceController>(() => ({
    sessionId: sessionKey,
    instanceId,
    callId,
    publicToolName: descriptor.publicToolName,
    ready: false,
    surface: 'inline',
    result: latestResultRef.current,
    args: latestArgsRef.current,
    acceptResult: (result, args) => {
      latestResultRef.current = result as CallToolResult
      latestArgsRef.current = args
      bridgeRef.current?.sendToolInput({ arguments: args })
      bridgeRef.current?.sendToolResult(result as CallToolResult)
    },
    setOwner: owner => {
      setOwnsInstance(owner)
    },
    requestSurface: surface => { requestSurfaceRef.current(surface) },
    locate: () => { locateRef.current() },
  }), [callId, descriptor.publicToolName, instanceId, sessionKey])
  controller.surface = runtime?.displayMode ?? 'inline'
  controller.result = latestResultRef.current
  controller.args = latestArgsRef.current

  useEffect(() => {
    if (bindingError === undefined) return
    const stale = persistentAppRuntimes.get(runtimeKey)
    if (stale === undefined || stale.identity === currentRuntimeIdentity) return
    persistentAppRuntimes.delete(runtimeKey)
    disposeAppRuntime(stale)
  }, [bindingError, currentRuntimeIdentity, runtimeKey])

  requestSurfaceRef.current = surface => {
    const iframe = runtime?.iframe
    const previousSurface = displayModeRef.current
    if (surface === 'fullscreen' && previousSurface === 'inline') {
      const scrollport = rootRef.current?.closest<HTMLElement>('[data-conversation-scroll]')
      if (scrollport !== undefined && scrollport !== null) {
        scrollPositionRef.current = { element: scrollport, top: scrollport.scrollTop }
      }
    }
    const scrollPosition = scrollPositionRef.current
    displayModeRef.current = surface
    controller.surface = surface
    if (runtime !== undefined) runtime.displayMode = surface
    setDisplayMode(surface)
    if (iframe !== undefined) {
      window.requestAnimationFrame(() => {
        if (runtime !== undefined) placeAppRuntime(runtime)
      })
      bridgeRef.current?.setHostContext(appHostContext(iframe, surface, rootRef.current))
    }
    if (scrollPosition !== undefined && previousSurface !== surface) {
      if (scrollRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current)
      }
      scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
        if (scrollPosition.element.isConnected) {
          scrollPosition.element.scrollTop = scrollPosition.top
        }
      })
      if (surface === 'inline') scrollPositionRef.current = undefined
    }
  }
  locateRef.current = () => {
    requestSurfaceRef.current('inline')
    locateFrameRef.current = window.requestAnimationFrame(() => {
      const target = rootRef.current?.closest<HTMLElement>('[data-chat-anchor-key]')
        ?? rootRef.current
      const scrollport = target?.closest<HTMLElement>('[data-conversation-scroll]')
      if (target !== null && target !== undefined && scrollport !== null && scrollport !== undefined) {
        scrollport.scrollTo({
          behavior: 'auto',
          top: scrollport.scrollTop
            + target.getBoundingClientRect().top
            - scrollport.getBoundingClientRect().top,
        })
      } else {
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      setLocated(true)
      if (locateTimerRef.current !== undefined) window.clearTimeout(locateTimerRef.current)
      locateTimerRef.current = window.setTimeout(() => { setLocated(false) }, 1_800)
    })
  }

  useEffect(() => {
    if (!hasAppResult) return
    const dispose = appRegistry.register(controller)
    return () => {
      controller.ready = false
      dispose()
      if (locateFrameRef.current !== undefined) window.cancelAnimationFrame(locateFrameRef.current)
      if (locateTimerRef.current !== undefined) window.clearTimeout(locateTimerRef.current)
      if (scrollRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current)
      }
    }
  }, [controller, hasAppResult])

  useEffect(() => {
    const host = iframeHostRef.current
    if (!ownsInstance
      || runtime === undefined
      || host === null
      || !hasAppResult
      || viewId === undefined
      || latestResultRef.current === undefined) return
    const initialResult = latestResultRef.current
    const iframe = runtime.iframe
    runtime.host = host
    const positionFrame = (): void => { placeAppRuntime(runtime) }
    const stopPlacementObservation = observeFramePlacement(
      () => runtime.host === host && host.isConnected
        ? host.getBoundingClientRect()
        : undefined,
      positionFrame,
    )
    runtime.stopPlacementObservation = stopPlacementObservation
    const resizeObserver = new ResizeObserver(positionFrame)
    resizeObserver.observe(host)
    const scrollport = host.closest<HTMLElement>('[data-conversation-scroll]')
    const composer = scrollport?.querySelector<HTMLElement>('[data-composer-seat]')
    if (scrollport !== null && scrollport !== undefined) resizeObserver.observe(scrollport)
    if (composer !== null && composer !== undefined) resizeObserver.observe(composer)
    window.addEventListener('resize', positionFrame)
    window.addEventListener(APP_RUNTIME_INTERACTION_EVENT, positionFrame)
    document.addEventListener('scroll', positionFrame, true)
    positionFrame()
    displayModeRef.current = runtime.displayMode
    inlineHeightRef.current = runtime.frameHeight
    setDisplayMode(runtime.displayMode)
    setFrameHeight(runtime.frameHeight)
    setReady(runtime.ready)
    setError(runtime.error)
    positionFrame()
    let disposed = false
    let bridge = runtime.bridge

    const bindBridge = (current: AppBridge, viewId: string): void => {
      bridgeRef.current = current
      current.oncalltool = (params, extra) => api<CallToolResult>('tool', {
        viewId,
        name: params.name,
        arguments: params.arguments ?? {},
        sessionId: sessionKey,
        connectionGeneration: descriptor.connectionGeneration,
      }).then(result => {
        extra.signal.throwIfAborted()
        return result
      })
      current.onreadresource = (params, extra) => api<ReadResourceResult>('resource', {
        viewId,
        uri: params.uri,
      }).then(result => {
        extra.signal.throwIfAborted()
        return result
      })
      current.onmessage = (params, extra) => {
        extra.signal.throwIfAborted()
        return sendMessageRef.current(params)
      }
      current.onupdatemodelcontext = (params, extra) => {
        extra.signal.throwIfAborted()
        return api<Record<string, never>>('model-context', {
          viewId,
          sessionId: sessionKey,
          connectionGeneration: descriptor.connectionGeneration,
          ...params,
        }).then(result => {
          extra.signal.throwIfAborted()
          return result
        })
      }
      current.ondownloadfile = (params, extra) => {
        extra.signal.throwIfAborted()
        return downloadEmbedded(params)
      }
      current.onrequestdisplaymode = async ({ mode }, extra) => {
        extra.signal.throwIfAborted()
        if (mode !== 'inline' && mode !== 'fullscreen') return { mode: displayModeRef.current }
        return appRegistry.requestSurface(sessionKey, callId, mode)
          ? { mode }
          : { mode: displayModeRef.current }
      }
      current.onsizechange = params => {
        if (displayModeRef.current === 'fullscreen') return
        if (typeof params.height !== 'number' || !Number.isFinite(params.height)) return
        inlineHeightRef.current = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(params.height)))
        runtime.frameHeight = inlineHeightRef.current
        setFrameHeight(inlineHeightRef.current)
        positionFrame()
      }
    }

    const markReady = (current: AppBridge): void => {
      if (disposed
        || runtime.ready
        || runtime.bridge !== current
        || persistentAppRuntimes.get(runtimeKey) !== runtime) return
      current.sendToolInput({ arguments: latestArgsRef.current })
      current.sendToolResult(latestResultRef.current ?? initialResult)
      runtime.ready = true
      runtime.error = undefined
      controller.ready = true
      appRegistry.changed(controller)
      appRegistry.activate(sessionKey, callId)
      positionFrame()
      setError(undefined)
      setReady(true)
    }

    const run = async (): Promise<void> => {
      if (bridge !== undefined && runtime.ready) {
        bindBridge(bridge, viewId)
        bridge.sendToolInput({ arguments: latestArgsRef.current })
        bridge.sendToolResult(latestResultRef.current ?? initialResult)
        controller.ready = true
        appRegistry.changed(controller)
        positionFrame()
        setReady(true)
        return
      }
      controller.ready = false
      appRegistry.changed(controller)
      runtime.error = undefined
      setError(undefined)
      setReady(false)
      const view = await api<McpAppView>('view', { viewId })
      if (disposed) return
      const sandboxOrigin = loopbackSandboxOrigin(descriptor.sandboxOrigin)
      const sandboxReady = waitForSandbox(iframe, sandboxOrigin)
      const url = new URL('/sandbox.html', `${sandboxOrigin}/`)
      if (view.csp !== undefined) url.searchParams.set('csp', JSON.stringify(view.csp))
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
      iframe.referrerPolicy = 'origin'
      iframe.src = url.href
      await sandboxReady
      if (disposed || iframe.contentWindow === null) return

      bridge = new AppBridge(
        null,
        { name: 'DSH Uni Editor', version: '0.3.2' },
        {
          serverTools: {},
          serverResources: {},
          downloadFile: {},
          message: { text: {} },
          updateModelContext: { text: {}, structuredContent: {} },
        },
        {
          hostContext: appHostContext(iframe, displayModeRef.current, rootRef.current),
        },
      )
      runtime.bridge = bridge
      bridgeRef.current = bridge
      bindBridge(bridge, viewId)
      const initialized = timeout(new Promise<void>((resolve) => {
        const current = bridge
        if (current !== undefined) {
          current.oninitialized = () => {
            markReady(current)
            resolve()
          }
        }
      }), READY_TIMEOUT_MS, 'MCP App did not initialize')

      await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow))
      bridge.sendSandboxResourceReady({
        html: view.html,
        sandbox: 'allow-scripts allow-same-origin',
      })
      await initialized
    }

    void run().catch(cause => {
      if (!disposed) {
        runtime.ready = false
        runtime.error = cause instanceof Error ? cause.message : String(cause)
        controller.ready = false
        appRegistry.changed(controller)
        setError(runtime.error)
      }
    })
    return () => {
      disposed = true
      controller.ready = false
      appRegistry.changed(controller)
      resizeObserver.disconnect()
      window.removeEventListener('resize', positionFrame)
      window.removeEventListener(APP_RUNTIME_INTERACTION_EVENT, positionFrame)
      document.removeEventListener('scroll', positionFrame, true)
      if (runtime.stopPlacementObservation === stopPlacementObservation) {
        stopPlacementObservation()
        runtime.stopPlacementObservation = undefined
      }
      if (runtime.host === host) {
        parkAppRuntime(runtime)
      }
      if (meta.projectId === undefined || !runtime.ready) {
        if (persistentAppRuntimes.get(runtimeKey) === runtime) {
          persistentAppRuntimes.delete(runtimeKey)
          disposeAppRuntime(runtime)
        }
      }
      if (bridgeRef.current === bridge) bridgeRef.current = undefined
    }
  }, [
    callId,
    controller,
    descriptor.connectionGeneration,
    descriptor.sandboxOrigin,
    hasAppResult,
    ownsInstance,
    retry,
    runtime,
    runtimeKey,
    sessionKey,
    viewId,
  ])

  if (settled === undefined) {
    return <div data-mcp-app-status="running">Running MCP App tool...</div>
  }
  if (meta === undefined) {
    return <pre data-mcp-app-fallback>{fallbackText(settled)}</pre>
  }
  if (bindingError !== undefined) {
    return (
      <div data-mcp-app-error data-mcp-app-definition-error>
        <strong>MCP App unavailable</strong>
        <pre>{fallbackText(settled)}</pre>
        <small>{bindingError}</small>
      </div>
    )
  }
  if (!ownsInstance) {
    return (
      <div data-mcp-app-update={instanceId}>
        Editor updated in place.{' '}
        <button
          type="button"
          onClick={() => { appRegistry.locate(sessionKey, callId) }}
        >
          Locate Editor
        </button>
      </div>
    )
  }
  if (error !== undefined) {
    return (
      <div data-mcp-app-error>
        <strong>MCP App unavailable</strong>
        <pre>{fallbackText(settled)}</pre>
        <small>{error}</small>
        <button
          type="button"
          onClick={() => {
            if (runtime !== undefined) {
              if (persistentAppRuntimes.get(runtimeKey) === runtime) {
                persistentAppRuntimes.delete(runtimeKey)
              }
              disposeAppRuntime(runtime)
            }
            setError(undefined)
            setRetry(value => value + 1)
          }}
        >
          Retry
        </button>
      </div>
    )
  }
  const fullscreen = displayMode === 'fullscreen'
  return (
    <div
      ref={rootRef}
      data-mcp-app-view
      data-display-mode={displayMode}
      data-mcp-app-located={located || undefined}
      onFocusCapture={() => { appRegistry.activate(sessionKey, callId) }}
      onPointerDownCapture={() => { appRegistry.activate(sessionKey, callId) }}
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 0,
        height: fullscreen ? frameHeight : undefined,
        outline: located ? '2px solid var(--dsw-alias-state-business-primary)' : undefined,
        outlineOffset: located ? 4 : undefined,
      }}
    >
      <div
        data-mcp-app-surface
        style={{
          position: fullscreen ? 'fixed' : 'relative',
          width: '100%',
          minWidth: 0,
          ...(fullscreen
            ? {
                display: 'grid',
                gridTemplateRows: `${String(FULLSCREEN_CHROME_HEIGHT)}px minmax(0, 1fr)`,
                inset: 0,
                zIndex: 2147483000,
                height: '100vh',
                background: '#0b0d10',
              }
            : {}),
        }}
      >
        {!ready && <div data-mcp-app-status="loading">Loading MCP App...</div>}
        {fullscreen && (
          <div
            key="fullscreen-actions"
            data-mcp-app-fullscreen-actions
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
              boxSizing: 'border-box',
              padding: '6px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-base)',
            }}
          >
            <button
              type="button"
              onClick={() => { appRegistry.locate(sessionKey, callId) }}
              style={{
                padding: '6px 10px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: 'pointer',
              }}
            >
              Locate in Chat
            </button>
            <button
              type="button"
              aria-label="Exit fullscreen"
              title="Exit fullscreen"
              onClick={() => { appRegistry.requestSurface(sessionKey, callId, 'inline') }}
              style={{
                width: 32,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: 'pointer',
              }}
            >
              X
            </button>
          </div>
        )}
        <div
          key="frame-host"
          ref={iframeHostRef}
          data-mcp-app-frame-host
          style={{
            width: '100%',
            height: fullscreen ? '100%' : frameHeight,
          }}
        />
      </div>
    </div>
  )
}

function descriptorKey(item: McpAppCatalogItem): string {
  return JSON.stringify(item)
}

/** Register current MCP App tools into the dynamic keyed Tool view slot. */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions as unknown as ISessions
  ctx.effect(() => () => {
    appRegistry.clear()
    clearPersistentAppRuntimes()
  }, 'mcp-apps: clear app registry')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'mcp-apps-active',
      order: 30,
      label: 'MCP Apps',
    }, ActiveAppAction),
  )
  ctx.slots.inject('tool.call.toolview', () => {
    let stopped = false
    const registered = new Map<string, { key: string; dispose: () => void }>()

    const refresh = async (): Promise<void> => {
      const response = await api<{ items: McpAppCatalogItem[] }>('catalog')
      if (stopped) return
      const next = new Map(response.items.map(item => [item.publicToolName, item]))
      for (const [name, current] of registered) {
        const item = next.get(name)
        if (item !== undefined && descriptorKey(item) === current.key) continue
        current.dispose()
        registered.delete(name)
      }
      for (const [name, item] of next) {
        if (registered.has(name)) continue
        const dispose = ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: name,
            inject: sessionId => ({
              sendMessage: async (params: AppMessageParams): Promise<AppMessageResult> => {
                const content = textPrompt(params)
                const session = sessions.binding(sessionId)?.session
                if (content === undefined || session === undefined) return { isError: true }
                const result = await session.prompt(content, 'queue')
                return result.ok ? {} : { isError: true }
              },
            }),
          },
          (props: ToolCallViewProps & McpAppRowInjected) => (
            <McpAppRow {...props} descriptor={item} />
          ),
        )
        registered.set(name, { key: descriptorKey(item), dispose })
      }
    }

    void refresh().catch(error => { console.warn('mcp-apps: catalog refresh failed', error) })
    const timer = window.setInterval(() => {
      void refresh().catch(error => { console.warn('mcp-apps: catalog refresh failed', error) })
    }, CATALOG_REFRESH_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
      for (const entry of registered.values()) entry.dispose()
      registered.clear()
    }
  })
}
