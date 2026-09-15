import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import type { LivePhoneEvent } from '../../shared/contracts.js'
import type { CampaignCopilotPolicy } from '../../shared/policy.js'
import type {
  CodexNotification,
  DynamicToolHandler,
  StartThreadOptions,
  ThreadStartOptionsProvider,
  TurnInput
} from '../codex/types.js'
import { ToolRegistry, type InCallTool } from './registry.js'
import type { CopilotBackend } from './runner.js'
import { CopilotSession } from './session.js'
import { ToolExecutor } from './tool-executor.js'

class FakeBackend extends EventEmitter implements CopilotBackend {
  readonly turns: Array<{ threadId: string; input: TurnInput; turnId: string }> = []
  readonly interrupted: Array<{ threadId: string; turnId: string }> = []
  readonly appended: string[] = []
  private nextTurn = 1
  private handler?: DynamicToolHandler
  startOptions?: StartThreadOptions

  async startThread(options?: StartThreadOptions): Promise<string> {
    this.startOptions = options
    return 'copilot-thread'
  }
  async startTurn(threadId: string, input: TurnInput): Promise<string> {
    const turnId = `turn-${this.nextTurn++}`
    this.turns.push({ threadId, input, turnId })
    return turnId
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId })
  }
  async appendText(text: string): Promise<void> {
    this.appended.push(text)
  }
  onThreadNotification(threadId: string, listener: (notification: CodexNotification) => void): () => void {
    const event = `thread:${threadId}`
    this.on(event, listener)
    return () => this.off(event, listener)
  }
  setDynamicToolHandler(handler?: DynamicToolHandler): void {
    this.handler = handler
  }
  setThreadStartOptionsProvider(_provider?: ThreadStartOptionsProvider): void {}
  complete(turnId: string): void {
    this.emit('thread:copilot-thread', {
      method: 'turn/completed',
      params: { threadId: 'copilot-thread', turn: { id: turnId } }
    } satisfies CodexNotification)
  }
  agentMessage(turnId: string, text: string): void {
    this.emit('thread:copilot-thread', {
      method: 'item/completed',
      params: {
        threadId: 'copilot-thread',
        turnId,
        item: { type: 'agentMessage', text }
      }
    } satisfies CodexNotification)
  }
  completeRealtimeAssistant(): void {
    this.emit('thread:realtime-thread', {
      method: 'thread/realtime/transcript/done',
      params: {
        threadId: 'realtime-thread',
        role: 'assistant',
        text: 'Farewell complete.'
      }
    } satisfies CodexNotification)
  }
}

const policy: CampaignCopilotPolicy = {
  enabled: true,
  mode: 'transcript',
  prompt: '',
  allowedToolIds: ['lookup_customer'],
  autoExecuteRisks: ['read'],
  maxToolCallsPerTurn: 2,
  mayEndCall: true
}

function createTool(): InCallTool {
  return {
    id: 'lookup_customer',
    version: 1,
    spec: {
      type: 'function',
      name: 'lookup_customer',
      description: 'lookup',
      inputSchema: { type: 'object' }
    },
    risk: 'read',
    timeoutMs: 100,
    validate: (value) => value,
    execute: async () => ({ tier: 'Gold' }),
    toModelText: () => 'Found membership tier Gold.'
  }
}

function createSession(
  backend = new FakeBackend(),
  options: {
    tool?: InCallTool
    policy?: CampaignCopilotPolicy
    openingContext?: string
    persona?: string
  } = {}
) {
  const registry = new ToolRegistry()
  const tool = options.tool ?? createTool()
  registry.register(tool)
  const events: LivePhoneEvent[] = []
  const audit = { write: vi.fn() }
  const executor = new ToolExecutor({
    registry,
    requestApproval: vi.fn(),
    audit
  })
  const session = new CopilotSession({
    callId: 'call-1',
    campaignId: 'campaign-1',
    realtimeThreadId: 'realtime-thread',
    persona: options.persona,
    policy: options.policy ?? policy,
    tools: [tool],
    backend,
    executor,
    openingContext: options.openingContext,
    emit: (event) => events.push(event)
  })
  return { session, backend, events, audit, tool }
}

