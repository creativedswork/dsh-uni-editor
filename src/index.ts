import type { Context } from '@deepseek-ai/cordis'
import { applyHost } from './host.js'
import type { Config } from './types.js'

export type * from './types.js'
export { buildCspHeader, normalizeCsp } from './sandbox.js'
export { publicToolName } from './host.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'mcp-apps'

/** Stable MCP Apps specification implemented by this package. */
export const MCP_APPS_SPEC_VERSION = '2026-01-26'

/** Required Harness services. */
export const inject = ['tools', 'webServer', 'systemPrompt']

/** Mount MCP connections, tool registrations, Host API, and the isolated Sandbox Proxy. */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  await applyHost(ctx, config)
}
