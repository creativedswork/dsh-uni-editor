import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

test('injects an explicitly allowlisted MCP prompt and removes it on disposal', async () => {
  const ctx = new Context()
  const sections = new Map()
  const definitions = new Map()
  const registrations = []
  let disposals = 0
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
  ctx.provide('systemPrompt', {
    section(definition) {
      if (sections.has(definition.name)) throw new Error(`duplicate section ${definition.name}`)
      sections.set(definition.name, definition)
      registrations.push(definition.text)
      return () => {
        disposals += 1
        if (sections.get(definition.name) === definition) sections.delete(definition.name)
      }
    },
    context() {
      return () => {}
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
    const update = definitions.get(plugin.publicToolName('testing', 'set_prompt_text'))
    await update.execute({
      text: 'Run independent test reviews, score the result, and repair failures below {threshold}.',
    }, { signal: new AbortController().signal })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(registrations.length, 1)
    assert.equal(disposals, 0)

    await update.execute({
      text: 'Updated generation: score the result and repair below {threshold}.',
    }, { signal: new AbortController().signal })
    const deadline = Date.now() + 2_000
    while (!sections.get('mcp-prompt:testing:test-review-loop')?.text.includes('Updated generation')) {
      if (Date.now() >= deadline) throw new Error('prompt generation did not update')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(registrations.length, 2)
    assert.equal(disposals, 1)

    const remove = definitions.get(plugin.publicToolName('testing', 'remove_review_prompt'))
    await remove.execute({}, { signal: new AbortController().signal })
    const removalDeadline = Date.now() + 2_000
    while (sections.has('mcp-prompt:testing:test-review-loop')) {
      if (Date.now() >= removalDeadline) throw new Error('removed prompt section was not disposed')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(registrations.length, 2)
    assert.equal(disposals, 2)
  } finally {
    await ctx.fiber.dispose()
  }
  assert.equal(sections.size, 0)
  assert.equal(disposals, 2)
})

test('rejects assistant-role content from an auto-injected prompt', async () => {
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register: () => () => {},
  })
  ctx.provide('systemPrompt', {
    section: () => () => {},
    context: () => () => {},
  })

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
