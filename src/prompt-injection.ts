import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js'

const MAX_PROMPT_CHARS = 64 * 1024

function textOf(content: GetPromptResult['messages'][number]['content']): string {
  if (content.type === 'text') return content.text
  if (content.type === 'resource' && 'text' in content.resource) {
    return `[${content.resource.uri}]\n${content.resource.text}`
  }
  throw new Error('auto-injected MCP prompt content must be text or an embedded text resource')
}

/** Render one explicitly allowlisted MCP prompt as a provenance-labelled system section. */
export function renderInjectedPrompt(
  serverName: string,
  promptName: string,
  result: GetPromptResult,
): string {
  if (result.messages.length === 0) throw new Error('auto-injected MCP prompt returned no messages')
  const parts = result.messages.map(message => {
    if (message.role !== 'user') {
      throw new Error('auto-injected MCP prompt messages must use the user role')
    }
    return textOf(message.content)
  })
  const text = [
    `Trusted MCP prompt ${JSON.stringify(promptName)} from server ${JSON.stringify(serverName)}.`,
    'The deployment explicitly allowlisted this workflow guidance.',
    '',
    parts.join('\n\n'),
  ].join('\n')
  if (text.length > MAX_PROMPT_CHARS) throw new Error('auto-injected MCP prompt is too large')
  return text
}
