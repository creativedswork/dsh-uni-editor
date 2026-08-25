/** JSON value accepted across the Host/Browser boundary. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Child-process MCP server configuration. */
export interface StdioServerConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  forwardWorkspace?: boolean
}

/** Streamable HTTP MCP server configuration. */
export interface HttpServerConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers?: Record<string, string>
}

/** One MCP server owned by this plugin. */
export type ServerConfig = StdioServerConfig | HttpServerConfig

/** Cordis plugin configuration. */
export interface Config {
  servers?: ServerConfig[]
  toolCallTimeoutMs?: number
  maxBodyBytes?: number
  maxResultMetaBytes?: number
  prompts?: {
    /**
     * Trusted MCP prompts injected into every Harness Agent system prompt.
     * Nothing is injected unless explicitly allowlisted here.
     */
    autoInject?: Array<{
      serverName: string
      name: string
      arguments?: Record<string, string>
    }>
  }
}

/** Canonical MCP result retained for the View but rendered as text for the model. */
export interface McpAppResult {
  content: JsonValue[]
  structuredContent?: JsonValue
  _meta?: JsonValue
  /** Host-admitted model content; never forwarded back into the MCP App. */
  modelContent?: JsonValue[]
}

/** Durable UI-only payload attached to a settled Harness tool result. */
export interface McpAppPresentationMetaV1 {
  kind: 'dsh/mcp-app'
  version: 1
  serverName: string
  connectionGeneration: string
  sessionId?: string
  viewId: string
  publicToolName: string
  resourceUri: string
  projectId?: string
  revision?: string
  result: McpAppResult
}

/** Browser-safe descriptor for one model-visible tool with an MCP App View. */
export interface McpAppCatalogItem {
  serverName: string
  connectionGeneration: string
  publicToolName: string
  resourceUri: string
  sandboxOrigin: string
  viewId: string
}

/** Validated UI resource returned to the trusted Browser plugin. */
export interface McpAppView {
  html: string
  csp?: {
    connectDomains?: string[]
    resourceDomains?: string[]
    frameDomains?: string[]
    baseUriDomains?: string[]
  }
}
