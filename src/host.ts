import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolResultSchema,
  PromptListChangedNotificationSchema,
  ReadResourceResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Prompt,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import {
  RESOURCE_MIME_TYPE,
  getToolUiResourceUri,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ToolDefinition,
  ToolExecution,
} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { renderInjectedPrompt } from './prompt-injection.js'
import { normalizeCsp, startSandboxServer } from './sandbox.js'
import type {
  Config,
  JsonValue,
  McpAppCatalogItem,
  McpAppPresentationMetaV1,
  McpAppResult,
  McpAppView,
  ServerConfig,
} from './types.js'

const API_PREFIX = '/api/mcp-apps'
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BODY_BYTES = 512 * 1024
const DEFAULT_MAX_RESULT_META_BYTES = 256 * 1024
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const DSH_WORKSPACE_META_KEY = 'ai.deepseek.dsh/workspace'

interface ResolvedConfig {
  servers: ServerConfig[]
  toolCallTimeoutMs: number
  maxBodyBytes: number
  maxResultMetaBytes: number
  promptInjections: PromptInjection[]
}

type PromptInjection = NonNullable<NonNullable<Config['prompts']>['autoInject']>[number]

interface Visibility {
  app: boolean
  model: boolean
}

interface ViewBinding {
  item: McpAppCatalogItem
  rawToolName: string
  state: ServerState
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`mcp-apps: ${name} must be a positive safe integer`)
  }
  return resolved
}

function resolveConfig(config: Config | undefined): ResolvedConfig {
  const servers = config?.servers ?? []
  const names = new Set<string>()
  for (const server of servers) {
    if (!SERVER_NAME_PATTERN.test(server.serverName)) {
      throw new Error(`mcp-apps: invalid serverName ${JSON.stringify(server.serverName)}`)
    }
    if (names.has(server.serverName)) {
      throw new Error(`mcp-apps: duplicate serverName ${JSON.stringify(server.serverName)}`)
    }
    names.add(server.serverName)
    if (server.transport === 'stdio' && server.command === '') {
      throw new Error(`mcp-apps(${server.serverName}): command is required`)
    }
    if (server.transport === 'streamable-http') {
      const url = new URL(server.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`mcp-apps(${server.serverName}): URL must use http or https`)
      }
    }
  }
  const promptInjections = config?.prompts?.autoInject ?? []
  const promptKeys = new Set<string>()
  for (const injection of promptInjections) {
    if (typeof injection.serverName !== 'string' || typeof injection.name !== 'string') {
      throw new Error('mcp-apps: auto-injected prompt serverName and name must be strings')
    }
    if (!names.has(injection.serverName)) {
      throw new Error(`mcp-apps: auto-injected prompt references unknown server ${JSON.stringify(injection.serverName)}`)
    }
    if (injection.name === '' || injection.name.length > 128) {
      throw new Error('mcp-apps: auto-injected prompt name must contain 1-128 characters')
    }
    const key = `${injection.serverName}\0${injection.name}`
    if (promptKeys.has(key)) {
      throw new Error(`mcp-apps: duplicate auto-injected prompt ${JSON.stringify(injection.name)}`)
    }
    promptKeys.add(key)
    if (injection.arguments !== undefined
      && (injection.arguments === null
        || typeof injection.arguments !== 'object'
        || Array.isArray(injection.arguments))) {
      throw new Error('mcp-apps: auto-injected prompt arguments must be an object')
    }
    for (const [name, value] of Object.entries(injection.arguments ?? {})) {
      if (name === '' || typeof value !== 'string') {
        throw new Error('mcp-apps: auto-injected prompt arguments must be named strings')
      }
    }
  }
  return {
    servers,
    toolCallTimeoutMs: positiveInteger(config?.toolCallTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS, 'toolCallTimeoutMs'),
    maxBodyBytes: positiveInteger(config?.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes'),
    maxResultMetaBytes: positiveInteger(
      config?.maxResultMetaBytes,
      DEFAULT_MAX_RESULT_META_BYTES,
      'maxResultMetaBytes',
    ),
    promptInjections,
  }
}

/** Stable Harness-facing name for one MCP tool identity. */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

function visibilityOf(tool: Tool): Visibility {
  const ui = tool._meta?.ui
  if (ui === undefined || ui === null || typeof ui !== 'object' || Array.isArray(ui)) {
    return { app: true, model: true }
  }
  const visibility = (ui as Record<string, unknown>).visibility
  if (visibility === undefined) return { app: true, model: true }
  if (!Array.isArray(visibility)
    || visibility.length === 0
    || visibility.some(value => value !== 'app' && value !== 'model')) {
    throw new Error(`tool ${JSON.stringify(tool.name)} has invalid _meta.ui.visibility`)
  }
  return {
    app: visibility.includes('app'),
    model: visibility.includes('model'),
  }
}

