import type {
  McpAppCatalogItem,
  McpAppPresentationMetaV1,
} from '../types.js'

/** Resolve one persistent App instance across repeated tool calls. */
export function appInstanceId(
  meta: McpAppPresentationMetaV1 | undefined,
  serverName: string,
  callId: string,
): string {
  if (meta?.projectId !== undefined) {
    return `${serverName}:project:${meta.projectId}`
  }
  const structured = meta?.result.structuredContent
  const canvasPath = structured !== null
    && typeof structured === 'object'
    && !Array.isArray(structured)
    && typeof structured.canvasPath === 'string'
    && structured.canvasPath.length > 0
    && structured.canvasPath.length <= 512
    ? structured.canvasPath
    : undefined
  return canvasPath === undefined
    ? `${serverName}:call:${callId}`
    : `${serverName}:canvas:${canvasPath}`
}

/** Rebind a persisted App result to the current MCP Server process. */
export function currentViewId(
  meta: McpAppPresentationMetaV1,
  descriptor: McpAppCatalogItem,
): string {
  if (meta.publicToolName !== descriptor.publicToolName
    || meta.resourceUri !== descriptor.resourceUri) {
    throw new Error('MCP App definition no longer matches this tool result')
  }
  return descriptor.viewId
}
