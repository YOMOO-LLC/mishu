import type { CampaignCopilotPolicy } from '../../shared/policy.js'

export type ToolRisk = 'read' | 'draft-write' | 'external-write' | 'automatic'

export interface ToolExecutionContext {
  campaignId: string
  callSessionId: string
  actor: string
  signal?: AbortSignal
  turnDone?: Promise<void>
}

export interface InCallTool<Args = unknown, Result = unknown> {
  id: string
  version: number
  spec: {
    type: 'function'
    name: string
    description: string
    inputSchema: Record<string, unknown>
    deferLoading?: boolean
  }
  risk: ToolRisk
  timeoutMs: number
  validate(args: unknown): Args
  execute(ctx: ToolExecutionContext, args: Args): Promise<Result>
  toModelText(result: Result): string
}

export class ToolRegistry {
  private readonly tools = new Map<string, Map<number, InCallTool>>()

  register<Args, Result>(tool: InCallTool<Args, Result>): void {
    const id = tool.id.trim()
    if (!id) throw new Error('Tool id is required')
    if (!Number.isSafeInteger(tool.version) || tool.version < 1) {
      throw new Error(`Tool ${id} must have a positive integer version`)
    }
    const versions = this.tools.get(id) ?? new Map<number, InCallTool>()
    if (versions.has(tool.version)) {
      throw new Error(`Tool ${id}@${tool.version} is already registered`)
    }
    versions.set(tool.version, tool as InCallTool)
    this.tools.set(id, versions)
  }

  list(): InCallTool[] {
    return [...this.tools.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, versions]) => [...versions.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, tool]) => tool))
  }

  resolve(id: string, version?: number): InCallTool | undefined {
    const versions = this.tools.get(id)
    if (!versions) return undefined
    if (version !== undefined) return versions.get(version)
    let latest: InCallTool | undefined
    for (const tool of versions.values()) {
      if (!latest || tool.version > latest.version) latest = tool
    }
    return latest
  }

  forCampaign(policy: CampaignCopilotPolicy): InCallTool[] {
    const selected: InCallTool[] = []
    const seen = new Set<string>()
    for (const id of policy.allowedToolIds) {
      if (seen.has(id)) continue
      seen.add(id)
      if (id === 'end_call' && !policy.mayEndCall) continue
      const tool = this.resolve(id)
      if (tool) selected.push(tool)
    }
    return selected
  }
}