function jsonValue(value: unknown, label: string): JsonValue {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error(`${label} is not JSON`)
  return JSON.parse(encoded) as JsonValue
}

function resultValue(result: CallToolResult): McpAppResult {
  if (!Array.isArray(result.content)) throw new Error('MCP tool result content must be an array')
  return {
    content: jsonValue(result.content, 'MCP tool result content') as JsonValue[],
    ...result.structuredContent === undefined
      ? {}
      : { structuredContent: jsonValue(result.structuredContent, 'MCP structuredContent') },
    ...result._meta === undefined ? {} : { _meta: jsonValue(result._meta, 'MCP result _meta') },
  }
}

function resultText(result: McpAppResult, rawName: string): string {
  const parts: string[] = []
  for (const block of result.content) {
    if (block !== null
      && typeof block === 'object'
      && !Array.isArray(block)
      && block.type === 'text'
      && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : `Tool "${rawName}" completed without text output.`
}

function createTransport(config: ServerConfig) {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      ...config.cwd === undefined || config.cwd === '' ? {} : { cwd: config.cwd },
      ...config.env === undefined ? {} : { env: config.env },
    })
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  })
}

class ServerState {
  readonly client: Client
  readonly tools = new Map<string, { tool: Tool; visibility: Visibility }>()
  private toolDisposers = new Map<string, () => void>()
  private promptDisposers: Array<() => void> = []
  private viewIds = new Set<string>()

