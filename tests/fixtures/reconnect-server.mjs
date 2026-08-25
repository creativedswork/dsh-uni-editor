import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const RESOURCE_URI = 'ui://reconnect/app'
const server = new McpServer({
  name: 'reconnect-test',
  version: '0.0.0',
})

server.registerPrompt('reconnect-prompt', {}, () => ({
  messages: [{
    role: 'user',
    content: { type: 'text', text: 'Reconnect prompt.' },
  }],
}))

registerAppTool(server, 'show_reconnect', {
  inputSchema: {},
  outputSchema: z.object({ pid: z.number() }),
  _meta: { ui: { resourceUri: RESOURCE_URI } },
}, () => ({
  content: [{ type: 'text', text: `pid ${String(process.pid)}` }],
  structuredContent: { pid: process.pid },
}))

server.registerTool('restart_reconnect', {
  inputSchema: {},
}, () => {
  setTimeout(() => process.exit(0), 25)
  return { content: [{ type: 'text', text: 'restarting' }] }
})

registerAppResource(server, 'reconnect-view', RESOURCE_URI, {
  mimeType: RESOURCE_MIME_TYPE,
}, () => ({
  contents: [{
    uri: RESOURCE_URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: '<!doctype html><title>Reconnect test</title>',
  }],
}))

await server.connect(new StdioServerTransport())