describe('CopilotSession', () => {
  it('tells the transcript copilot to end only when mayEndCall and the whitelist allow it', async () => {
    const enabled = createSession(new FakeBackend(), {
      policy: { ...policy, allowedToolIds: ['lookup_customer', 'end_call'], mayEndCall: true }
    })
    await enabled.session.start()
    expect(enabled.backend.startOptions?.developerInstructions).toContain('call end_call')
    await enabled.session.dispose()

    const disabled = createSession(new FakeBackend(), {
      policy: { ...policy, allowedToolIds: ['lookup_customer', 'end_call'], mayEndCall: false }
    })
    await disabled.session.start()
    expect(disabled.backend.startOptions?.developerInstructions).not.toContain('call end_call')
    await disabled.session.dispose()
  })

  it('forbids invented identity without persona and limits identity when configured', async () => {
    const absent = createSession()
    await absent.session.start()
    expect(absent.backend.startOptions?.developerInstructions).toContain(
      'Do not invent an organization affiliation, name, or identity.'
    )
    expect(absent.backend.startOptions?.developerInstructions).toContain(
      'say you are an automated voice assistant'
    )
    await absent.session.dispose()

    const configured = createSession(new FakeBackend(), { persona: 'Configured booking assistant' })
    await configured.session.start()
    expect(configured.backend.startOptions?.developerInstructions).toContain(
      'Use only this configured persona for identity'
    )
    expect(configured.backend.startOptions?.developerInstructions).toContain(
      'Configured booking assistant'
    )
    expect(configured.backend.startOptions?.developerInstructions).not.toContain(
      'say you are an automated voice assistant'
    )
    await configured.session.dispose()
  })

  it('injects contact opening context once through the fixed template', async () => {
    const { session, backend, events } = createSession(new FakeBackend(), {
      openingContext: 'Caller background: Name: Ada; Tier: Gold'
    })
    await session.start()
    await session.start()
    expect(backend.appended).toEqual(['System note: tool contact_lookup completed. Caller background: Name: Ada; Tier: Gold'])
    expect(events.filter(({ type }) => type === 'copilot-injected')).toHaveLength(1)
    await session.dispose()
  })

  it('does not inject opening context when no contact card exists', async () => {
    const { session, backend, events } = createSession()
    await session.start()
    expect(backend.appended).toEqual([])
    expect(events.filter(({ type }) => type === 'copilot-injected')).toHaveLength(0)
    await session.dispose()
  })

  it('serializes turns and merges transcripts received while busy', async () => {
    const { session, backend } = createSession()
    await session.start()
    session.enqueueTranscript('first')
    await vi.waitFor(() => expect(backend.turns).toHaveLength(1))
    session.enqueueTranscript('second')
    session.enqueueTranscript('third')
    expect(backend.turns).toHaveLength(1)

    backend.complete('turn-1')
    await vi.waitFor(() => expect(backend.turns).toHaveLength(2))
    expect(backend.turns[1].input).toBe('second\nthird')
    backend.complete('turn-2')
    await session.dispose()
  })

  it('interrupts the active turn and ignores late completion after hangup', async () => {
    const { session, backend, events } = createSession()
    await session.start()
    session.enqueueTranscript('first')
    await vi.waitFor(() => expect(backend.turns).toHaveLength(1))
    await session.dispose()
    backend.complete('turn-1')

    expect(backend.interrupted).toEqual([{ threadId: 'copilot-thread', turnId: 'turn-1' }])
    expect(events.at(-1)).toMatchObject({
      type: 'copilot-status',
      status: { enabled: false, state: 'idle' }
    })
  })

  it('injects only the fixed app template after a successful tool turn', async () => {
    const { session, backend, events } = createSession()
    await session.start()
    session.enqueueTranscript('RAW_CALLER_SENTENCE')
    await vi.waitFor(() => expect(backend.turns).toHaveLength(1))
    const response = await session.handleToolCall({
      threadId: 'copilot-thread',
      turnId: 'turn-1',
      callId: 'tool-call-1',
      tool: 'lookup_customer',
      arguments: { callerText: 'RAW_CALLER_SENTENCE' }
    })
    expect(response.success).toBe(true)
    backend.complete('turn-1')
    await vi.waitFor(() => expect(backend.appended).toHaveLength(1))

    expect(backend.appended[0]).toBe('System note: tool lookup_customer completed. Found membership tier Gold.')
    expect(backend.appended[0]).not.toContain('RAW_CALLER_SENTENCE')
    expect(events.some(({ type }) => type === 'copilot-injected')).toBe(true)
    await session.dispose()
  })

  it('gives end_call the realtime assistant completion instead of the copilot turn', async () => {
    let realtimeDone: Promise<void> | undefined
    const endCall = createTool()
    endCall.id = 'end_call'
    endCall.spec.name = 'end_call'
    endCall.execute = async (ctx) => {
      realtimeDone = ctx.turnDone
      return { scheduled: true }
    }
    endCall.toModelText = () => 'The call will end after the farewell.'
    const backend = new FakeBackend()
    const { session, events } = createSession(backend, {
      tool: endCall,
      policy: { ...policy, allowedToolIds: ['end_call'] }
    })
    await session.start()
    session.enqueueTranscript('please end the call')
    await vi.waitFor(() => expect(backend.turns).toHaveLength(1))

    await session.handleToolCall({
      threadId: 'copilot-thread',
      turnId: 'turn-1',
      callId: 'tool-call-1',
      tool: 'end_call',
      arguments: { reason: 'completed', farewell_said: true }
    })
    expect(events).toContainEqual({ type: 'call-end-requested', callId: 'call-1' })
    let settled = false
    void realtimeDone?.then(() => { settled = true })
    backend.complete('turn-1')
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(backend.appended).toEqual([])
    session.enqueueTranscript('please start another turn')
    expect(backend.turns).toHaveLength(1)

    backend.completeRealtimeAssistant()
    await vi.waitFor(() => expect(settled).toBe(true))
    await session.dispose()
  })

  it('interrupts an in-flight tool, discards its stale result, and reuses it idempotently', async () => {
    let resolveTool!: (value: { tier: string }) => void
    let receivedSignal: AbortSignal | undefined
    const execute = vi.fn((ctx: { signal?: AbortSignal }) => {
      receivedSignal = ctx.signal
      return new Promise<{ tier: string }>((resolve) => { resolveTool = resolve })
    })
    const backend = new FakeBackend()
    const events: LivePhoneEvent[] = []
    const audit = { write: vi.fn() }
    const registeredTool = createTool()
    registeredTool.execute = execute

    const registry = new ToolRegistry()
    registry.register(registeredTool)
    const executor = new ToolExecutor({
      registry,
      requestApproval: vi.fn(),
      audit
    })
    const interruptibleSession = new CopilotSession({
      callId: 'call-1',
      campaignId: 'campaign-1',
      realtimeThreadId: 'realtime-thread',
      policy,
      tools: [registeredTool],
      backend,
      executor,
      emit: (event) => events.push(event)
    })

    await interruptibleSession.start()
    interruptibleSession.enqueueTranscript('first request')
    await vi.waitFor(() => expect(backend.turns).toHaveLength(1))
    const firstResponse = interruptibleSession.handleToolCall({
      threadId: 'copilot-thread',
      turnId: 'turn-1',
      callId: 'tool-call-1',
      tool: 'lookup_customer',
      arguments: { phone: '+14155550142' }
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'copilot-status',
      status: expect.objectContaining({
        state: 'tool',
        generation: 0,
        pendingToolId: 'lookup_customer'
      })
    }))

    interruptibleSession.enqueueTranscript('second request changes the decision')
    await vi.waitFor(() => expect(backend.interrupted).toEqual([
      { threadId: 'copilot-thread', turnId: 'turn-1' }
    ]))
    expect(receivedSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(backend.turns).toHaveLength(2))
    expect(backend.turns[1].input).toContain('first request\nsecond request changes the decision')
    expect(backend.turns[1].input).toContain('answer exactly NO_ACTION')
    expect(backend.turns[1].input).toContain('call the registered tool again')

    resolveTool({ tier: 'Gold' })
    await expect(firstResponse).resolves.toMatchObject({ success: false })
    expect(backend.appended).toHaveLength(0)
    expect(audit.write).toHaveBeenCalledWith(
      'copilot',
      'copilot.injection.discarded',
      'call-1',
      expect.objectContaining({ toolId: 'lookup_customer', generation: 0 })
    )

    const secondResponse = await interruptibleSession.handleToolCall({
      threadId: 'copilot-thread',
      turnId: 'turn-2',
      callId: 'tool-call-2',
      tool: 'lookup_customer',
      arguments: { phone: '+14155550142' }
    })
    expect(secondResponse.success).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
    backend.complete('turn-2')
    await vi.waitFor(() => expect(backend.appended).toHaveLength(1))
    expect(events.filter(({ type }) => type === 'copilot-injected')).toHaveLength(1)
    await interruptibleSession.dispose()
  })

  it('does not inject when the copilot answers NO_ACTION', async () => {
    const { session, backend, events } = createSession()
    await session.start()
    session.enqueueTranscript('casual caller message')
    await vi.waitFor(() => expect(backend.turns).toHaveLength(1))
    backend.agentMessage('turn-1', 'NO_ACTION')
    backend.complete('turn-1')
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({
      type: 'copilot-status',
      status: { state: 'idle' }
    }))
    expect(backend.appended).toHaveLength(0)
    expect(events.filter(({ type }) => type === 'copilot-injected')).toHaveLength(0)
    await session.dispose()
  })

  it('interrupts the backing realtime thread in delegation mode', async () => {
    let resolveTool!: (value: { tier: string }) => void
    const delegatedTool = createTool()
    delegatedTool.execute = () => new Promise((resolve) => { resolveTool = resolve })
    const delegationPolicy: CampaignCopilotPolicy = { ...policy, mode: 'delegation' }
    const { session, backend } = createSession(new FakeBackend(), {
      tool: delegatedTool,
      policy: delegationPolicy
    })
    await session.start()
    session.enqueueTranscript('original caller request')
    const response = session.handleToolCall({
      threadId: 'realtime-thread',
      turnId: 'delegated-turn',
      callId: 'delegated-call',
      tool: 'lookup_customer',
      arguments: { phone: '+14155550142' }
    })
    await vi.waitFor(() => expect(backend.interrupted).toHaveLength(0))
    session.enqueueTranscript('new caller direction')
    await vi.waitFor(() => expect(backend.interrupted).toEqual([
      { threadId: 'realtime-thread', turnId: 'delegated-turn' }
    ]))
    await vi.waitFor(() => expect(backend.turns).toHaveLength(1))
    expect(backend.turns[0].threadId).toBe('realtime-thread')
    expect(backend.turns[0].input).toContain('original caller request\nnew caller direction')
    expect(backend.turns[0].input).toContain('answer exactly NO_ACTION')
    resolveTool({ tier: 'Gold' })
    await response
    await session.dispose()
  })
})
