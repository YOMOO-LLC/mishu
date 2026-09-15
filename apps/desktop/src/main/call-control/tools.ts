import type { InCallTool, ToolExecutionContext } from '../copilot/registry.js'

export const END_CALL_TOOL_ID = 'end_call'
export const END_CALL_AUDIT_ACTION = 'copilot.call.end_requested'
export const END_CALL_WAIT_AUDIT_ACTION = 'copilot.call.end_waited'
export const END_CALL_TURN_WAIT_MS = 4_000

export type EndCallWaitReason = 'turn_done' | 'timeout'

export type EndCallReason = 'completed' | 'callee_requested' | 'policy'

export interface EndCallArgs {
  reason: EndCallReason
  farewell_said: boolean
}

export interface EndCallResult {
  scheduled: true
  completion: Promise<void>
}

export interface EndCallToolDependencies {
  hangup(): Promise<unknown>
  silence?(): Promise<void>
  writeAudit(
    actor: 'copilot',
    action: string,
    callId: string,
    details: Record<string, unknown>
  ): void
}

export function createEndCallTool(dependencies: EndCallToolDependencies): InCallTool<EndCallArgs, EndCallResult> {
  return {
    id: END_CALL_TOOL_ID,
    version: 1,
    spec: {
      type: 'function',
      name: END_CALL_TOOL_ID,
      description: 'End the current phone call after a brief polite farewell.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['completed', 'callee_requested', 'policy'],
            description: 'Why the call should end.'
          },
          farewell_said: {
            type: 'boolean',
            description: 'Whether the assistant already said a brief farewell.'
          }
        },
        required: ['reason', 'farewell_said'],
        additionalProperties: false
      },
      deferLoading: false
    },
    risk: 'automatic',
    timeoutMs: 2_000,
    validate: validateEndCallArgs,
    async execute(ctx, args) {
      dependencies.writeAudit('copilot', END_CALL_AUDIT_ACTION, ctx.callSessionId, {
        reason: args.reason,
        farewell_said: args.farewell_said
      })
      // The dynamic-tool response must return before its turn can complete. Keep the
      // hangup continuation detached so turn.done can arrive; the cap prevents a lost
      // notification from leaving the call open indefinitely.
      void dependencies.silence?.().catch(() => undefined)
      const completion = hangupAfterTurn(ctx, dependencies)
      void completion.catch(() => undefined)
      return { scheduled: true, completion }
    },
    toModelText() {
      return 'End the call. Do not speak again.'
    }
  }
}

function validateEndCallArgs(value: unknown): EndCallArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('end_call arguments must be an object')
  }
  const args = value as Record<string, unknown>
  if (!['completed', 'callee_requested', 'policy'].includes(String(args.reason))) {
    throw new Error('reason is invalid')
  }
  if (typeof args.farewell_said !== 'boolean') {
    throw new Error('farewell_said must be boolean')
  }
  return {
    reason: args.reason as EndCallReason,
    farewell_said: args.farewell_said
  }
}

async function hangupAfterTurn(
  ctx: ToolExecutionContext,
  dependencies: EndCallToolDependencies
): Promise<void> {
  const wait = await waitForTurnDone(ctx.turnDone)
  dependencies.writeAudit('copilot', END_CALL_WAIT_AUDIT_ACTION, ctx.callSessionId, {
    waitedMs: wait.waitedMs,
    waitReason: wait.reason
  })
  await dependencies.hangup()
}

function waitForTurnDone(
  turnDone?: Promise<void>
): Promise<{ reason: EndCallWaitReason; waitedMs: number }> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const finish = (reason: EndCallWaitReason): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ reason, waitedMs: Math.max(0, Date.now() - startedAt) })
    }
    const timer = setTimeout(() => finish('timeout'), END_CALL_TURN_WAIT_MS)
    timer.unref?.()
    if (turnDone) void turnDone.then(
      () => finish('turn_done'),
      () => finish('turn_done')
    )
  })
}
