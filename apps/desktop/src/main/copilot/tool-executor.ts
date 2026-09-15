import { createHash, randomUUID } from 'node:crypto'

import type { ApprovalDecision, ApprovalRequest } from '../../shared/contracts.js'
import type { CampaignCopilotPolicy } from '../../shared/policy.js'
import type { InCallTool, ToolRegistry, ToolRisk } from './registry.js'
import { buildCopilotInjection, truncateModelText } from './inject.js'

export interface CopilotAuditWriter {
  write(
    actor: 'copilot',
    action: string,
    callId: string,
    details: Record<string, unknown>
  ): void
}

export interface ToolExecutionRequest {
  campaignId: string
  callSessionId: string
  toolId: string
  arguments: unknown
  policy: CampaignCopilotPolicy
  signal?: AbortSignal
  turnDone?: Promise<void>
}

export interface ToolExecutionOutcome {
  success: boolean
  code: 'ok' | 'not_allowed' | 'invalid_arguments' | 'approval_denied' | 'aborted' | 'timeout' | 'failed'
  modelText: string
  injectionText?: string
  idempotencyKey?: string
}

export interface ToolExecutorOptions {
  registry: ToolRegistry
  audit: CopilotAuditWriter
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
  now?: () => number
}

export class ToolExecutor {
  private readonly now: () => number
  private readonly cache = new Map<string, { expiresAt: number; outcome: Promise<ToolExecutionOutcome> }>()

  constructor(private readonly options: ToolExecutorOptions) {
    this.now = options.now ?? Date.now
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const startedAt = this.now()
    const tool = this.options.registry.forCampaign(request.policy)
      .find(({ id }) => id === request.toolId)
    if (!tool) {
      return this.finish(request, startedAt, 'not_allowed', false, 'Tool is not allowed.')
    }

    let validated: unknown
    try {
      validated = tool.validate(request.arguments)
    } catch {
      return this.finish(request, startedAt, 'invalid_arguments', false, 'Tool arguments were invalid.')
    }

    const idempotencyKey = buildToolIdempotencyKey(
      request.callSessionId,
      request.toolId,
      validated
    )
    this.pruneCache(startedAt)
    const cached = this.cache.get(idempotencyKey)
    if (cached && cached.expiresAt > startedAt) return cached.outcome

    const outcome = this.executeValidated(request, tool, validated, startedAt, idempotencyKey)
    this.cache.set(idempotencyKey, { expiresAt: startedAt + 60_000, outcome })
    void outcome.then((result) => {
      const entry = this.cache.get(idempotencyKey)
      if (!entry || entry.outcome !== outcome) return
      if (result.success) entry.expiresAt = this.now() + 60_000
      else this.cache.delete(idempotencyKey)
    })
    return outcome
  }

  recordDiscarded(
    request: Pick<ToolExecutionRequest, 'callSessionId' | 'toolId'>,
    details: { generation: number; idempotencyKey?: string }
  ): void {
    this.options.audit.write(
      'copilot',
      COPILOT_INJECTION_DISCARDED,
      request.callSessionId,
      { toolId: request.toolId, ...details }
    )
  }

  private async executeValidated(
    request: ToolExecutionRequest,
    tool: InCallTool,
    validated: unknown,
    startedAt: number,
    idempotencyKey: string
  ): Promise<ToolExecutionOutcome> {
    if (request.signal?.aborted) {
      return this.finish(
        request,
        startedAt,
        'aborted',
        false,
        'Tool execution was cancelled before it started.',
        undefined,
        idempotencyKey
      )
    }

    if (
      tool.risk !== 'automatic' &&
      !request.policy.autoExecuteRisks.includes(tool.risk as 'read' | 'draft-write')
    ) {
      let approved = false
      try {
        approved = (await this.requestApproval(request, tool.risk)).approved
      } catch {
        approved = false
      }
      if (!approved) {
        return this.finish(
          request,
          startedAt,
          'approval_denied',
          false,
          'This action requires local approval and was not approved.',
          undefined,
          idempotencyKey
        )
      }
    }

    if (request.signal?.aborted) {
      return this.finish(
        request,
        startedAt,
        'aborted',
        false,
        'Tool execution was cancelled before it started.',
        undefined,
        idempotencyKey
      )
    }

    try {
      const result = await withDeadline(
        tool.execute(
          {
            campaignId: request.campaignId,
            callSessionId: request.callSessionId,
            actor: 'copilot',
            signal: request.signal,
            turnDone: request.turnDone
          },
          validated
        ),
        tool.timeoutMs
      )
      const modelText = truncateModelText(tool.toModelText(result))
      return this.finish(
        request,
        startedAt,
        'ok',
        true,
        modelText,
        buildCopilotInjection(tool.id, modelText),
        idempotencyKey
      )
    } catch (error) {
      const timedOut = error instanceof ToolTimeoutError
      return this.finish(
        request,
        startedAt,
        timedOut ? 'timeout' : 'failed',
        false,
        timedOut ? 'Tool execution timed out.' : 'Tool execution failed.',
        undefined,
        idempotencyKey
      )
    }
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key)
    }
  }

  private async requestApproval(request: ToolExecutionRequest, risk: ToolRisk): Promise<ApprovalDecision> {
    const now = this.now()
    return this.options.requestApproval({
      id: randomUUID(),
      kind: 'tool_execute',
      title: `Approve copilot tool: ${request.toolId}`,
      summary: `This tool's risk level is ${risk}; confirm locally before running it.`,
      details: {
        toolId: request.toolId,
        risk,
        arguments: redactArguments(request.arguments)
      },
      requestedBy: 'copilot',
      expiresAt: now + 60_000
    })
  }

  private finish(
    request: ToolExecutionRequest,
    startedAt: number,
    code: ToolExecutionOutcome['code'],
    success: boolean,
    modelText: string,
    injectionText?: string,
    idempotencyKey?: string
  ): ToolExecutionOutcome {
    this.options.audit.write('copilot', 'copilot.tool.executed', request.callSessionId, {
      toolId: request.toolId,
      arguments: redactArguments(request.arguments),
      durationMs: Math.max(0, this.now() - startedAt),
      code,
      success,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    return {
      success,
      code,
      modelText: truncateModelText(modelText),
      ...(injectionText ? { injectionText } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {})
    }
  }
}

export const COPILOT_INJECTION_DISCARDED = 'copilot.injection.discarded'

export function buildToolIdempotencyKey(
  callSessionId: string,
  toolId: string,
  normalizedArguments: unknown
): string {
  const digest = createHash('sha256')
    .update(stableSerialize(normalizedArguments))
    .digest('hex')
  return `${callSessionId}:${toolId}:${digest}`
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

class ToolTimeoutError extends Error {}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new ToolTimeoutError()), Math.max(1, timeoutMs))
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

export function redactArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArguments)
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return { type: 'string', length: value.length }
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|authorization/i.test(key)) output[key] = '[REDACTED]'
    else output[key] = redactArguments(item)
  }
  return output
}
