import { useEffect, useState } from 'react'
import {
  REALTIME_VOICES,
  type Campaign,
  type CampaignDirection,
  type CampaignInput,
  type CampaignPolicy,
  type RealtimeVoice
} from '@shared/contracts'
import { DEFAULT_COPILOT_POLICY, type CampaignCopilotPolicy } from '@shared/policy'
import { CopilotSection } from './campaign/CopilotSection'

const DIRECTION_LABELS: Record<CampaignDirection, string> = {
  inbound: 'Inbound only',
  outbound: 'Outbound only',
  both: 'Inbound + outbound'
}

interface CampaignPanelProps {
  campaigns: Campaign[]
  selectedCampaignId?: string
  disabled: boolean
  loading: boolean
  error?: string
  twilioPhoneNumber?: string
  onClearError(): void
  onSelect(id: string): Promise<unknown>
  onSave(input: CampaignInput): Promise<unknown>
  onDelete(id: string): Promise<unknown>
}

export function CampaignPanel({
  campaigns,
  selectedCampaignId,
  disabled,
  loading,
  error,
  twilioPhoneNumber,
  onClearError,
  onSelect,
  onSave,
  onDelete
}: CampaignPanelProps): React.JSX.Element {
  const [editing, setEditing] = useState<Campaign | 'new'>()
  const selected = campaigns.find(({ id }) => id === selectedCampaignId)

  return (
    <aside className="campaign-panel panel" aria-labelledby="campaign-title">
      <div className="panel__heading campaign-panel__heading">
        <div>
          <span className="eyebrow">CAMPAIGNS</span>
          <h2 id="campaign-title">Phone campaigns</h2>
        </div>
        <button
          className="campaign-add"
          data-testid="new-campaign-button"
          disabled={disabled}
          onClick={() => {
            onClearError()
            setEditing('new')
          }}
          aria-label="New Campaign"
        >+</button>
      </div>

      <div className="campaign-list" data-testid="campaign-list">
        {loading ? (
          <p className="campaign-placeholder">Loading local Campaigns…</p>
        ) : campaigns.map((campaign) => (
          <div
            className={`campaign-row ${campaign.id === selectedCampaignId ? 'selected' : ''}`}
            key={campaign.id}
          >
            <button
              className="campaign-select"
              data-testid={`campaign-select-${campaign.id}`}
              disabled={disabled}
              onClick={() => void onSelect(campaign.id).catch(() => undefined)}
            >
              <strong>{campaign.name}</strong>
              <span>{DIRECTION_LABELS[campaign.direction]} · {campaign.voice}</span>
            </button>
            <button
              className="campaign-edit"
              data-testid={`campaign-edit-${campaign.id}`}
              disabled={disabled}
              onClick={() => {
                onClearError()
                setEditing(campaign)
              }}
              aria-label={`Edit ${campaign.name}`}
            >•••</button>
          </div>
        ))}
      </div>

      {selected && (
        <div className="campaign-summary" data-testid="selected-campaign-summary">
          <span className="campaign-summary__label">Current campaign goal</span>
          <p>{selected.systemPrompt}</p>
          <div className="campaign-summary__meta">
            <span>Voice {selected.voice}</span>
            <span>{DIRECTION_LABELS[selected.direction]}</span>
          </div>
          {(selected.inboundNumber || selected.outboundCallerId) && (
            <div className="campaign-routes">
              {selected.inboundNumber && <small>Inbound {selected.inboundNumber}</small>}
              {selected.outboundCallerId && <small>Outbound {selected.outboundCallerId}</small>}
            </div>
          )}
        </div>
      )}
      <div className={`twilio-line-summary ${twilioPhoneNumber ? '' : 'missing'}`}>
        <span>TWILIO LINE</span>
        <strong>{twilioPhoneNumber ?? 'TWILIO_PHONE_NUMBER is not set'}</strong>
      </div>
      <p className="campaign-note">Number mappings are saved locally; Twilio cloud routing is not changed automatically.</p>
      {error && <p className="action-error campaign-error">{error}</p>}

      {editing && (
        <CampaignEditor
          campaign={editing === 'new' ? undefined : editing}
          twilioPhoneNumber={twilioPhoneNumber}
          canDelete={campaigns.length > 1}
          onClose={() => {
            onClearError()
            setEditing(undefined)
          }}
          onSave={async (input) => {
            await onSave(input)
            setEditing(undefined)
          }}
          onDelete={async (id) => {
            await onDelete(id)
            setEditing(undefined)
          }}
        />
      )}
    </aside>
  )
}

