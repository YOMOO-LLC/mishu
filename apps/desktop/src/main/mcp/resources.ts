import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolService } from './tools.js'

export function registerResources(server: McpServer, service: McpToolService): void {
  server.registerResource(
    'phone-status',
    'live-phone://status',
    { description: 'Current local phone status', mimeType: 'application/json' },
    async (uri) => jsonResource(uri, service.phoneStatus())
  )
  server.registerResource(
    'campaigns',
    'live-phone://campaigns',
    { description: 'Local campaigns with phone numbers masked', mimeType: 'application/json' },
    async (uri) => jsonResource(uri, { campaigns: service.campaigns() })
  )
  server.registerResource(
    'appointments',
    'live-phone://appointments',
    { description: 'Persisted appointments with phone numbers masked', mimeType: 'application/json' },
    async (uri) => jsonResource(uri, { appointments: service.appointments() })
  )
  server.registerResource(
    'call',
    new ResourceTemplate('live-phone://calls/{id}', { list: undefined }),
    { description: 'One persisted call with its number masked', mimeType: 'application/json' },
    async (uri, variables) => jsonResource(uri, service.call(String(variables.id)))
  )
  server.registerResource(
    'call-transcript',
    new ResourceTemplate('live-phone://calls/{id}/transcript', { list: undefined }),
    { description: 'Persisted transcript for one call', mimeType: 'application/json' },
    async (uri, variables) => jsonResource(uri, { transcript: service.transcript(String(variables.id)) })
  )
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(value) }]
  }
}
