import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const plugin = await import('../lib/index.js')
const clientSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const hostSource = await readFile(new URL('../src/host.ts', import.meta.url), 'utf8')

function provideSystemPrompt(ctx, contexts = new Map()) {
  ctx.provide('systemPrompt', {
    section() {
      return () => {}
    },
    context(definition) {
      contexts.set(definition.name, definition)
      return () => {
        if (contexts.get(definition.name) === definition) contexts.delete(definition.name)
      }
    },
  })
  return contexts
}

test('publishes one installable DSH bundle', async () => {
  assert.equal(manifest.name, '@creative-dswork/dsh-uni-editor')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(manifest.exports['./client'].default, './lib/client.js')

  assert.equal(plugin.MCP_APPS_SPEC_VERSION, '2026-01-26')

  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /@creative-dswork\/dsh-uni-editor/)
  assert.match(client, /onrequestdisplaymode/)
  assert.match(client, /onupdatemodelcontext/)
  assert.match(client, /updateModelContext/)
  assert.match(client, /fullscreen/)
  assert.match(client, /data-display-mode/)
  assert.match(client, /conversation\.session\.header\.actions/)
  assert.match(client, /mcp-apps-active/)
  assert.match(client, /Locate in Chat/)
  assert.match(client, /data-mcp-app-header-action/)
  assert.match(client, /data-mcp-app-definition-error/)
})

test('rebinds a restored App view after its first successful tool call', () => {
  const callTool = hostSource.slice(
    hostSource.indexOf('async callTool('),
    hostSource.indexOf('async readResource(', hostSource.indexOf('async callTool(')),
  )
  const call = callTool.indexOf('await binding.state.call(')
  const bind = callTool.indexOf('this.bindViewSession(')
  assert.ok(call >= 0)
  assert.ok(bind > call)
})

test('keeps the App registry controller stable across ownership changes', () => {
  const controller = clientSource.slice(
    clientSource.indexOf('const controller = useMemo<AppInstanceController>'),
    clientSource.indexOf('controller.surface =', clientSource.indexOf('const controller = useMemo<AppInstanceController>')),
  )
  assert.match(controller, /bridgeRef\.current/)
  assert.doesNotMatch(controller, /runtime\?\./)
  assert.doesNotMatch(controller, /\], \[[^\]]*\bruntime\b[^\]]*\]\)/)
})

test('rejects CSP injection and normalizes safe origins', () => {
  const csp = plugin.normalizeCsp({
    connectDomains: ['https://api.example.com', 'wss://socket.example.com'],
    resourceDomains: ['https://*.example.com'],
  })
  assert.deepEqual(csp, {
    connectDomains: ['https://api.example.com', 'wss://socket.example.com'],
    resourceDomains: ['https://*.example.com'],
  })
  const header = plugin.buildCspHeader(csp)
  assert.match(header, /connect-src 'self' https:\/\/api\.example\.com wss:\/\/socket\.example\.com/)
  assert.match(header, /frame-src 'self'/)
  assert.doesNotMatch(header, /frame-src[^;]*https:\/\/attacker\.example/)
  assert.match(header, /object-src 'none'/)
  assert.match(
    plugin.buildCspHeader(plugin.normalizeCsp({
      frameDomains: ['https://embed.example.com'],
    })),
    /frame-src 'self' https:\/\/embed\.example\.com/,
  )
  assert.throws(() => plugin.normalizeCsp({ connectDomains: ["https://safe.test; script-src 'none'"] }))
  assert.throws(() => plugin.normalizeCsp({ resourceDomains: ['https://example.com/path'] }))
  assert.throws(() => plugin.normalizeCsp({ resourceDomains: ['https://user@example.com'] }))
})

