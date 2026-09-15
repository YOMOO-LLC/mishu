import { useEffect, useState } from 'react'
import type { CampaignCopilotPolicy } from '@shared/policy'

interface CopilotSectionProps {
  value: CampaignCopilotPolicy
  onChange(value: CampaignCopilotPolicy): void
}

export function CopilotSection({
  value,
  onChange
}: CopilotSectionProps): React.JSX.Element {
  const [allowedToolsText, setAllowedToolsText] = useState(() => value.allowedToolIds.join('\n'))
  const update = (patch: Partial<CampaignCopilotPolicy>): void => onChange({ ...value, ...patch })

  useEffect(() => {
    setAllowedToolsText(value.allowedToolIds.join('\n'))
  }, [value.allowedToolIds])

  function commitAllowedTools(): void {
    update({
      allowedToolIds: allowedToolsText
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    })
  }

  return (
    <details className="policy-editor" data-testid="copilot-section">
      <summary className="policy-editor__toggle">Copilot</summary>
      <div className="policy-editor__body copilot-editor">
        <label className="copilot-check copilot-check--enabled">
          <input
            type="checkbox"
            data-testid="copilot-enabled"
            checked={value.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          <span>Enable copilot</span>
        </label>
        <label className="copilot-field">
          Trigger mode
          <select
            data-testid="copilot-mode"
            value={value.mode}
            onChange={(event) => update({ mode: event.target.value as CampaignCopilotPolicy['mode'] })}
          >
            <option value="transcript">Transcript sidecar thread (recommended)</option>
            <option value="delegation">Native realtime delegation</option>
          </select>
        </label>
        <label className="copilot-field">
          Copilot prompt
          <textarea
            data-testid="copilot-prompt"
            value={value.prompt}
            maxLength={8000}
            onChange={(event) => update({ prompt: event.target.value })}
          />
        </label>
        <label className="copilot-field">
          Tool allowlist (one toolId per line)
          <textarea
            data-testid="copilot-tools"
            name="copilotAllowedToolIds"
            value={allowedToolsText}
            onChange={(event) => setAllowedToolsText(event.target.value)}
            onBlur={commitAllowedTools}
            placeholder={'lookup_customer\nappointments_make'}
          />
        </label>
        <fieldset className="copilot-risks">
          <legend>May run without approval</legend>
          <div className="copilot-risks__options">
            {(['read', 'draft-write'] as const).map((risk) => (
              <label className="copilot-check" key={risk}>
                <input
                  type="checkbox"
                  data-testid={`copilot-risk-${risk}`}
                  checked={value.autoExecuteRisks.includes(risk)}
                  onChange={(event) => update({
                    autoExecuteRisks: event.target.checked
                      ? [...new Set([...value.autoExecuteRisks, risk])]
                      : value.autoExecuteRisks.filter((item) => item !== risk)
                  })}
                />
                <span>{risk === 'read' ? 'Read-only tools' : 'Draft writes only'}</span>
              </label>
            ))}
          </div>
          <small>external-write always requires local approval.</small>
        </fieldset>
        <label className="copilot-field">
          Max tool calls per turn
          <input
            type="number"
            min={1}
            max={10}
            data-testid="copilot-max-tool-calls"
            value={value.maxToolCallsPerTurn}
            onChange={(event) => update({ maxToolCallsPerTurn: Number(event.target.value) })}
          />
          <small>1–10 per turn</small>
        </label>
      </div>
    </details>
  )
}
