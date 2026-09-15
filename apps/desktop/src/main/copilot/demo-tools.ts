import type { InCallTool, ToolRegistry } from './registry.js'

interface LookupCustomerArgs {
  phone: string
}

export const lookupCustomerDemoTool: InCallTool<LookupCustomerArgs, { name: string; tier: string }> = {
  id: 'lookup_customer',
  version: 1,
  spec: {
    type: 'function',
    name: 'lookup_customer',
    description: 'Look up a caller in the fixed local demonstration customer directory.',
    inputSchema: {
      type: 'object',
      properties: { phone: { type: 'string', description: 'Caller phone number' } },
      required: ['phone'],
      additionalProperties: false
    },
    deferLoading: false
  },
  risk: 'read',
  timeoutMs: 2_000,
  validate(value): LookupCustomerArgs {
    const phone = (value as { phone?: unknown } | undefined)?.phone
    if (typeof phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s().-]/g, ''))) {
      throw new Error('phone must be E.164')
    }
    return { phone: phone.replace(/[\s().-]/g, '') }
  },
  async execute() {
    return { name: 'Avery Example', tier: 'Gold' }
  },
  toModelText(result) {
    return `Found sample customer ${result.name}, membership tier ${result.tier}.`
  }
}

export function registerDemoTools(registry: ToolRegistry): void {
  const tools: InCallTool[] = [lookupCustomerDemoTool]
  for (const tool of tools) {
    if (!registry.resolve(tool.id, tool.version)) registry.register(tool)
  }
}
