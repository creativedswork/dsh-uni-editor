import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { appRegistry } from './app-registry.js'
import {
  observeFramePlacement,
  suspendAppRuntimeInteractions,
} from './frame-placement.js'

type ActiveAppActionProps = PropsRuntime<'conversation.session.header.actions'>

const rootStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'stretch',
  minWidth: 0,
  height: 28,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-secondary)',
}

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 0,
  padding: '3px 8px',
  border: 0,
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
}

const menuStyle: CSSProperties = {
  position: 'fixed',
  inset: 'auto',
  top: 0,
  left: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  boxSizing: 'border-box',
  width: 320,
  maxWidth: 'min(320px, calc(100vw - 32px))',
  maxHeight: 'min(420px, calc(100vh - 140px))',
  margin: 0,
  padding: 6,
  overflow: 'auto',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base))',
  boxShadow: 'var(--dsw-shadow-lv3)',
}

const appRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto auto',
  alignItems: 'center',
  gap: 6,
  minHeight: 38,
  padding: '4px 6px',
  borderRadius: 6,
}

const commandStyle: CSSProperties = {
  minHeight: 28,
  padding: '4px 7px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 5,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  lineHeight: '16px',
  cursor: 'pointer',
}

/** Persistent per-Session entry point for ready MCP App instances. */
export function ActiveAppAction({ sessionId }: ActiveAppActionProps) {
  const id = String(sessionId)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const subscribe = useCallback((listener: () => void) => appRegistry.subscribe(id, listener), [id])
  const getSnapshot = useCallback(() => appRegistry.snapshot(id), [id])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const instances = useMemo(
    () => snapshot.instances.filter(instance => instance.ready),
    [snapshot.instances],
  )
  const active = instances.find(instance => instance.callId === snapshot.activeCallId)
    ?? instances.at(-1)

  useEffect(() => {
    if (!open) return
    const resumeAppInteractions = suspendAppRuntimeInteractions()
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      resumeAppInteractions()
    }
  }, [open])

  useEffect(() => {
    if (instances.length === 0) setOpen(false)
  }, [instances.length])

  useLayoutEffect(() => {
    if (!open || rootRef.current === null || menuRef.current === null) return
    const menu = menuRef.current
    const anchorElement = rootRef.current
    menu.setAttribute('popover', 'manual')
    menu.showPopover()
    const position = (): void => {
      const anchor = anchorElement.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewportLeft = viewport?.offsetLeft ?? 0
      const viewportTop = viewport?.offsetTop ?? 0
      const viewportWidth = viewport?.width ?? window.innerWidth
      const viewportHeight = viewport?.height ?? window.innerHeight
      menu.style.maxWidth = `${String(Math.max(1, viewportWidth - 32))}px`
      menu.style.maxHeight = `${String(Math.max(1, viewportHeight - 32))}px`
      const bounds = menu.getBoundingClientRect()
      const below = anchor.bottom + 5
      const above = anchor.top - bounds.height - 5
      const minLeft = viewportLeft + 16
      const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - bounds.width - 16)
      menu.style.top = `${String(
        below + bounds.height <= viewportTop + viewportHeight - 16
          ? below
          : Math.max(viewportTop + 16, above),
      )}px`
      menu.style.left = `${String(Math.max(minLeft, Math.min(anchor.left, maxLeft)))}px`
    }
    position()
    const stopPlacementObservation = observeFramePlacement(() => {
      const { left, top, right, bottom } = anchorElement.getBoundingClientRect()
      return { left, top, right, bottom }
    }, position)
    const observer = new ResizeObserver(position)
    observer.observe(menu)
    window.addEventListener('resize', position)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    document.addEventListener('scroll', position, true)
    return () => {
      stopPlacementObservation()
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
      document.removeEventListener('scroll', position, true)
      if (menu.matches(':popover-open')) menu.hidePopover()
    }
  }, [open])

  if (active === undefined) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      data-mcp-app-header-action
      style={rootStyle}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        style={{ ...buttonStyle, maxWidth: 220 }}
        title={`Open ${active.publicToolName} fullscreen`}
        onClick={() => { appRegistry.requestSurface(id, active.callId, 'fullscreen') }}
      >
        <span
          data-mcp-app-active-name
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {active.publicToolName}
        </span>
        {instances.length > 1 && (
          <span
            data-mcp-app-count
            style={{ flex: 'none', marginLeft: 5, color: 'var(--dsw-alias-label-caption)' }}
          >
            +{instances.length - 1}
          </span>
        )}
      </button>
      <button
        ref={triggerRef}
        type="button"
        aria-label="MCP App actions"
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          ...buttonStyle,
          flex: 'none',
          width: 26,
          justifyContent: 'center',
          padding: 0,
          borderLeft: '1px solid var(--dsw-alias-border-l2)',
        }}
        onClick={() => { setOpen(current => !current) }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRight: '1.5px solid currentColor',
            borderBottom: '1.5px solid currentColor',
            transform: open ? 'rotate(225deg) translate(-1px, -1px)' : 'rotate(45deg) translate(-1px, -1px)',
          }}
        />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="MCP Apps"
          style={menuStyle}
        >
          {instances.map(instance => {
            const isActive = instance.callId === active.callId
            return (
              <div
                key={instance.callId}
                data-mcp-app-menu-item={instance.callId}
                style={{
                  ...appRowStyle,
                  background: isActive ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    title={instance.publicToolName}
                    style={{
                      overflow: 'hidden',
                      color: 'var(--dsw-alias-label-primary)',
                      fontSize: 12,
                      lineHeight: '18px',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {instance.publicToolName}
                  </div>
                  <div
                    title={isActive ? 'Active' : instance.callId}
                    style={{
                      overflow: 'hidden',
                      color: 'var(--dsw-alias-label-caption)',
                      fontFamily: 'var(--dsw-font-mono)',
                      fontSize: 11,
                      lineHeight: '16px',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isActive ? 'Active' : instance.callId}
                  </div>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  style={commandStyle}
                  onClick={() => {
                    setOpen(false)
                    appRegistry.requestSurface(id, instance.callId, 'fullscreen')
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={commandStyle}
                  onClick={() => {
                    setOpen(false)
                    appRegistry.locate(id, instance.callId)
                  }}
                >
                  Locate
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