function CampaignEditor({
  campaign,
  twilioPhoneNumber,
  canDelete,
  onClose,
  onSave,
  onDelete
}: {
  campaign?: Campaign
  twilioPhoneNumber?: string
  canDelete: boolean
  onClose(): void
  onSave(input: CampaignInput): Promise<void>
  onDelete(id: string): Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(campaign?.name ?? '')
  const [direction, setDirection] = useState<CampaignDirection>(campaign?.direction ?? 'both')
  const [systemPrompt, setSystemPrompt] = useState(campaign?.systemPrompt ?? '')
  const [voice, setVoice] = useState<RealtimeVoice>(campaign?.voice ?? 'juniper')
  const [inboundNumber, setInboundNumber] = useState(campaign?.inboundNumber ?? '')
  const [outboundCallerId, setOutboundCallerId] = useState(campaign?.outboundCallerId ?? '')
  const [policyOpen, setPolicyOpen] = useState(false)
  const [forbiddenClaims, setForbiddenClaims] = useState((campaign?.policy.forbiddenClaims ?? []).join('\n'))
  const [forbiddenTopics, setForbiddenTopics] = useState((campaign?.policy.forbiddenTopics ?? []).join('\n'))
  const [allowedTopics, setAllowedTopics] = useState((campaign?.policy.allowedTopics ?? []).join('\n'))
  const [negativePrompt, setNegativePrompt] = useState(campaign?.policy.negativePrompt ?? '')
  const [openingInbound, setOpeningInbound] = useState(campaign?.policy.openingInbound ?? '')
  const [openingOutbound, setOpeningOutbound] = useState(campaign?.policy.openingOutbound ?? '')
  const [recordingDisclosure, setRecordingDisclosure] = useState(campaign?.policy.recordingDisclosure ?? true)
  const [maxCallDurationSec, setMaxCallDurationSec] = useState(String(campaign?.policy.maxCallDurationSec ?? 600))
  const [callingTimeZone, setCallingTimeZone] = useState(campaign?.policy.callingHours.timeZone ?? 'UTC')
  const [callingWindows, setCallingWindows] = useState(
    (campaign?.policy.callingHours.windows ?? []).map(renderWindow).join('\n')
  )
  const [doNotCall, setDoNotCall] = useState((campaign?.policy.doNotCall ?? []).join('\n'))
  const [blockedCallers, setBlockedCallers] = useState((campaign?.policy.blockedCallers ?? []).join('\n'))
  const [copilotPolicy, setCopilotPolicy] = useState<CampaignCopilotPolicy>(() => ({
    ...DEFAULT_COPILOT_POLICY,
    ...campaign?.policy.copilot,
    allowedToolIds: [...(campaign?.policy.copilot?.allowedToolIds ?? [])],
    autoExecuteRisks: [...(campaign?.policy.copilot?.autoExecuteRisks ?? DEFAULT_COPILOT_POLICY.autoExecuteRisks)]
  }))
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setFormError('')
    try {
      const duration = Number(maxCallDurationSec)
      if (!Number.isInteger(duration) || duration < 30 || duration > 3600) {
        throw new Error('Maximum call duration must be between 30 and 3600 seconds')
      }
      const callingHours = parseCallingWindows(callingTimeZone, callingWindows)
      const copilotAllowedToolIds = parseLines(String(
        new FormData(event.currentTarget as HTMLFormElement).get('copilotAllowedToolIds') ?? ''
      ))
      const previous = campaign?.policy
      await onSave({
        ...(campaign ? { id: campaign.id } : {}),
        name,
        direction,
        systemPrompt,
        policy: {
          persona: systemPrompt,
          allowedTopics: parseLines(allowedTopics),
          forbiddenTopics: parseLines(forbiddenTopics),
          forbiddenClaims: parseLines(forbiddenClaims),
          negativePrompt: negativePrompt.trim(),
          recordingDisclosure,
          maxCallDurationSec: duration,
          callingHours,
          doNotCall: parseLines(doNotCall),
          blockedCallers: parseLines(blockedCallers),
          onForbiddenClaim: previous?.onForbiddenClaim ?? 'report',
          copilot: {
            ...(previous?.copilot ?? DEFAULT_COPILOT_POLICY),
            ...copilotPolicy,
            prompt: copilotPolicy.prompt.trim(),
            allowedToolIds: copilotAllowedToolIds
          },
          ...(openingInbound.trim() ? { openingInbound: openingInbound.trim() } : {}),
          ...(openingOutbound.trim() ? { openingOutbound: openingOutbound.trim() } : {})
        },
        voice,
        ...(inboundNumber ? { inboundNumber } : {}),
        ...(outboundCallerId ? { outboundCallerId } : {})
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function remove(): Promise<void> {
    if (!campaign || !window.confirm(`Delete Campaign "${campaign.name}"?`)) return
    setSaving(true)
    setFormError('')
    try {
      await onDelete(campaign.id)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
      setSaving(false)
    }
  }

  return (
    <div className="campaign-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <form className="campaign-editor panel" data-testid="campaign-editor" onSubmit={(event) => void submit(event)}>
        <div className="campaign-editor__header">
          <div>
            <span className="eyebrow">CAMPAIGN SETUP</span>
            <h2>{campaign ? 'Edit Campaign' : 'New Campaign'}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close">×</button>
        </div>

        <label>Name<input data-testid="campaign-name-input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <div className="campaign-editor__row">
          <label>Direction<select data-testid="campaign-direction-select" value={direction} onChange={(event) => setDirection(event.target.value as CampaignDirection)}>
            <option value="both">Inbound + outbound</option><option value="inbound">Inbound only</option><option value="outbound">Outbound only</option>
          </select></label>
          <label>Voice<select data-testid="campaign-voice-select" value={voice} onChange={(event) => setVoice(event.target.value as RealtimeVoice)}>
            {REALTIME_VOICES.map((item) => <option value={item} key={item}>{item}</option>)}
          </select></label>
        </div>
        <label>System prompt<textarea data-testid="campaign-prompt-input" value={systemPrompt} maxLength={8000} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Describe the agent's identity, goal, product facts, talk track limits, and desired outcome" /></label>
        <div className="policy-editor">
          <button
            type="button"
            className="policy-editor__toggle"
            data-testid="policy-toggle"
            onClick={() => setPolicyOpen((open) => !open)}
            aria-expanded={policyOpen}
          >Guardrails <span className="policy-editor__caret">{policyOpen ? '▲' : '▼'}</span></button>
          {policyOpen && (
            <div className="policy-editor__body" data-testid="policy-editor-body">
              <label>Forbidden claims (one per line)<textarea data-testid="policy-forbidden-claims" value={forbiddenClaims} onChange={(event) => setForbiddenClaims(event.target.value)} placeholder="e.g. guaranteed refund" /></label>
              <label>Forbidden topics (one per line)<textarea data-testid="policy-forbidden-topics" value={forbiddenTopics} onChange={(event) => setForbiddenTopics(event.target.value)} /></label>
              <label>Allowed topics (one per line)<textarea data-testid="policy-allowed-topics" value={allowedTopics} onChange={(event) => setAllowedTopics(event.target.value)} /></label>
              <label>Negative prompt (other things not to do)<textarea data-testid="policy-negative-prompt" value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} /></label>
              <div className="campaign-editor__row">
                <label>Inbound opening<textarea data-testid="policy-opening-inbound" value={openingInbound} onChange={(event) => setOpeningInbound(event.target.value)} /></label>
                <label>Outbound opening<textarea data-testid="policy-opening-outbound" value={openingOutbound} onChange={(event) => setOpeningOutbound(event.target.value)} /></label>
              </div>
              <div className="campaign-editor__row">
                <label>Recording disclosure
                  <button
                    type="button"
                    className="policy-toggle-button"
                    data-testid="policy-recording-disclosure"
                    aria-pressed={recordingDisclosure}
                    onClick={() => setRecordingDisclosure((value) => !value)}
                  >{recordingDisclosure ? 'On' : 'Off'}</button>
                </label>
                <label>Max call length (seconds, 30-3600)<input data-testid="policy-max-duration" type="number" min={30} max={3600} value={maxCallDurationSec} onChange={(event) => setMaxCallDurationSec(event.target.value)} /></label>
              </div>
              <div className="campaign-editor__row">
                <label>Time zone<input data-testid="policy-timezone" value={callingTimeZone} onChange={(event) => setCallingTimeZone(event.target.value)} placeholder="Asia/Shanghai" /></label>
                <label>Calling windows (one per line, e.g. 1-5 09:00-18:00)<textarea data-testid="policy-calling-windows" value={callingWindows} onChange={(event) => setCallingWindows(event.target.value)} /></label>
              </div>
              <label>DNC list (one E.164 number per line)<textarea data-testid="policy-do-not-call" value={doNotCall} onChange={(event) => setDoNotCall(event.target.value)} /></label>
              <label>Blocked callers (one E.164 number per line)<textarea data-testid="policy-blocked-callers" value={blockedCallers} onChange={(event) => setBlockedCallers(event.target.value)} /></label>
            </div>
          )}
        </div>
        <CopilotSection
          value={copilotPolicy}
          onChange={setCopilotPolicy}
        />
        <div className={`twilio-line-picker ${twilioPhoneNumber ? '' : 'missing'}`} data-testid="twilio-line-picker">
          <div>
            <span>Current Twilio number</span>
            <strong>{twilioPhoneNumber ?? 'No number detected'}</strong>
          </div>
          {twilioPhoneNumber && (
            <div>
              <button type="button" onClick={() => setInboundNumber(twilioPhoneNumber)}>Use for inbound</button>
              <button type="button" onClick={() => setOutboundCallerId(twilioPhoneNumber)}>Use for outbound</button>
              <button type="button" onClick={() => {
                setInboundNumber(twilioPhoneNumber)
                setOutboundCallerId(twilioPhoneNumber)
              }}>Use for both</button>
            </div>
          )}
        </div>
        <div className="campaign-editor__row">
          <label>Inbound number <small>optional</small><input data-testid="campaign-inbound-number" value={inboundNumber} onChange={(event) => setInboundNumber(event.target.value)} placeholder={twilioPhoneNumber ?? '+13125550198'} /></label>
          <label>Outbound number <small>optional</small><input data-testid="campaign-outbound-number" value={outboundCallerId} onChange={(event) => setOutboundCallerId(event.target.value)} placeholder={twilioPhoneNumber ?? '+13125550198'} /></label>
        </div>
        <p className="campaign-editor__hint">Numbers use E.164. This version only saves mappings and does not write Twilio routing.</p>
        {formError && <p className="action-error" data-testid="campaign-form-error">{formError}</p>}
        <div className="campaign-editor__actions">
          {campaign && <button className="danger" type="button" disabled={!canDelete || saving} onClick={() => void remove()}>Delete</button>}
          <span />
          <button type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="primary" data-testid="save-campaign-button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save and select'}</button>
        </div>
      </form>
    </div>
  )
}

function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function renderWindow(window: { days: number[]; start: string; end: string }): string {
  const days = window.days
    .map((day) => String(day))
    .sort()
    .join(',')
  return `${days} ${window.start}-${window.end}`
}

function parseCallingWindows(
  timeZone: string,
  value: string
): { timeZone: string; windows: Array<{ days: number[]; start: string; end: string }> } {
  const zone = timeZone.trim() || 'UTC'
  const windows = parseLines(value).map((line) => {
    const match = /^([0-6](?:,[0-6])*)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(line)
    if (!match) {
      throw new Error(`Calling window format is invalid: ${line} (use 1-5 or 1,3,5 + 09:00-18:00, weekday 0=Sunday)`)
    }
    const days = match[1].split(',').map((day) => Number(day))
    return { days, start: match[2], end: match[3] }
  })
  return { timeZone: zone, windows }
}
