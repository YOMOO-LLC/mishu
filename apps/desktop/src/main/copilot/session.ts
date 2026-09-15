import type { CopilotStatus, LivePhoneEvent } from '../../shared/contracts.js'
import type { CampaignCopilotPolicy } from '../../shared/policy.js'
import type { CodexNotification, DynamicToolCallParams, DynamicToolCallResponse } from '../codex/types.js'
import type { InCallTool } from './registry.js'
import type { CopilotBackend } from './runner.js'
import { dynamicToolFailure } from './runner.js'
import type { ToolExecutor } from './tool-executor.js'
import { buildCopilotInjection } from './inject.js'

interface TurnState {
  generation: number
  toolCalls: number
  inputText?: string
  toolId?: string
  idempotencyKey?: string
  injectionText?: string
  injectionCompleted?: boolean
  injectionDiscarded?: boolean
  agentSaidNoAction?: boolean
  interrupted?: boolean
  completed?: boolean
}

interface ActiveTool {
  turnId: string
  generation: number
  toolId: string
  controller: AbortController
}

export interface CopilotSessionOptions {
  callId: string
  campaignId: string
  realtimeThreadId?: string
  persona?: string
  policy: CampaignCopilotPolicy
  tools: readonly InCallTool[]
  backend: CopilotBackend
  executor: ToolExecutor
  emit(event: LivePhoneEvent): void
  audit?(action: string, details: Record<string, unknown>): void
  resolveRealtimeThreadId?(): string | undefined
  openingContext?: string
  appendVoiceText?(text: string): Promise<void>
  onVoiceTurnDone?(listener: () => void): () => void
}

export class CopilotSession {
  private threadId?: string
  private realtimeThreadId?: string
  private unsubscribeThread?: () => void
  private unsubscribeRealtimeThread?: () => void
  private pendingTranscript?: string
  private reevaluationPending = false
  private transcriptContext?: string
  private draining = false
  private started = false
  private disposed = false
  private endRequested = false
  private generation = 0
  private activeTurnId?: string
  private activeTool?: ActiveTool
  private readonly turns = new Map<string, TurnState>()
  private readonly completionWaiters = new Map<string, Set<() => void>>()
  private readonly realtimeTurnWaiters = new Set<() => void>()
  private lastToolCall?: CopilotStatus['lastToolCall']

  constructor(private readonly options: CopilotSessionOptions) {
    this.realtimeThreadId = options.realtimeThreadId
  }

  get mode(): CampaignCopilotPolicy['mode'] {
    return this.options.policy.mode
  }

  get copilotThreadId(): string | undefined {
    return this.threadId
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    const generation = this.generation
    let sessionReady = false
    try {
      if (this.options.policy.mode === 'delegation') {
        if (this.realtimeThreadId) this.bindRealtimeThread(this.realtimeThreadId)
      } else {
        const threadId = await this.options.backend.startThread({
          dynamicTools: this.options.tools.map(({ spec }) => ({ ...spec })),
          ephemeral: true,
          developerInstructions: buildDeveloperInstructions(
            this.options.policy,
            this.options.persona
          )
        })
        if (this.disposed || generation !== this.generation) {
          this.options.audit?.('copilot.session.skipped', {
            campaignId: this.options.campaignId,
            mode: this.options.policy.mode,
            tools: this.options.tools.map(({ id }) => id),
            reason: 'call_ended_before_start'
          })
          return
        }
        this.bindCopilotThread(threadId)
        void this.drain()
      }
      const realtimeThreadId = this.realtimeThreadId ?? this.options.resolveRealtimeThreadId?.()
      if (realtimeThreadId) this.watchRealtimeThread(realtimeThreadId)
      sessionReady = true
      this.options.audit?.('copilot.session.started', {
        campaignId: this.options.campaignId,
        mode: this.options.policy.mode,
        tools: this.options.tools.map(({ id }) => id)
      })
      const opening = this.options.openingContext
        ? buildCopilotInjection('contact_lookup', this.options.openingContext)
        : undefined
      if (opening && realtimeThreadId && !this.disposed && generation === this.generation) {
        await (this.options.appendVoiceText?.(opening) ?? this.options.backend.appendText(opening, 'user', realtimeThreadId))
        this.options.emit({ type: 'copilot-injected', text: opening, callId: this.options.callId })
      }
      this.emitStatus('idle')
    } catch (error) {
      if (!sessionReady) {
        this.options.audit?.('copilot.session.skipped', {
          campaignId: this.options.campaignId,
          mode: this.options.policy.mode,
          tools: this.options.tools.map(({ id }) => id),
          reason: 'start_failed',
          error: error instanceof Error ? error.message : String(error)
        })
      }
      this.emitError(error)
    }
  }

