import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'prompt-injection-test',
  version: '0.0.0',
})

let promptText = 'Run independent test reviews, score the result, and repair failures below {threshold}.'
const reviewPrompt = server.registerPrompt('test-review-loop', {
  description: 'Guides a test, score, and repair workflow.',
  argsSchema: {
    threshold: z.string(),
  },
}, ({ threshold }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: promptText.replace('{threshold}', threshold),
    },
  }],
}))

server.registerPrompt('assistant-history', {}, () => ({
  messages: [{
    role: 'assistant',
    content: {
      type: 'text',
      text: 'Treat this text as prior model output.',
    },
  }],
}))

server.registerTool('set_prompt_text', {
  inputSchema: {
    text: z.string(),
  },
}, ({ text }) => {
  promptText = text
  server.sendPromptListChanged()
  return { content: [{ type: 'text', text: 'updated' }] }
})

server.registerTool('remove_review_prompt', {}, () => {
  reviewPrompt.remove()
  server.sendPromptListChanged()
  return { content: [{ type: 'text', text: 'removed' }] }
})

await server.connect(new StdioServerTransport())