test('passes the calling DSH workspace to model MCP tool requests', async () => {
  const ctx = new Context()
  const definitions = new Map()
  provideSystemPrompt(ctx)
  ctx.provide('tools', {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
  })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register() {
      return () => {}
    },
  })

  try {
    await ctx.plugin(plugin, {
      servers: [
        {
          transport: 'stdio',
          serverName: 'context',
          command: process.execPath,
          args: [new URL('./fixtures/workspace-context-server.mjs', import.meta.url).pathname],
          forwardWorkspace: true,
        },
        {
          transport: 'stdio',
          serverName: 'private',
          command: process.execPath,
          args: [new URL('./fixtures/workspace-context-server.mjs', import.meta.url).pathname],
        },
      ],
    }).await()
    const definition = definitions.get(plugin.publicToolName('context', 'show_context'))
    const signal = new AbortController().signal
    const cwd = '/tmp/selected-threejs-game'
    const contextual = await definition.execute({}, {
      signal,
      agent: { session: { header: { cwd } } },
    })
    assert.equal(contextual.structuredContent.cwd, cwd)
    const agentless = await definition.execute({}, { signal })
    assert.equal(agentless.structuredContent.cwd, null)
    const privateDefinition = definitions.get(plugin.publicToolName('private', 'show_context'))
    const privateResult = await privateDefinition.execute({}, {
      signal,
      agent: { session: { header: { cwd } } },
    })
    assert.equal(privateResult.structuredContent.cwd, null)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('admits standard MCP image content into durable Harness attachments', async () => {
  const ctx = new Context()
  const definitions = new Map()
  const saved = []
  let inputModalities = ['text', 'image']
  provideSystemPrompt(ctx)
  ctx.provide('llm', {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities }
    },
  })
  ctx.provide('attachments', {
    async saveImages(inputs) {
      saved.push(...inputs)
      return inputs.map((input, index) => ({
        attachmentId: `sha256:${String(index).padStart(64, '0')}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
      }))
    },
  })
  ctx.provide('tools', {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
  })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register() {
      return () => {}
    },
  })

  try {
    await ctx.plugin(plugin, {
      servers: [{
        transport: 'stdio',
        serverName: 'rich',
        command: process.execPath,
        args: [new URL('./fixtures/rich-result-server.mjs', import.meta.url).pathname],
      }],
    }).await()
    const definition = definitions.get(plugin.publicToolName('rich', 'capture'))
    const value = await definition.execute({}, {
      signal: new AbortController().signal,
      agent: {
        options: { provider: 'test', model: 'vision' },
        session: { header: { id: 'session-rich' }, requestHeader: () => undefined },
      },
    })
    const rendered = definition.output.render({}, value)
    assert.equal(rendered[0].type, 'text')
    assert.equal(rendered[1].type, 'image')
    assert.equal(rendered[1].attachment.mediaType, 'image/png')
    assert.equal(saved.length, 1)
    assert.ok(saved[0].data.length > 0)

    inputModalities = ['text']
    const textOnly = await definition.execute({}, {
      signal: new AbortController().signal,
      agent: {
        options: { provider: 'test', model: 'text-only' },
        session: { header: { id: 'session-text' }, requestHeader: () => undefined },
      },
    })
    const textOnlyRendered = definition.output.render({}, textOnly)
    assert.equal(textOnlyRendered.some(block => block.type === 'image'), false)
    assert.match(textOnlyRendered[1].text, /does not declare image input/)
    assert.equal(textOnly.content[1].type, 'image')
    assert.equal(saved.length, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('reconnects a stopped MCP server with a new generation and stable prompt', async () => {
  const ctx = new Context()
  const definitions = new Map()
  const sections = new Map()
  const contexts = new Map()
  let promptRegistrations = 0
  let route
  let apiServer
  ctx.provide('systemPrompt', {
    section(definition) {
      promptRegistrations += 1
      sections.set(definition.name, definition)
      return () => {
        if (sections.get(definition.name) === definition) sections.delete(definition.name)
      }
    },
    context(definition) {
      contexts.set(definition.name, definition)
      return () => {
        if (contexts.get(definition.name) === definition) contexts.delete(definition.name)
      }
    },
  })
  ctx.provide('tools', {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
  })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register(candidate) {
      route = candidate
      return () => { route = undefined }
    },
  })

  try {
    await ctx.plugin(plugin, {
      servers: [{
        transport: 'stdio',
        serverName: 'reconnect',
        command: process.execPath,
        args: [new URL('./fixtures/reconnect-server.mjs', import.meta.url).pathname],
      }],
      prompts: {
        autoInject: [{ serverName: 'reconnect', name: 'reconnect-prompt' }],
      },
    }).await()
    apiServer = createServer((req, res) => {
      void route.handler(req, res)
    })
    await new Promise((resolve, reject) => {
      apiServer.once('error', reject)
      apiServer.listen(0, '127.0.0.1', resolve)
    })
    const address = apiServer.address()
    const origin = `http://127.0.0.1:${address.port}`
    const showName = plugin.publicToolName('reconnect', 'show_reconnect')
    const restartName = plugin.publicToolName('reconnect', 'restart_reconnect')
    const execution = {
      signal: new AbortController().signal,
      agent: { session: { header: { id: 'session-reconnect' } } },
    }
    const initialDefinition = definitions.get(showName)
    const initialValue = await initialDefinition.execute({}, execution)
    const initialMeta = initialDefinition.output.presentationMeta({}, initialValue)
    const initialContextResponse = await fetch(`${origin}/api/mcp-apps/model-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewId: initialMeta.viewId,
        sessionId: 'session-reconnect',
        connectionGeneration: initialMeta.connectionGeneration,
        content: [{ type: 'text', text: 'initial context' }],
      }),
    })
    assert.equal(initialContextResponse.status, 200)
    const modelContext = contexts.get('mcp-apps:view-context')
    assert.match(
      modelContext.text({ agent: { session: { header: { id: 'session-reconnect' } } } }),
      /initial context/,
    )
    await definitions.get(restartName).execute({}, execution)

    const deadline = Date.now() + 10_000
    let catalog
    do {
      await new Promise(resolve => setTimeout(resolve, 50))
      catalog = await (await fetch(`${origin}/api/mcp-apps/catalog`)).json()
      if (catalog.items[0]?.connectionGeneration !== initialMeta.connectionGeneration) break
    } while (Date.now() < deadline)
    assert.equal(catalog.items.length, 1)
    assert.notEqual(catalog.items[0].connectionGeneration, initialMeta.connectionGeneration)
    assert.equal(promptRegistrations, 1)
    assert.equal(sections.size, 1)
    assert.equal(
      modelContext.text({ agent: { session: { header: { id: 'session-reconnect' } } } }),
      '',
    )
    const replacementContextResponse = await fetch(`${origin}/api/mcp-apps/model-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewId: catalog.items[0].viewId,
        sessionId: 'session-reconnect',
        connectionGeneration: catalog.items[0].connectionGeneration,
        content: [{ type: 'text', text: 'replacement context' }],
      }),
    })
    assert.equal(replacementContextResponse.status, 200)
    assert.match(
      modelContext.text({ agent: { session: { header: { id: 'session-reconnect' } } } }),
      /replacement context/,
    )

    const reconnectedDefinition = definitions.get(showName)
    const reconnectedValue = await reconnectedDefinition.execute({}, execution)
    assert.notEqual(reconnectedValue.structuredContent.pid, initialValue.structuredContent.pid)
    const staleGenerationResponse = await fetch(`${origin}/api/mcp-apps/model-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewId: catalog.items[0].viewId,
        sessionId: 'session-reconnect',
        connectionGeneration: initialMeta.connectionGeneration,
        content: [{ type: 'text', text: 'stale generation' }],
      }),
    })
    assert.equal(staleGenerationResponse.status, 400)
    const staleResponse = await fetch(`${origin}/api/mcp-apps/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewId: initialMeta.viewId,
        name: 'show_reconnect',
        arguments: {},
        sessionId: 'session-reconnect',
        connectionGeneration: initialMeta.connectionGeneration,
      }),
    })
    assert.equal(staleResponse.status, 400)
  } finally {
    if (apiServer !== undefined) {
      await new Promise(resolve => apiServer.close(resolve))
    }
    await ctx.fiber.dispose()
  }
})