  enqueueTranscript(text: string): void {
    if (this.disposed || this.endRequested) return
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) return
    const activeTurn = this.activeTurnId ? this.turns.get(this.activeTurnId) : undefined
    if (
      this.activeTurnId &&
      activeTurn &&
      activeTurn.toolCalls > 0 &&
      !activeTurn.injectionCompleted
    ) {
      this.interruptForTranscript(this.activeTurnId, normalized)
      return
    }
    this.transcriptContext = mergeTranscript(this.transcriptContext, normalized)
    if (this.options.policy.mode !== 'transcript') return
    this.pendingTranscript = this.pendingTranscript
      ? `${this.pendingTranscript}\n${normalized}`
      : normalized
    if (this.threadId) void this.drain()
  }

  canBindDelegationThread(): boolean {
    return !this.disposed && this.options.policy.mode === 'delegation' && !this.threadId
  }

  acceptsThread(threadId: string): boolean {
    return this.threadId === threadId
  }

  bindRealtimeThread(threadId: string): void {
    if (this.disposed || this.options.policy.mode !== 'delegation') return
    this.watchRealtimeThread(threadId)
    this.bindCopilotThread(threadId)
  }

  async handleToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    if (this.disposed || this.endRequested || params.threadId !== this.threadId) {
      return dynamicToolFailure('Copilot session is no longer active.')
    }
    const tool = this.options.tools.find(({ spec }) => spec.name === params.tool)
    if (params.namespace != null || !tool) {
      return dynamicToolFailure('Tool is not registered for this campaign.')
    }
    const turn = this.turns.get(params.turnId) ?? {
      generation: this.generation,
      toolCalls: 0,
      inputText: this.transcriptContext
    }
    this.turns.set(params.turnId, turn)
    if (turn.interrupted || turn.generation !== this.generation) {
      return dynamicToolFailure('Copilot turn was interrupted by newer caller input.')
    }
    if (turn.toolCalls >= this.options.policy.maxToolCallsPerTurn) {
      return dynamicToolFailure('Maximum tool calls for this turn was reached.')
    }
    turn.toolCalls += 1
    turn.toolId = tool.id
    this.activeTurnId = params.turnId
    const toolGeneration = this.generation
    const controller = new AbortController()
    this.activeTool = {
      turnId: params.turnId,
      generation: toolGeneration,
      toolId: tool.id,
      controller
    }
    this.emitStatus('tool')

    const outcome = await this.options.executor.execute({
      campaignId: this.options.campaignId,
      callSessionId: this.options.callId,
      toolId: tool.id,
      arguments: params.arguments,
      policy: this.options.policy,
      signal: controller.signal,
      turnDone: tool.id === 'end_call'
        ? this.waitForRealtimeTurnDone()
        : this.waitForCompletion(params.turnId)
    })
    if (this.disposed) return dynamicToolFailure('Copilot session ended before the tool completed.')
    if (tool.id === 'end_call' && outcome.success) {
      this.endRequested = true
      this.pendingTranscript = undefined
      this.options.emit({ type: 'call-end-requested', callId: this.options.callId })
    }
    const stale = toolGeneration !== this.generation || turn.interrupted
    turn.idempotencyKey = outcome.idempotencyKey
    if (stale) {
      this.recordDiscarded(turn, toolGeneration)
      if (this.activeTool?.controller === controller) this.activeTool = undefined
      return dynamicToolFailure('Tool result was discarded after newer caller input.')
    }
    if (this.activeTool?.controller === controller) this.activeTool = undefined
    this.lastToolCall = { toolId: tool.id, at: Date.now(), ok: outcome.success }
    if (outcome.success && outcome.injectionText && tool.id !== 'end_call') {
      turn.injectionText = outcome.injectionText
    }
    this.emitStatus('thinking')
    return {
      contentItems: [{ type: 'inputText', text: outcome.modelText }],
      success: outcome.success
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.activeTool?.controller.abort()
    this.activeTool = undefined
    this.pendingTranscript = undefined
    this.unsubscribeThread?.()
    this.unsubscribeThread = undefined
    this.unsubscribeRealtimeThread?.()
    this.unsubscribeRealtimeThread = undefined
    const threadId = this.threadId
    const turnId = this.activeTurnId
    this.threadId = undefined
    this.activeTurnId = undefined
    for (const waiters of this.completionWaiters.values()) {
      for (const resolve of waiters) resolve()
    }
    this.completionWaiters.clear()
    for (const resolve of this.realtimeTurnWaiters) resolve()
    this.realtimeTurnWaiters.clear()
    this.turns.clear()
    if (threadId && turnId) {
      await this.options.backend.interruptTurn(threadId, turnId).catch(() => undefined)
    }
    this.emitStatus('idle')
  }

  private bindCopilotThread(threadId: string): void {
    if (this.threadId === threadId) return
    this.unsubscribeThread?.()
    this.threadId = threadId
    this.unsubscribeThread = this.options.backend.onThreadNotification(
      threadId,
      (notification) => this.onNotification(notification)
    )
  }

  private watchRealtimeThread(threadId: string): void {
    if (this.realtimeThreadId === threadId && this.unsubscribeRealtimeThread) return
    this.unsubscribeRealtimeThread?.()
    this.realtimeThreadId = threadId
    if (this.options.onVoiceTurnDone) {
      this.unsubscribeRealtimeThread = this.options.onVoiceTurnDone(() => {
        for (const resolve of this.realtimeTurnWaiters) resolve()
        this.realtimeTurnWaiters.clear()
      })
      return
    }
    this.unsubscribeRealtimeThread = this.options.backend.onThreadNotification(
      threadId,
      (notification) => this.onRealtimeNotification(notification)
    )
  }

  private onRealtimeNotification(notification: CodexNotification): void {
    const params = (notification.params ?? {}) as Record<string, unknown>
    const assistantTranscriptDone =
      notification.method === 'thread/realtime/transcript/done' && params.role === 'assistant'
    if (!assistantTranscriptDone && notification.method !== 'turn/completed') return
    for (const resolve of this.realtimeTurnWaiters) resolve()
    this.realtimeTurnWaiters.clear()
  }

  private waitForRealtimeTurnDone(): Promise<void> {
    const realtimeThreadId = this.realtimeThreadId ?? this.options.resolveRealtimeThreadId?.()
    if (realtimeThreadId || this.options.onVoiceTurnDone) this.watchRealtimeThread(realtimeThreadId ?? this.options.callId)
    return new Promise((resolve) => {
      this.realtimeTurnWaiters.add(resolve)
    })
  }

  private async drain(): Promise<void> {
    if (
      this.draining ||
      this.disposed ||
      !this.threadId
    ) return
    this.draining = true
    try {
      while (!this.disposed && this.pendingTranscript) {
        const transcript = this.pendingTranscript
        this.pendingTranscript = undefined
        const reevaluation = this.reevaluationPending
        this.reevaluationPending = false
        const turnGeneration = this.generation
        this.emitStatus('thinking')
        const turnId = await this.options.backend.startTurn(
          this.threadId,
          reevaluation ? buildReevaluationInput(transcript) : transcript
        )
        if (this.disposed || turnGeneration !== this.generation) continue
        this.activeTurnId = turnId
        this.turns.set(turnId, this.turns.get(turnId) ?? {
          generation: turnGeneration,
          toolCalls: 0,
          inputText: transcript
        })
        await this.waitForCompletion(turnId)
        if (this.activeTurnId === turnId) this.activeTurnId = undefined
      }
      if (!this.disposed) this.emitStatus('idle')
    } catch (error) {
      if (!this.disposed) this.emitError(error)
    } finally {
      this.draining = false
      if (!this.disposed && this.pendingTranscript) void this.drain()
    }
  }

  private onNotification(notification: CodexNotification): void {
    if (this.disposed) return
    const params = (notification.params ?? {}) as Record<string, unknown>
    if (notification.method === 'turn/started') {
      const turnId = getTurnId(params)
      if (turnId) {
        const existing = this.turns.get(turnId)
        if (existing?.interrupted) return
        this.activeTurnId = turnId
        this.turns.set(turnId, this.turns.get(turnId) ?? {
          generation: this.generation,
          toolCalls: 0,
          inputText: this.transcriptContext
        })
      }
      this.emitStatus('thinking')
      return
    }
    if (notification.method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined
      const turnId = getItemTurnId(params) ?? this.activeTurnId
      if (turnId && item?.type === 'agentMessage' && item.text === 'NO_ACTION') {
        const turn = this.turns.get(turnId)
        if (turn) turn.agentSaidNoAction = true
      }
      return
    }
    if (notification.method === 'turn/completed') {
      const turnId = getTurnId(params) ?? this.activeTurnId
      if (turnId) void this.finishTurn(turnId)
      return
    }
    if (notification.method === 'error') this.emitError(params.message ?? 'Copilot turn failed')
  }

  private async finishTurn(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId) ?? { generation: this.generation, toolCalls: 0 }
    if (turn.completed) return
    turn.completed = true
    this.turns.set(turnId, turn)
    try {
      const current = !turn.interrupted && turn.generation === this.generation
      if (!this.disposed && current && turn.injectionText && !turn.agentSaidNoAction) {
        const realtimeThreadId =
          this.realtimeThreadId ??
          this.options.resolveRealtimeThreadId?.()
        if (realtimeThreadId) {
          await (this.options.appendVoiceText?.(turn.injectionText) ?? this.options.backend.appendText(turn.injectionText, 'user', realtimeThreadId))
          if (!this.disposed && !turn.interrupted && turn.generation === this.generation) {
            this.options.emit({
              type: 'copilot-injected',
              text: turn.injectionText,
              callId: this.options.callId
            })
            turn.injectionCompleted = true
          } else {
            this.recordDiscarded(turn, turn.generation)
          }
        }
      } else if (turn.injectionText && !turn.agentSaidNoAction && !current) {
        this.recordDiscarded(turn, turn.generation)
      }
    } catch (error) {
      if (!this.disposed) this.emitError(error)
    } finally {
      for (const resolve of this.completionWaiters.get(turnId) ?? []) resolve()
      this.completionWaiters.delete(turnId)
      const wasActive = this.activeTurnId === turnId
      if (wasActive) this.activeTurnId = undefined
      if (!this.disposed && wasActive && turn.generation === this.generation) this.emitStatus('idle')
    }
  }

  private waitForCompletion(turnId: string): Promise<void> {
    if (this.turns.get(turnId)?.completed) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.completionWaiters.get(turnId) ?? new Set<() => void>()
      waiters.add(resolve)
      this.completionWaiters.set(turnId, waiters)
    })
  }

  private interruptForTranscript(turnId: string, newestTranscript: string): void {
    const threadId = this.threadId
    const turn = this.turns.get(turnId)
    if (!threadId || !turn || turn.interrupted) return
    const interruptedGeneration = turn.generation
    turn.interrupted = true
    this.activeTool?.controller.abort()
    this.activeTool = undefined
    this.generation += 1
    const combined = mergeTranscript(
      turn.inputText ?? this.transcriptContext,
      this.pendingTranscript,
      newestTranscript
    )
    this.transcriptContext = combined
    this.pendingTranscript = combined
    this.reevaluationPending = true
    this.activeTurnId = undefined
    for (const resolve of this.completionWaiters.get(turnId) ?? []) resolve()
    this.completionWaiters.delete(turnId)
    if (turn.injectionText) this.recordDiscarded(turn, interruptedGeneration)
    this.emitStatus('interrupted')
    void this.options.backend.interruptTurn(threadId, turnId).catch((error) => {
      if (!this.disposed) this.emitError(error)
    })
    void this.drain()
  }

  private recordDiscarded(turn: TurnState, generation: number): void {
    if (turn.injectionDiscarded || !turn.toolId) return
    turn.injectionDiscarded = true
    this.options.executor.recordDiscarded(
      { callSessionId: this.options.callId, toolId: turn.toolId },
      {
        generation,
        ...(turn.idempotencyKey ? { idempotencyKey: turn.idempotencyKey } : {})
      }
    )
  }

  private emitStatus(state: CopilotStatus['state']): void {
    this.options.emit({
      type: 'copilot-status',
      status: {
        enabled: !this.disposed,
        ...(this.threadId ? { threadId: this.threadId } : {}),
        state,
        generation: this.generation,
        ...(state === 'tool' && this.activeTool
          ? { pendingToolId: this.activeTool.toolId }
          : {}),
        ...(this.lastToolCall ? { lastToolCall: this.lastToolCall } : {})
      }
    })
  }

  private emitError(error: unknown): void {
    this.emitStatus('error')
    void error
  }
}