  constructor(
    private readonly ctx: Context,
    readonly config: ServerConfig,
    private readonly host: McpAppsHost,
    private readonly resolved: ResolvedConfig,
  ) {
    this.client = new Client(
      { name: 'dsh-uni-editor', version: '0.3.1' },
      {
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: [RESOURCE_MIME_TYPE],
            },
          },
        },
      } as ConstructorParameters<typeof Client>[1],
    )
  }

  async start(): Promise<void> {
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.sync()
      } catch (error) {
        this.ctx.logger.error(`mcp-apps(${this.config.serverName}): tool re-sync failed: ${String(error)}`)
      }
    })
    this.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      try {
        await this.syncPrompts()
      } catch (error) {
        this.ctx.logger.error(`mcp-apps(${this.config.serverName}): prompt re-sync failed: ${String(error)}`)
      }
    })
    await this.client.connect(createTransport(this.config))
    await Promise.all([this.sync(), this.syncPrompts()])
  }

  private async listTools(): Promise<Tool[]> {
    if (this.client.getServerCapabilities()?.tools === undefined) return []
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await this.client.listTools(cursor === undefined ? {} : { cursor })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return tools
  }

  private async listPrompts(): Promise<Prompt[]> {
    if (this.client.getServerCapabilities()?.prompts === undefined) return []
    const prompts: Prompt[] = []
    let cursor: string | undefined
    do {
      const page = await this.client.listPrompts(cursor === undefined ? {} : { cursor })
      prompts.push(...page.prompts)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return prompts
  }

  private async syncPrompts(): Promise<void> {
    const injections = this.resolved.promptInjections
      .filter(injection => injection.serverName === this.config.serverName)
    if (injections.length === 0) return
    if (this.client.getServerCapabilities()?.prompts === undefined) {
      throw new Error(`mcp-apps(${this.config.serverName}): configured autoInject prompts but server has no prompts capability`)
    }
    const available = new Set((await this.listPrompts()).map(prompt => prompt.name))
    const sections = await Promise.all(injections.map(async (injection) => {
      if (!available.has(injection.name)) {
        throw new Error(
          `mcp-apps(${this.config.serverName}): auto-injected prompt ${JSON.stringify(injection.name)} is unavailable`,
        )
      }
      const result = await this.client.getPrompt(
        {
          name: injection.name,
          ...injection.arguments === undefined ? {} : { arguments: injection.arguments },
        },
        { timeout: this.resolved.toolCallTimeoutMs },
      )
      return {
        name: `mcp-prompt:${this.config.serverName}:${injection.name}`,
        order: 130,
        text: renderInjectedPrompt(this.config.serverName, injection.name, result),
      }
    }))
    for (const dispose of this.promptDisposers) dispose()
    this.promptDisposers = []
    const nextDisposers: Array<() => void> = []
    try {
      for (const section of sections) nextDisposers.push(this.ctx.systemPrompt.section(section))
      this.promptDisposers = nextDisposers
    } catch (error) {
      for (const dispose of nextDisposers) dispose()
      throw error
    }
  }

  private output(rawName: string, view: McpAppCatalogItem | undefined): ToolDefinition['output'] {
    return {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
          _meta: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: resultText(value as unknown as McpAppResult, rawName) }]
      },
      ...view === undefined
        ? {}
        : {
            presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
              const meta: McpAppPresentationMetaV1 = {
                kind: 'dsh/mcp-app',
                version: 1,
                viewId: view.viewId,
                publicToolName: view.publicToolName,
                resourceUri: view.resourceUri,
                result: value as unknown as McpAppResult,
              }
              if (Buffer.byteLength(JSON.stringify(meta), 'utf8') > this.resolved.maxResultMetaBytes) {
                return {
                  kind: 'dsh/mcp-app-result-too-large',
                  version: 1,
                  publicToolName: view.publicToolName,
                }
              }
              return meta as unknown as JsonValue
            },
          },
    }
  }

  private executor(rawName: string): ToolDefinition['execute'] {
    return async (args: unknown, exec: ToolExecution) => {
      const cwd = this.config.transport === 'stdio' && this.config.forwardWorkspace === true
        ? exec.agent?.session.header.cwd
        : undefined
      const result = await this.call(
        rawName,
        typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
        exec.signal,
        cwd === undefined ? undefined : { [DSH_WORKSPACE_META_KEY]: { cwd } },
      )
      const value = resultValue(result)
      if (result.isError === true) throw new Error(resultText(value, rawName))
      return value
    }
  }

  private async sync(): Promise<void> {
    const listed = await this.listTools()
    const definitions = new Map<string, ToolDefinition>()
    const nextTools = new Map<string, { tool: Tool; visibility: Visibility }>()
    const views: ViewBinding[] = []
    for (const tool of listed) {
      if (nextTools.has(tool.name)) {
        throw new Error(`server listed tool ${JSON.stringify(tool.name)} more than once`)
      }
      const visibility = visibilityOf(tool)
      nextTools.set(tool.name, { tool, visibility })
      if (!visibility.model) continue
      const publicName = publicToolName(this.config.serverName, tool.name)
      if (definitions.has(publicName)) throw new Error(`tool name collision at ${JSON.stringify(publicName)}`)
      const resourceUri = getToolUiResourceUri(tool)
      const view = resourceUri === undefined
        ? undefined
        : {
            publicToolName: publicName,
            resourceUri,
            sandboxOrigin: this.host.sandboxOrigin,
            viewId: randomUUID(),
          }
      if (view !== undefined) views.push({ item: view, rawToolName: tool.name, state: this })
      definitions.set(publicName, {
        name: publicName,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        output: this.output(tool.name, view),
        execute: this.executor(tool.name),
      })
    }

    for (const dispose of this.toolDisposers.values()) dispose()
    this.host.removeViews(this.viewIds)
    this.viewIds.clear()
    const nextDisposers = new Map<string, () => void>()
    try {
      for (const [name, definition] of definitions) {
        nextDisposers.set(name, this.ctx.tools.register(definition))
      }
      this.tools.clear()
      for (const [name, value] of nextTools) this.tools.set(name, value)
      for (const view of views) {
        this.host.addView(view)
        this.viewIds.add(view.item.viewId)
      }
      this.toolDisposers = nextDisposers
    } catch (error) {
      for (const dispose of nextDisposers.values()) dispose()
      this.toolDisposers = new Map()
      throw error
    }
  }

  async call(
    rawName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    meta?: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return this.client.request(
      {
        method: 'tools/call',
        params: {
          name: rawName,
          arguments: args,
          ...meta === undefined ? {} : { _meta: meta },
        },
      },
      CallToolResultSchema,
      { signal, timeout: this.resolved.toolCallTimeoutMs },
    )
  }

  async readResource(uri: string, signal?: AbortSignal) {
    return this.client.request(
      { method: 'resources/read', params: { uri } },
      ReadResourceResultSchema,
      { signal, timeout: this.resolved.toolCallTimeoutMs },
    )
  }

  async resourceMeta(uri: string): Promise<Record<string, unknown> | undefined> {
    let cursor: string | undefined
    do {
      const page = await this.client.listResources(cursor === undefined ? {} : { cursor })
      const resource = page.resources.find(candidate => candidate.uri === uri)
      if (resource !== undefined) return resource._meta as Record<string, unknown> | undefined
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return undefined
  }

  async dispose(): Promise<void> {
    for (const dispose of this.toolDisposers.values()) dispose()
    this.toolDisposers.clear()
    for (const dispose of this.promptDisposers) dispose()
    this.promptDisposers = []
    this.host.removeViews(this.viewIds)
    this.viewIds.clear()
    await this.client.close()
  }
}

