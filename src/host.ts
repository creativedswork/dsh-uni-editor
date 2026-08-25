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
const DSH_SESSION_META_KEY = 'ai.deepseek.dsh/session'
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

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

interface ViewModelContext {
  viewId: string
  sessionId: string
  connectionGeneration: string
  text: string
}

interface ModelContextUpdate {
  content?: unknown
  structuredContent?: unknown
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

interface AttachmentWriter {
  saveImages(inputs: Array<{
    data: Uint8Array
    mediaType: string
    name?: string
  }>): Promise<Array<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>>
}

interface ModelResolver {
  resolveModelInfo(
    provider: string,
    model: string,
    signal: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }>
}

function attachmentWriter(ctx: Context): AttachmentWriter | undefined {
  const service = (ctx as unknown as { get(name: string): unknown }).get('attachments')
  return service !== null
    && typeof service === 'object'
    && 'saveImages' in service
    && typeof service.saveImages === 'function'
    ? service as AttachmentWriter
    : undefined
}

function modelResolver(ctx: Context): ModelResolver | undefined {
  const service = (ctx as unknown as { get(name: string): unknown }).get('llm')
  return service !== null
    && typeof service === 'object'
    && 'resolveModelInfo' in service
    && typeof service.resolveModelInfo === 'function'
    ? service as ModelResolver
    : undefined
}

function imageUnavailable(mediaType: string, reason: string): JsonValue {
  return {
    type: 'text',
    text: `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`,
  }
}

async function modelContent(
  ctx: Context,
  result: CallToolResult,
  rawName: string,
  exec: ToolExecution,
): Promise<JsonValue[]> {
  const content: JsonValue[] = []
  const images: Array<{ index: number; data: Uint8Array; mediaType: string }> = []
  let invalidImage = false
  for (const block of result.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      if (!IMAGE_MEDIA_TYPES.has(block.mimeType)
        || !CANONICAL_BASE64.test(block.data)) {
        invalidImage = true
        content.push(imageUnavailable(block.mimeType, 'invalid image content'))
        continue
      }
      const data = Buffer.from(block.data, 'base64')
      if (data.toString('base64') !== block.data) {
        invalidImage = true
        content.push(imageUnavailable(block.mimeType, 'invalid image content'))
        continue
      }
      images.push({ index: content.length, data, mediaType: block.mimeType })
      content.push(null)
    } else if (block.type === 'resource' && 'text' in block.resource) {
      content.push({
        type: 'text',
        text: `[${block.resource.uri}]\n${block.resource.text}`,
      })
    } else {
      content.push({
        type: 'text',
        text: `MCP content retained in the tool result: ${JSON.stringify(block)}`,
      })
    }
  }
  if (images.length > 0) {
    const writer = attachmentWriter(ctx)
    const routed = exec.agent?.session.requestHeader()?.config
    const provider = routed?.provider ?? exec.agent?.options.provider
    const model = routed?.model ?? exec.agent?.options.model
    const llm = modelResolver(ctx)
    let reason: string | undefined
    if (invalidImage) {
      reason = 'another image in the same result was invalid'
    } else if (writer === undefined) {
      reason = 'no attachment store is mounted'
    } else if (provider === undefined || model === undefined || llm === undefined) {
      reason = 'the current model route could not be resolved'
    } else {
      try {
        const info = await llm.resolveModelInfo(provider, model, exec.signal)
        if (info.inputModalities?.includes('image') !== true) {
          reason = `model "${model}" does not declare image input`
        }
      } catch {
        reason = 'the current model route could not be verified'
      }
    }
    exec.signal.throwIfAborted()
    if (reason === undefined && writer !== undefined) {
      try {
        const refs = await writer.saveImages(images.map(image => ({
          data: image.data,
          mediaType: image.mediaType,
        })))
        for (const [offset, image] of images.entries()) {
          content[image.index] = {
            type: 'image',
            attachment: refs[offset] as unknown as JsonValue,
          }
        }
      } catch {
        reason = 'durable image storage rejected the result'
      }
    }
    if (reason !== undefined) {
      for (const image of images) {
        content[image.index] = imageUnavailable(image.mediaType, reason)
      }
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: `Tool "${rawName}" completed without content output.` })
  }
  return content
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
  client: Client
  readonly tools = new Map<string, { tool: Tool; visibility: Visibility }>()
  private _connectionGeneration = randomUUID()
  private toolDisposers = new Map<string, () => void>()
  private promptSections = new Map<string, { hash: string; dispose: () => void }>()
  private viewIds = new Set<string>()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnecting = false
  private disposed = false
  private reconnectDelayMs = 250

  constructor(
    private readonly ctx: Context,
    readonly config: ServerConfig,
    private readonly host: McpAppsHost,
    private readonly resolved: ResolvedConfig,
  ) {
    this.client = this.createClient()
  }

  get connectionGeneration(): string {
    return this._connectionGeneration
  }

  private createClient(): Client {
    const client = new Client(
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
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.sync()
      } catch (error) {
        this.ctx.logger.error(`mcp-apps(${this.config.serverName}): tool re-sync failed: ${String(error)}`)
      }
    })
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      try {
        await this.syncPrompts()
      } catch (error) {
        this.ctx.logger.error(`mcp-apps(${this.config.serverName}): prompt re-sync failed: ${String(error)}`)
      }
    })
    client.onerror = error => {
      this.ctx.logger.error(`mcp-apps(${this.config.serverName}): MCP transport error: ${String(error)}`)
    }
    client.onclose = () => {
      if (client === this.client && !this.disposed) this.scheduleReconnect()
    }
    return client
  }

  private async connect(client: Client): Promise<void> {
    await client.connect(createTransport(this.config))
    if (client !== this.client || this.disposed) {
      await client.close()
      return
    }
    this._connectionGeneration = randomUUID()
    await Promise.all([this.sync(), this.syncPrompts()])
    this.reconnectDelayMs = 250
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnecting || this.reconnectTimer !== undefined) return
    const delay = this.reconnectDelayMs
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    if (this.disposed || this.reconnecting) return
    this.reconnecting = true
    const client = this.createClient()
    this.client = client
    let connected = false
    try {
      await this.connect(client)
      connected = true
    } catch (error) {
      this.ctx.logger.error(`mcp-apps(${this.config.serverName}): reconnect failed: ${String(error)}`)
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5_000)
      await client.close().catch(() => {})
    } finally {
      this.reconnecting = false
      if (!connected) this.scheduleReconnect()
    }
  }

  async start(): Promise<void> {
    await this.connect(this.client)
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
    const remaining = injections.filter(injection => available.has(injection.name))
    const active = new Set(remaining.map(injection => (
      `${this.config.serverName}\0${injection.name}`
    )))
    for (const [key, current] of this.promptSections) {
      if (active.has(key)) continue
      current.dispose()
      this.promptSections.delete(key)
    }
    const sections = await Promise.all(remaining.map(async (injection) => {
      const result = await this.client.getPrompt(
        {
          name: injection.name,
          ...injection.arguments === undefined ? {} : { arguments: injection.arguments },
        },
        { timeout: this.resolved.toolCallTimeoutMs },
      )
      const text = renderInjectedPrompt(this.config.serverName, injection.name, result)
      return {
        key: `${this.config.serverName}\0${injection.name}`,
        name: `mcp-prompt:${this.config.serverName}:${injection.name}`,
        order: 130,
        text,
        hash: createHash('sha256').update(text).digest('hex'),
      }
    }))
    for (const section of sections) {
      const current = this.promptSections.get(section.key)
      if (current?.hash === section.hash) continue
      current?.dispose()
      this.promptSections.delete(section.key)
      const dispose = this.ctx.systemPrompt.section({
        name: section.name,
        order: section.order,
        text: section.text,
      })
      this.promptSections.set(section.key, { hash: section.hash, dispose })
    }
    const unavailable = injections.find(injection => !available.has(injection.name))
    if (unavailable !== undefined) {
      throw new Error(
        `mcp-apps(${this.config.serverName}): auto-injected prompt ${JSON.stringify(unavailable.name)} is unavailable`,
      )
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
          modelContent: { type: 'array', items: {} },
          uiSessionId: { type: 'string' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        const result = value as unknown as McpAppResult
        return (result.modelContent ?? [{
          type: 'text',
          text: resultText(result, rawName),
        }]) as ReturnType<ToolDefinition['output']['render']>
      },
      ...view === undefined
        ? {}
        : {
            presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
              const result = value as unknown as McpAppResult & { uiSessionId?: string }
              const resultMeta = result._meta !== null
                && typeof result._meta === 'object'
                && !Array.isArray(result._meta)
                ? result._meta
                : {}
              const meta: McpAppPresentationMetaV1 = {
                kind: 'dsh/mcp-app',
                version: 1,
                serverName: this.config.serverName,
                connectionGeneration: view.connectionGeneration,
                ...typeof result.uiSessionId === 'string'
                  ? { sessionId: result.uiSessionId }
                  : {},
                viewId: view.viewId,
                publicToolName: view.publicToolName,
                resourceUri: view.resourceUri,
                ...typeof result.structuredContent === 'object'
                  && result.structuredContent !== null
                  && !Array.isArray(result.structuredContent)
                  && typeof (result.structuredContent as Record<string, unknown>).projectId === 'string'
                  ? {
                      projectId: (result.structuredContent as Record<string, string>).projectId,
                      ...typeof (result.structuredContent as Record<string, unknown>).revision === 'string'
                        ? { revision: (result.structuredContent as Record<string, string>).revision }
                        : {},
                    }
                  : {},
                result: {
                  content: result.content,
                  ...result.structuredContent === undefined
                    ? {}
                    : { structuredContent: result.structuredContent },
                  ...result.uiSessionId === undefined && result._meta === undefined
                    ? {}
                    : {
                        _meta: {
                          ...resultMeta,
                          ...result.uiSessionId === undefined
                            ? {}
                            : {
                                'ai.deepseek.dsh/app-instance': {
                                  sessionId: result.uiSessionId,
                                  serverName: this.config.serverName,
                                },
                              },
                        },
                      },
                },
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

  private executor(
    rawName: string,
    view: McpAppCatalogItem | undefined,
  ): ToolDefinition['execute'] {
    return async (args: unknown, exec: ToolExecution) => {
      const cwd = this.config.transport === 'stdio' && this.config.forwardWorkspace === true
        ? exec.agent?.session.header.cwd
        : undefined
      const input = typeof args === 'object' && args !== null
        ? args as Record<string, unknown>
        : {}
      const result = await this.call(
        rawName,
        input,
        exec.signal,
        {
          ...cwd === undefined ? {} : { [DSH_WORKSPACE_META_KEY]: { cwd } },
          [DSH_SESSION_META_KEY]: {
            sessionId: exec.agent?.session.header.id,
            connectionGeneration: this.connectionGeneration,
          },
        },
      )
      const value = {
        ...resultValue(result),
        modelContent: await modelContent(this.ctx, result, rawName, exec),
        ...exec.agent?.session.header.id === undefined
          ? {}
          : { uiSessionId: exec.agent.session.header.id },
      }
      if (result.isError === true) throw new Error(resultText(value, rawName))
      const sessionId = exec.agent?.session.header.id
      if (view !== undefined && sessionId !== undefined) {
        this.host.bindViewSession(view.viewId, sessionId, view.connectionGeneration)
      }
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
            serverName: this.config.serverName,
            connectionGeneration: this.connectionGeneration,
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
        execute: this.executor(tool.name, view),
      })
    }

    for (const dispose of this.toolDisposers.values()) dispose()
    // Preserve proven Session ownership for the same tool, but never its stale context.
    const previousViewSessions = this.host.removeViews(this.viewIds)
    this.viewIds.clear()
    const nextDisposers = new Map<string, () => void>()
    try {
      for (const [name, definition] of definitions) {
        nextDisposers.set(name, this.ctx.tools.register(definition))
      }
      this.tools.clear()
      for (const [name, value] of nextTools) this.tools.set(name, value)
      for (const view of views) {
        this.host.addView(view, previousViewSessions.get(view.rawToolName))
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
    this.disposed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    for (const dispose of this.toolDisposers.values()) dispose()
    this.toolDisposers.clear()
    for (const section of this.promptSections.values()) section.dispose()
    this.promptSections.clear()
    this.host.removeViews(this.viewIds)
    this.viewIds.clear()
    await this.client.close()
  }
}

class McpAppsHost {
  private readonly views = new Map<string, ViewBinding>()
  private readonly viewSessions = new Map<string, Set<string>>()
  private readonly modelContexts = new Map<string, ViewModelContext>()

  constructor(
    readonly sandboxOrigin: string,
    private readonly maxBodyBytes: number,
  ) {}

  addView(binding: ViewBinding, sessions?: ReadonlySet<string>): void {
    this.views.set(binding.item.viewId, binding)
    if (sessions !== undefined && sessions.size > 0) {
      this.viewSessions.set(binding.item.viewId, new Set(sessions))
    }
  }

  removeViews(ids: Iterable<string>): Map<string, Set<string>> {
    const sessionsByTool = new Map<string, Set<string>>()
    for (const id of ids) {
      const binding = this.views.get(id)
      const sessions = this.viewSessions.get(id)
      if (binding !== undefined && sessions !== undefined) {
        sessionsByTool.set(binding.rawToolName, new Set(sessions))
      }
      this.views.delete(id)
      this.viewSessions.delete(id)
      for (const [key, context] of this.modelContexts) {
        if (context.viewId === id) this.modelContexts.delete(key)
      }
    }
    return sessionsByTool
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

  bindViewSession(
    viewId: string,
    sessionId: string,
    connectionGeneration: string,
  ): void {
    const binding = this.binding(viewId)
    if (binding.item.connectionGeneration !== connectionGeneration) return
    const sessions = this.viewSessions.get(viewId) ?? new Set<string>()
    sessions.add(sessionId)
    this.viewSessions.set(viewId, sessions)
  }

  updateModelContext(
    viewId: unknown,
    sessionId: unknown,
    connectionGeneration: unknown,
    params: ModelContextUpdate,
  ): void {
    const binding = this.binding(viewId)
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 256) {
      throw new Error('Harness Session identity is required')
    }
    if (connectionGeneration !== binding.item.connectionGeneration) {
      throw new Error('MCP Server connection generation changed')
    }
    if (this.viewSessions.get(binding.item.viewId)?.has(sessionId) !== true) {
      throw new Error('MCP App View does not belong to this Harness Session')
    }
    const content = params.content ?? []
    if (!Array.isArray(content)
      || content.some(block => block === null
        || typeof block !== 'object'
        || Array.isArray(block)
        || (block as Record<string, unknown>).type !== 'text'
        || typeof (block as Record<string, unknown>).text !== 'string')) {
      throw new Error('MCP App model context only supports text content')
    }
    const structured = params.structuredContent
    if (structured !== undefined
      && (structured === null || typeof structured !== 'object' || Array.isArray(structured))) {
      throw new Error('MCP App structured model context must be an object')
    }
    const parts = content.map(block => (block as { text: string }).text)
    if (structured !== undefined) {
      parts.push(`Structured context:\n${JSON.stringify(structured)}`)
    }
    const key = `${binding.item.viewId}\0${sessionId}\0${binding.item.connectionGeneration}`
    const text = parts.filter(part => part !== '').join('\n\n')
    if (text === '') {
      this.modelContexts.delete(key)
    } else {
      this.modelContexts.set(key, {
        viewId: binding.item.viewId,
        sessionId,
        connectionGeneration: binding.item.connectionGeneration,
        text: `MCP App context from "${binding.item.publicToolName}":\n${text}`,
      })
    }
  }

  modelContext(sessionId: string | undefined): string {
    if (sessionId === undefined) return ''
    const text = [...this.modelContexts.values()]
      .filter(context => context.sessionId === sessionId
        && this.views.get(context.viewId)?.item.connectionGeneration === context.connectionGeneration)
      .sort((left, right) => left.viewId.localeCompare(right.viewId))
      .map(context => context.text)
      .join('\n\n')
    return text
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

  async callTool(
    viewId: unknown,
    name: unknown,
    args: unknown,
    sessionId: unknown,
    connectionGeneration: unknown,
  ): Promise<CallToolResult> {
    const binding = this.binding(viewId)
    if (typeof name !== 'string') throw new Error('tool name must be a string')
    const hasOwner = sessionId !== undefined || connectionGeneration !== undefined
    if (hasOwner && (typeof sessionId !== 'string' || sessionId === '')) {
      throw new Error('Harness Session identity is required')
    }
    if (hasOwner && connectionGeneration !== binding.item.connectionGeneration) {
      throw new Error('MCP Server connection generation changed')
    }
    const listed = binding.state.tools.get(name)
    if (listed === undefined || !listed.visibility.app) throw new Error('tool is not visible to this MCP App')
    const input = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
    return binding.state.call(
      name,
      input,
      undefined,
      hasOwner
        ? { [DSH_SESSION_META_KEY]: { sessionId, connectionGeneration } }
        : undefined,
    )
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
        sendJson(res, 200, await host.callTool(
          body.viewId,
          body.name,
          body.arguments,
          body.sessionId,
          body.connectionGeneration,
        ))
        return
      }
      if (path === `${API_PREFIX}/model-context`) {
        host.updateModelContext(
          body.viewId,
          body.sessionId,
          body.connectionGeneration,
          {
            ...body.content === undefined ? {} : { content: body.content },
            ...body.structuredContent === undefined
              ? {}
              : { structuredContent: body.structuredContent },
          },
        )
        sendJson(res, 200, {})
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
    const disposeModelContext = ctx.systemPrompt.context({
      name: 'mcp-apps:view-context',
      order: 140,
      text: context => host.modelContext(context.agent?.session.header.id),
    })
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
      disposeModelContext()
      await sandbox.close()
      throw error
    }
    return async () => {
      disposeRoute()
      for (const state of states.reverse()) await state.dispose()
      disposeModelContext()
      await sandbox.close()
    }
  }, 'mcp-apps.host')
}
