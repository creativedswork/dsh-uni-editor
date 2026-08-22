import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const plugin = await import('../lib/index.js')

function provideSystemPrompt(ctx) {
  ctx.provide('systemPrompt', {
    section() {
      return () => {}
    },
  })
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
  assert.match(client, /fullscreen/)
  assert.match(client, /data-display-mode/)
  assert.match(client, /conversation\.session\.header\.actions/)
  assert.match(client, /mcp-apps-active/)
  assert.match(client, /Locate in Chat/)
  assert.match(client, /data-mcp-app-header-action/)
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

test('hosts the counter MCP App and keeps app-only tools out of the model registry', async () => {
  const ctx = new Context()
  const definitions = new Map()
  let route
  provideSystemPrompt(ctx)
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
    const value = await definition.execute({}, { signal: new AbortController().signal })
    assert.equal(value.structuredContent.count, 0)
    assert.match(definition.output.render({}, value)[0].text, /Current counter: 0/)
    const meta = definition.output.presentationMeta({}, value)
    assert.equal(meta.kind, 'dsh/mcp-app')
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
