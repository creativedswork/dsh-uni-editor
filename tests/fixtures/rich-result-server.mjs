import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'rich-result-test',
  version: '0.0.0',
})

server.registerTool('capture', {
  description: 'Returns a standard MCP image.',
  inputSchema: {},
  outputSchema: z.object({ evidenceId: z.string() }),
  _meta: { ui: { visibility: ['model'] } },
}, async () => ({
  content: [
    { type: 'text', text: 'captured' },
    {
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMKGQAAAABJRU5ErkJggg==',
    },
  ],
  structuredContent: { evidenceId: 'evidence-1' },
}))

await server.connect(new StdioServerTransport())
