import { IPC, LOCAL_TENANT_ID, type Campaign, type LivePhoneEvent } from '../../shared/contracts.js'
import { DEFAULT_COPILOT_POLICY } from '../../shared/policy.js'
import type { MainModuleContext, MainModuleHandle } from '../module-context.js'
import type { StartThreadOptions } from '../codex/types.js'
import { registerDemoTools } from './demo-tools.js'
import { CodexCopilotBackend, MockCopilotBackend, type CopilotBackend, dynamicToolFailure } from './runner.js'
import { COPILOT_END_CALL_INSTRUCTION, CopilotSession } from './session.js'
import { ToolExecutor } from './tool-executor.js'
import { openingContactText } from '../contacts/tools.js'

export function register(ctx: MainModuleContext): MainModuleHandle {
  registerDemoTools(ctx.toolRegistry)
  const backend: CopilotBackend = ctx.isMock
    ? new MockCopilotBackend()
    : new CodexCopilotBackend(ctx.codex())
  const sessions = new Map<string, CopilotSession>()
  let disposed = false
  const approvals = ctx.approvals

  const emit = (event: LivePhoneEvent): void => {
    const window = ctx.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.event, event)
  }
  const executor = new ToolExecutor({
    registry: ctx.toolRegistry,
    requestApproval: async (request) => {
      const outcome = await approvals.request({
        kind: request.kind,
        title: request.title,
        summary: request.summary,
        details: request.details,
        requestedBy: request.requestedBy
      })
      return outcome.approved
        ? outcome.decision
        : { id: request.id, approved: false, decidedAt: Date.now() }
    },
    audit: {
      write(actor, action, callId, details) {
        ctx.callStore.getDatabase().prepare(`
          INSERT INTO audit_log (tenant_id, at, actor, action, call_id, details_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(ctx.callStore.tenantId ?? LOCAL_TENANT_ID, Date.now(), actor, action, callId, JSON.stringify(details))
      }
    }
  })

  backend.setDynamicToolHandler(async (params) => {
    let session = [...sessions.values()].find((candidate) => candidate.acceptsThread(params.threadId))
    if (!session) {
      session = [...sessions.values()].find((candidate) => candidate.canBindDelegationThread())
      session?.bindRealtimeThread(params.threadId)
    }
    return session
      ? session.handleToolCall(params)
      : dynamicToolFailure('No active copilot session owns this thread.')
  })

  backend.setThreadStartOptionsProvider?.(() => delegationThreadOptions(ctx))

  const unsubscribe = ctx.callStore.onEvent((event) => {
    if (disposed) return
    if (event.type === 'call.started') {
      const campaign = resolveCampaign(ctx, event.call.campaignId, event.call.id)
      const policy = campaign?.policy.copilot ?? DEFAULT_COPILOT_POLICY
      if (!campaign) {
        writeCopilotAudit(ctx, 'copilot.session.skipped', event.call.id, {
          campaignId: event.call.campaignId,
          reason: 'campaign_not_found'
        })
        return
      }
      if (ctx.services?.voice?.get().provider === 'gpt-live-api' && policy.mode === 'delegation') {
        writeCopilotAudit(ctx, 'copilot.session.skipped', event.call.id, { reason: 'api_delegation_not_supported' })
        return
      }
      if (!policy.enabled) {
        writeCopilotAudit(ctx, 'copilot.session.skipped', event.call.id, {
          campaignId: campaign.id,
          reason: 'policy_disabled'
        })
        return
      }
      if (!claimCopilotSession(ctx, event.call.id, campaign.id)) {
        writeCopilotAudit(ctx, 'copilot.session.skipped', event.call.id, {
          campaignId: campaign.id,
          reason: 'duplicate_call_start'
        })
        return
      }
      const tools = ctx.toolRegistry.forCampaign(policy)
      const session = new CopilotSession({
        callId: event.call.id,
        campaignId: campaign.id,
        realtimeThreadId: event.call.threadId,
        persona: campaign.policy.persona,
        policy,
        tools,
        backend,
        ...(!ctx.isMock ? {
          appendVoiceText: (text: string) => ctx.services.realtime.appendText(text),
          onVoiceTurnDone: (listener: () => void) => ctx.services.realtime.subscribe((event) => { if (event.type === 'turnDone') listener() })
        } : {}),
        executor,
        emit,
        audit: (action, details) => writeCopilotAudit(ctx, action, event.call.id, details),
        openingContext: openingContext(ctx, event.call),
        resolveRealtimeThreadId: () =>
          ctx.callStore.getCall(event.call.id)?.threadId
          ?? (ctx.isMock ? `mock-realtime-${event.call.id}` : undefined)
      })
      sessions.set(event.call.id, session)
      void session.start()
      return
    }
    if (event.type === 'transcript.final') {
      if (event.entry.speaker === 'caller') sessions.get(event.callId)?.enqueueTranscript(event.entry.text)
      return
    }
    if (event.type === 'call.ended') {
      const session = sessions.get(event.call.id)
      sessions.delete(event.call.id)
      void session?.dispose()
    }
  })

  return {
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      backend.setDynamicToolHandler(undefined)
      backend.setThreadStartOptionsProvider?.(undefined)
      for (const session of sessions.values()) void session.dispose()
      sessions.clear()
    }
  }
}

function claimCopilotSession(
  ctx: MainModuleContext,
  callId: string,
  campaignId: string
): boolean {
  const tenantId = ctx.callStore.tenantId ?? LOCAL_TENANT_ID
  const result = ctx.callStore.getDatabase().prepare(`
    INSERT INTO audit_log (tenant_id, at, actor, action, call_id, details_json)
    SELECT ?, ?, 'copilot', 'copilot.session.claimed', ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_log
      WHERE tenant_id = ?
        AND actor = 'copilot'
        AND action IN ('copilot.session.claimed', 'copilot.session.started')
        AND call_id = ?
    )
  `).run(
    tenantId,
    Date.now(),
    callId,
    JSON.stringify({ campaignId }),
    tenantId,
    callId
  )
  return result.changes === 1
}

function openingContext(
  ctx: MainModuleContext,
  call: import('../../shared/contracts.js').CallSession
): string | undefined {
  const card = ctx.services.contacts.find(call.peer)
  return card ? openingContactText(call.direction, card).slice(0, 300) : undefined
}

export function delegationThreadOptions(ctx: MainModuleContext): StartThreadOptions | undefined {
  if (ctx.services?.voice?.get().provider === 'gpt-live-api') return undefined
  const activeCallId = ctx.callStore.getActiveCallId()
  const activeCall = activeCallId ? ctx.callStore.getCall(activeCallId) : undefined
  let stagedCampaignId: string | undefined
  try {
    stagedCampaignId = ctx.phoneGateway.getStatus().selectedCampaignId
  } catch {
    // The renderer may not have published its initial status yet.
  }
  const campaign = resolveCampaign(
    ctx,
    activeCall?.campaignId ?? stagedCampaignId,
    activeCall?.id
  )
  const policy = campaign?.policy.copilot ?? DEFAULT_COPILOT_POLICY
  if (!campaign || !policy.enabled || policy.mode !== 'delegation') return undefined
  const tools = ctx.toolRegistry.forCampaign(policy)
  return {
    dynamicTools: tools.map(({ spec }) => ({ ...spec })),
    developerInstructions: [
      'You are the executor behind a live phone conversation.',
      'Use only registered dynamic tools. Never use shell or filesystem tools.',
      'When a tool is not needed, do not manufacture an action.',
      policy.mayEndCall && policy.allowedToolIds.includes('end_call')
        ? COPILOT_END_CALL_INSTRUCTION
        : '',
      identityInstruction(campaign.policy.persona),
      policy.prompt.trim()
    ].filter(Boolean).join('\n')
  }
}

function resolveCampaign(
  ctx: MainModuleContext,
  requestedCampaignId: string | undefined,
  callId: string | undefined
): Campaign | undefined {
  const requested = requestedCampaignId
    ? ctx.campaignStore.getCampaign(requestedCampaignId)
    : undefined
  if (requested) return requested

  const workspace = ctx.campaignStore.getWorkspace()
  const fallback = ctx.campaignStore.getCampaign(workspace.selectedCampaignId)
  writeCopilotAudit(ctx, 'copilot.policy.fallback', callId, {
    requestedCampaignId,
    fallbackCampaignId: fallback?.id,
    reason: requestedCampaignId ? 'campaign_not_found' : 'campaign_id_missing'
  })
  return fallback
}

function identityInstruction(persona: string): string {
  const configured = persona.trim()
  return configured
    ? `Use only this configured persona for identity; do not invent another name, organization, or identity: ${configured}`
    : 'Do not invent an organization affiliation, name, or identity. If asked, say you are an automated voice assistant.'
}

function writeCopilotAudit(
  ctx: MainModuleContext,
  action: string,
  callId: string | undefined,
  details: Record<string, unknown>
): void {
  ctx.callStore.getDatabase().prepare(`
    INSERT INTO audit_log (tenant_id, at, actor, action, call_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ctx.callStore.tenantId ?? LOCAL_TENANT_ID, Date.now(), 'copilot', action, callId ?? null, JSON.stringify(details))
}