class McpAppsHost {
  private readonly views = new Map<string, ViewBinding>()

  constructor(
    readonly sandboxOrigin: string,
    private readonly maxBodyBytes: number,
  ) {}

  addView(binding: ViewBinding): void {
    this.views.set(binding.item.viewId, binding)
  }

  removeViews(ids: Iterable<string>): void {
    for (const id of ids) this.views.delete(id)
  }

  catalog(): McpAppCatalogItem[] {
    return [...this.views.values()].map(binding => binding.item)
      .sort((left, right) => left.publicToolName.localeCompare(right.publicToolName))
  }

  private binding(viewId: unknown): ViewBinding {
    if (typeof viewId !== 'string') throw new Error('viewId must be a string')
    const binding = this.views.get(viewId)
    if (binding === undefined) throw new Error('MCP App View is unavailable')
    return binding
  }

  async readView(viewId: unknown): Promise<McpAppView> {
    const binding = this.binding(viewId)
    const resource = await binding.state.readResource(binding.item.resourceUri)
    if (resource.contents.length !== 1) throw new Error('MCP App resource must contain exactly one content item')
    const [content] = resource.contents
    if (content === undefined || content.mimeType !== RESOURCE_MIME_TYPE) {
      throw new Error(`MCP App resource must use ${RESOURCE_MIME_TYPE}`)
    }
    const html = 'text' in content
      ? content.text
      : Buffer.from(content.blob, 'base64').toString('utf8')
    if (Buffer.byteLength(html, 'utf8') > this.maxBodyBytes) throw new Error('MCP App resource is too large')
    const contentMeta = content._meta as Record<string, unknown> | undefined
    const listingMeta = contentMeta === undefined
      ? await binding.state.resourceMeta(binding.item.resourceUri)
      : undefined
    const uiMeta = (contentMeta?.ui ?? listingMeta?.ui) as Record<string, unknown> | undefined
    const csp = normalizeCsp(uiMeta?.csp)
    return { html, ...csp === undefined ? {} : { csp } }
  }

  async callTool(viewId: unknown, name: unknown, args: unknown): Promise<CallToolResult> {
    const binding = this.binding(viewId)
    if (typeof name !== 'string') throw new Error('tool name must be a string')
    const listed = binding.state.tools.get(name)
    if (listed === undefined || !listed.visibility.app) throw new Error('tool is not visible to this MCP App')
    const input = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
    return binding.state.call(name, input)
  }

  async readResource(viewId: unknown, uri: unknown) {
    const binding = this.binding(viewId)
    if (typeof uri !== 'string' || uri === '') throw new Error('resource URI must be a non-empty string')
    return binding.state.readResource(uri)
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
    throw new Error('Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  return host !== undefined && origin === `http://${host}`
}

function apiHandler(host: McpAppsHost, maxBodyBytes: number) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin request rejected' })
      return
    }
    const path = new URL(req.url ?? '/', 'http://host.invalid').pathname
    try {
      if (req.method === 'GET' && path === `${API_PREFIX}/catalog`) {
        sendJson(res, 200, { items: host.catalog() })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const body = await readJson(req, maxBodyBytes)
      if (path === `${API_PREFIX}/view`) {
        sendJson(res, 200, await host.readView(body.viewId))
        return
      }
      if (path === `${API_PREFIX}/tool`) {
        sendJson(res, 200, await host.callTool(body.viewId, body.name, body.arguments))
        return
      }
      if (path === `${API_PREFIX}/resource`) {
        sendJson(res, 200, await host.readResource(body.viewId, body.uri))
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Mount the standalone MCP Apps Host into the current Cordis composition. */
export async function applyHost(ctx: Context, config?: Config): Promise<void> {
  const resolved = resolveConfig(config)
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('mcp-apps: v1 requires the Web Host to bind 127.0.0.1')
  }
  await ctx.effect(async () => {
    const sandbox = await startSandboxServer()
    const host = new McpAppsHost(sandbox.origin, resolved.maxBodyBytes)
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: apiHandler(host, resolved.maxBodyBytes),
    })
    const states: ServerState[] = []
    try {
      for (const server of resolved.servers) {
        const state = new ServerState(ctx, server, host, resolved)
        states.push(state)
        await state.start()
      }
    } catch (error) {
      for (const state of states.reverse()) await state.dispose()
      disposeRoute()
      await sandbox.close()
      throw error
    }
    return async () => {
      disposeRoute()
      for (const state of states.reverse()) await state.dispose()
      await sandbox.close()
    }
  }, 'mcp-apps.host')
}
