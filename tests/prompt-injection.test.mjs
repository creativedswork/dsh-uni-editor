import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

test('injects an explicitly allowlisted MCP prompt and removes it on disposal', async () => {
  const ctx = new Context()
  const sections = new Map()
  ctx.provide('tools', {
    register() {
      return () => {}
    },
  })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register() {
      return () => {}
    },
  })
  ctx.provide('systemPrompt', {
    section(definition) {
      if (sections.has(definition.name)) throw new Error(`duplicate section ${definition.name}`)
      sections.set(definition.name, definition)
      return () => { sections.delete(definition.name) }
    },
  })

  try {
    await ctx.plugin(plugin, {
      servers: [{
        transport: 'stdio',
        serverName: 'testing',
        command: process.execPath,
        args: [new URL('./fixtures/prompt-server.mjs', import.meta.url).pathname],
      }],
      prompts: {
        autoInject: [{
          serverName: 'testing',
          name: 'test-review-loop',
          arguments: { threshold: '85' },
        }],
      },
    }).await()
    const section = sections.get('mcp-prompt:testing:test-review-loop')
    assert.equal(section.order, 130)
    assert.match(section.text, /repair failures below 85/)
  } finally {
    await ctx.fiber.dispose()
  }
  assert.equal(sections.size, 0)
})

test('rejects assistant-role content from an auto-injected prompt', async () => {
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register: () => () => {},
  })
  ctx.provide('systemPrompt', { section: () => () => {} })

  try {
    await assert.rejects(ctx.plugin(plugin, {
      servers: [{
        transport: 'stdio',
        serverName: 'testing',
        command: process.execPath,
        args: [new URL('./fixtures/prompt-server.mjs', import.meta.url).pathname],
      }],
      prompts: {
        autoInject: [{
          serverName: 'testing',
          name: 'assistant-history',
        }],
      },
    }).await(), /user role/)
  } finally {
    await ctx.fiber.dispose()
  }
})
