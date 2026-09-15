import { EventEmitter } from 'node:events'

import type {
  CodexNotification,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolHandler,
  StartThreadOptions,
  ThreadStartOptionsProvider,
  TurnInput
} from '../codex/types.js'
import type { CodexAppServerClient } from '../codex/app-server-client.js'

export interface CopilotBackend {
  startThread(options?: StartThreadOptions): Promise<string>
  startTurn(threadId: string, input: TurnInput): Promise<string>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  appendText(text: string, role: 'user' | 'assistant', realtimeThreadId: string): Promise<void>
  onThreadNotification(
    threadId: string,
    listener: (notification: CodexNotification) => void
  ): () => void
  setDynamicToolHandler(handler?: DynamicToolHandler): void
  setThreadStartOptionsProvider?(provider?: ThreadStartOptionsProvider): void
  dispose?(): Promise<void>
}

export class CodexCopilotBackend implements CopilotBackend {
  constructor(private readonly client: CodexAppServerClient) {}

  startThread(options?: StartThreadOptions): Promise<string> {
    return this.client.startThread(options)
  }

  startTurn(threadId: string, input: TurnInput): Promise<string> {
    return this.client.startTurn(threadId, input)
  }

  interruptTurn(threadId: string, turnId: string): Promise<void> {
    return this.client.interruptTurn(threadId, turnId)
  }

  appendText(text: string, role: 'user' | 'assistant', realtimeThreadId: string): Promise<void> {
    return this.client.appendText(text, role, realtimeThreadId)
  }

  onThreadNotification(
    threadId: string,
    listener: (notification: CodexNotification) => void
  ): () => void {
    return this.client.onThreadNotification(threadId, listener)
  }

  setDynamicToolHandler(handler?: DynamicToolHandler): void {
    this.client.setDynamicToolHandler(handler)
  }

  setThreadStartOptionsProvider(provider?: ThreadStartOptionsProvider): void {
    this.client.setThreadStartOptionsProvider(provider)
  }
}

interface MockThread {
  tools: Set<string>
  toolCalls: number
}

/** Deterministic in-process backend used by mock mode and E2E tests. */
export class MockCopilotBackend extends EventEmitter implements CopilotBackend {
  private static readonly REALTIME_RESPONSE_DELAY_MS = 250
  private nextThread = 1
  private nextTurn = 1
  private handler?: DynamicToolHandler
  private provider?: ThreadStartOptionsProvider
  private readonly threads = new Map<string, MockThread>()
  readonly appended: Array<{ text: string; role: 'user' | 'assistant'; threadId: string }> = []

  async startThread(options: StartThreadOptions = {}): Promise<string> {
    const threadId = `mock-copilot-thread-${this.nextThread++}`
    this.threads.set(threadId, {
      tools: new Set(options.dynamicTools?.map(({ name }) => name) ?? []),
      toolCalls: 0
    })
    return threadId
  }