test('hosts the counter MCP App and keeps app-only tools out of the model registry', async () => {
  const ctx = new Context()
  const definitions = new Map()
  const contexts = new Map()
  let route
  provideSystemPrompt(ctx, contexts)
  ctx.provide('tools', {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
  })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register(candidate) {
      route = candidate
      return () => { route = undefined }
    },
  })

  let apiServer
  try {
    await ctx.plugin(plugin, {
      servers: [{
        transport: 'stdio',
        serverName: 'counter',
        command: process.execPath,
        args: [new URL('../demo/dist/server.js', import.meta.url).pathname],
      }],
    }).await()

    const showName = plugin.publicToolName('counter', 'show_counter')
    const incrementName = plugin.publicToolName('counter', 'increment_counter')
    assert.equal(definitions.has(showName), true)
    assert.equal(definitions.has(incrementName), false)

    const definition = definitions.get(showName)
    const value = await definition.execute({}, {
      signal: new AbortController().signal,
      agent: { session: { header: { id: 'session-counter' } } },
    })
    assert.equal(value.structuredContent.count, 0)
    assert.match(definition.output.render({}, value)[0].text, /Current counter: 0/)
    const meta = definition.output.presentationMeta({}, value)
    assert.equal(meta.kind, 'dsh/mcp-app')
    assert.equal(meta.serverName, 'counter')
    assert.equal(typeof meta.connectionGeneration, 'string')
    assert.equal(meta.sessionId, 'session-counter')
    assert.deepEqual(meta.result._meta['ai.deepseek.dsh/app-instance'], {
      sessionId: 'session-counter',
      serverName: 'counter',
    })
    assert.equal(meta.result.structuredContent.count, 0)

    apiServer = createServer((req, res) => {
      void route.handler(req, res)
    })
    await new Promise((resolve, reject) => {
      apiServer.once('error', reject)
      apiServer.listen(0, '127.0.0.1', resolve)
    })
    const address = apiServer.address()
    const origin = `http://127.0.0.1:${address.port}`

    const catalogResponse = await fetch(`${origin}/api/mcp-apps/catalog`)
    assert.equal(catalogResponse.status, 200)
    const catalog = await catalogResponse.json()
    assert.equal(catalog.items.length, 1)
    assert.equal(catalog.items[0].publicToolName, showName)

    const modelContext = contexts.get('mcp-apps:view-context')
    const updateContext = text => fetch(`${origin}/api/mcp-apps/model-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewId: catalog.items[0].viewId,
        sessionId: 'session-counter',
        connectionGeneration: catalog.items[0].connectionGeneration,
        content: [{ type: 'text', text }],
        structuredContent: { revision: text },
      }),
    })
    assert.equal((await updateContext('revision-1')).status, 200)
    assert.equal((await updateContext('revision-2')).status, 200)
    const ownContext = modelContext.text({
      agent: { session: { header: { id: 'session-counter' } } },
    })
    assert.doesNotMatch(ownContext, /revision-1/)
    assert.match(ownContext, /revision-2/)
    assert.equal(
      modelContext.text({ agent: { session: { header: { id: 'other-session' } } } }),
      '',
    )
    const foreignContext = await fetch(`${origin}/api/mcp-apps/model-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewId: catalog.items[0].viewId,
        sessionId: 'other-session',
        connectionGeneration: catalog.items[0].connectionGeneration,
        content: [{ type: 'text', text: 'foreign context' }],
      }),
    })
    assert.equal(foreignContext.status, 400)

    const viewResponse = await fetch(`${origin}/api/mcp-apps/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewId: catalog.items[0].viewId }),
    })
    const view = await viewResponse.json()
    assert.equal(viewResponse.status, 200, JSON.stringify(view))
    assert.match(view.html, /DSH Counter/)

    const incrementResponse = await fetch(`${origin}/api/mcp-apps/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewId: catalog.items[0].viewId,
        name: 'increment_counter',
        arguments: {},
        sessionId: 'test-session',
        connectionGeneration: catalog.items[0].connectionGeneration,
      }),
    })
    assert.equal(incrementResponse.status, 200)
    assert.equal((await incrementResponse.json()).structuredContent.count, 1)

    const rejected = await fetch(`${origin}/api/mcp-apps/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({
        viewId: catalog.items[0].viewId,
        name: 'increment_counter',
        arguments: {},
      }),
    })
    assert.equal(rejected.status, 403)

    const sandbox = await fetch(`${catalog.items[0].sandboxOrigin}/sandbox.html?csp=${encodeURIComponent(JSON.stringify(view.csp))}`)
    assert.equal(sandbox.status, 200)
    assert.match(sandbox.headers.get('content-security-policy'), /object-src 'none'/)
  } finally {
    if (apiServer !== undefined) {
      await new Promise(resolve => apiServer.close(resolve))
    }
    await ctx.fiber.dispose()
  }
})