function getTurnId(params: Record<string, unknown>): string | undefined {
  const turn = params.turn as Record<string, unknown> | undefined
  return typeof turn?.id === 'string' ? turn.id : undefined
}

function getItemTurnId(params: Record<string, unknown>): string | undefined {
  return typeof params.turnId === 'string' ? params.turnId : undefined
}

export const COPILOT_END_CALL_INSTRUCTION =
  'When the callee asks to stop, or the call goal is complete, say exactly one brief farewell sentence, immediately call end_call with farewell_said true, and do not speak again after calling it.'

function buildDeveloperInstructions(
  policy: CampaignCopilotPolicy,
  persona: string | undefined
): string {
  const configuredPersona = persona?.trim()
  return [
    'You are an in-call copilot. Decide semantically whether a registered tool is needed.',
    'Use only registered tools and never use shell, filesystem, or web tools.',
    'If no tool action is useful, answer exactly NO_ACTION.',
    'When newer caller input cancels or changes the request, answer exactly NO_ACTION; if the action is still needed, call the registered tool again.',
    'After a tool call, give one short factual sentence for the voice agent.',
    policy.mayEndCall && policy.allowedToolIds.includes('end_call')
      ? COPILOT_END_CALL_INSTRUCTION
      : '',
    configuredPersona
      ? `Use only this configured persona for identity; do not invent another name, organization, or identity: ${configuredPersona}`
      : 'Do not invent an organization affiliation, name, or identity. If asked, say you are an automated voice assistant.',
    policy.prompt.trim()
  ].filter(Boolean).join('\n')
}

function mergeTranscript(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join('\n')
}

function buildReevaluationInput(transcript: string): string {
  return [
    'Reevaluate the caller intent using the merged transcript below.',
    'If the caller cancelled or changed their mind, answer exactly NO_ACTION.',
    'If the action is still needed, call the registered tool again.',
    '',
    transcript
  ].join('\n')
}