  async startTurn(threadId: string, input: TurnInput): Promise<string> {
    const turnId = `mock-copilot-turn-${this.nextTurn++}`
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Unknown mock copilot thread: ${threadId}`)
    queueMicrotask(() => void this.runScript(threadId, turnId, thread, input))
    return turnId
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.emitNotification(threadId, 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'interrupted' }
    })
  }

  async appendText(
    text: string,
    role: 'user' | 'assistant',
    realtimeThreadId: string
  ): Promise<void> {
    this.appended.push({ text, role, threadId: realtimeThreadId })
    if (role === 'user') {
      const timer = setTimeout(() => {
        this.emitNotification(realtimeThreadId, 'thread/realtime/transcript/done', {
          threadId: realtimeThreadId,
          role: 'assistant',
          text: 'Mock realtime response completed.'
        })
      }, MockCopilotBackend.REALTIME_RESPONSE_DELAY_MS)
      timer.unref?.()
    }
  }

  onThreadNotification(
    threadId: string,
    listener: (notification: CodexNotification) => void
  ): () => void {
    const event = `thread:${threadId}`
    this.on(event, listener)
    return () => this.off(event, listener)
  }

  setDynamicToolHandler(handler?: DynamicToolHandler): void {
    this.handler = handler
  }

  setThreadStartOptionsProvider(provider?: ThreadStartOptionsProvider): void {
    this.provider = provider
  }

  async createRealtimeThreadForTest(): Promise<string> {
    return this.startThread((await this.provider?.()) ?? {})
  }

  private async runScript(
    threadId: string,
    turnId: string,
    thread: MockThread,
    _input: TurnInput
  ): Promise<void> {
    this.emitNotification(threadId, 'turn/started', {
      threadId,
      turn: { id: turnId, status: 'inProgress' }
    })
    const tool = thread.tools.values().next().value as string | undefined
    if (tool && this.handler) {
      thread.toolCalls += 1
      const toolCallNumber = thread.toolCalls
      const callId = `mock-tool-call-${turnId}`
      this.emitNotification(threadId, 'item/started', {
        threadId,
        turnId,
        item: { type: 'dynamicToolCall', callId, tool }
      })
      const result = await this.handler({
        threadId,
        turnId,
        callId,
        namespace: null,
        tool,
        arguments: mockToolArguments(tool)
      })
      if (tool === 'end_call' && result.success) this.completeRealtimeAssistantTurns()
      if (toolCallNumber === 1) await delay(200)
      this.emitNotification(threadId, 'item/completed', {
        threadId,
        turnId,
        item: {
          type: 'dynamicToolCall',
          callId,
          tool,
          success: result.success
        }
      })
      this.emitNotification(threadId, 'item/completed', {
        threadId,
        turnId,
        item: { type: 'agentMessage', text: result.success ? 'Mock tool completed.' : 'NO_ACTION' }
      })
    } else {
      this.emitNotification(threadId, 'item/completed', {
        threadId,
        turnId,
        item: { type: 'agentMessage', text: 'NO_ACTION' }
      })
    }
    this.emitNotification(threadId, 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' }
    })
  }

  private emitNotification(threadId: string, method: string, params: unknown): void {
    this.emit(`thread:${threadId}`, { method, params } satisfies CodexNotification)
  }

  private completeRealtimeAssistantTurns(): void {
    const timer = setTimeout(() => {
      for (const event of this.eventNames()) {
        if (typeof event !== 'string' || !event.startsWith('thread:')) continue
        const threadId = event.slice('thread:'.length)
        this.emitNotification(threadId, 'thread/realtime/transcript/done', {
          threadId,
          role: 'assistant',
          text: 'Mock farewell completed.'
        })
      }
    }, MockCopilotBackend.REALTIME_RESPONSE_DELAY_MS)
    timer.unref?.()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mockToolArguments(tool: string): Record<string, unknown> {
  if (tool === 'end_call') return { reason: 'callee_requested', farewell_said: true }
  if (tool === 'lookup_customer') return { phone: '+14155550142' }
  if (tool === 'appointments_make') {
    return {
      start_at: nextMockAppointmentStart(),
      time_zone: 'America/Chicago',
      duration_min: 30,
      notes: 'Mock copilot appointment'
    }
  }
  return {}
}

function nextMockAppointmentStart(now = Date.now()): string {
  const step = 30 * 60_000
  let cursor = Math.ceil((now + step) / step) * step
  const deadline = cursor + 8 * 24 * 60 * 60_000
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  })
  while (cursor <= deadline) {
    const parts = formatter.formatToParts(new Date(cursor))
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
    if (!['Sat', 'Sun'].includes(value('weekday') ?? '') && value('hour') === '15' && value('minute') === '00') {
      return new Date(cursor).toISOString()
    }
    cursor += step
  }
  return new Date(now + 24 * 60 * 60_000).toISOString()
}

export function dynamicToolFailure(message: string): DynamicToolCallResponse {
  return {
    contentItems: [{ type: 'inputText', text: message.slice(0, 600) }],
    success: false
  }
}

export function isDynamicToolCall(value: unknown): value is DynamicToolCallParams {
  if (!value || typeof value !== 'object') return false
  const params = value as Record<string, unknown>
  return (
    typeof params.threadId === 'string' &&
    typeof params.turnId === 'string' &&
    typeof params.callId === 'string' &&
    typeof params.tool === 'string'
  )
}
