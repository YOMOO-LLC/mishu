import { useState } from 'react'
import type { McpScope } from '@shared/contracts'
import { useMcpSettings } from '../hooks/useMcpSettings'
import { SettingsCard, StatusBadge } from './ui'

const SCOPES: Array<{ value: McpScope; label: string }> = [
  { value: 'read', label: 'Read status, Campaigns, and call history' },
  { value: 'manage_campaigns', label: 'Manage Campaigns' },
  { value: 'control_calls', label: 'Control calls (dialing still needs local approval)' },
  { value: 'send_messages', label: 'Send messages (not implemented)' }
]

export function McpSection(): React.JSX.Element {
  const {
    status,
    configs,
    lastRotatedToken,
    applyResult,
    loading,
    busy,
    error,
    setEnabled,
    setScopes,
    rotateToken,
    applyClientConfigs
  } = useMcpSettings()
  const [copied, setCopied] = useState<string>()

  async function copy(label: string, value: string): Promise<void> {
    await navigator.clipboard.writeText(value)
    setCopied(label)
  }

  function toggleScope(scope: McpScope, checked: boolean): void {
    const current = status?.scopes ?? []
    void setScopes(checked ? [...current, scope] : current.filter((item) => item !== scope))
  }

  function confirmApply(): void {
    if (!window.confirm('Existing files will be backed up, then live-phone will be appended to Codex and Claude Desktop configs. Continue?')) return
    void applyClientConfigs()
  }

  return (
    <SettingsCard className="mcp-settings" testId="settings-section-mcp" title="MCP server" description="Listens on loopback only; redacted reads are the default." badge={<StatusBadge tone={status?.running ? 'success' : 'neutral'}>{status?.running ? 'Running' : 'Stopped'}</StatusBadge>} actions={
        <label className="settings-switch settings-switch--compact">
          <span>{status?.enabled ? 'Enabled' : 'Off'}</span>
          <input
            type="checkbox"
            data-testid="mcp-enabled"
            checked={status?.enabled ?? false}
            disabled={loading || busy}
            onChange={(event) => void setEnabled(event.target.checked)}
          />
        </label>
      }>

      <dl className="mcp-status">
        <div><dt>Status</dt><dd data-testid="mcp-running">{status?.running ? 'Running' : 'Stopped'}</dd></div>
        <div><dt>Endpoint</dt><dd><code data-testid="mcp-endpoint">{status?.endpoint ?? 'Generated after enable'}</code></dd></div>
        <div><dt>Token fingerprint</dt><dd><code data-testid="mcp-token-fingerprint">{status?.tokenFingerprint ?? '—'}</code></dd></div>
      </dl>

      <fieldset className="mcp-scopes" disabled={loading || busy}>
        <legend>Permission scopes</legend>
        {SCOPES.map((scope) => (
          <label key={scope.value}>
            <input
              type="checkbox"
              data-testid={`mcp-scope-${scope.value}`}
              checked={status?.scopes.includes(scope.value) ?? false}
              onChange={(event) => toggleScope(scope.value, event.target.checked)}
            />
            <span><code>{scope.value}</code> — {scope.label}</span>
          </label>
        ))}
      </fieldset>

      <div className="mcp-actions">
        <button className="settings-button settings-button--secondary" data-testid="mcp-rotate-token" disabled={loading || busy} onClick={() => void rotateToken()}>
          Rotate token (shown once)
        </button>
      </div>
      {lastRotatedToken ? (
        <div className="mcp-secret" data-testid="mcp-token-preview">
          <strong>New token (copy now; shown only this once)</strong>
          <code>{lastRotatedToken}</code>
        </div>
      ) : null}

      <div className="mcp-configs">
        <ConfigBlock
          title="Codex · ~/.codex/config.toml"
          value={configs?.codexToml ?? ''}
          copied={copied === 'codex'}
          onCopy={() => void copy('codex', configs?.codexToml ?? '')}
        />
        <ConfigBlock
          title="Claude Desktop · claude_desktop_config.json"
          value={configs?.claudeDesktopJson ?? ''}
          copied={copied === 'claude'}
          onCopy={() => void copy('claude', configs?.claudeDesktopJson ?? '')}
          onApply={confirmApply}
          busy={loading || busy}
        />
      </div>
      {applyResult ? (
        <p className="action-success" data-testid="mcp-apply-result">
          {applyResult.results.map((item) => `${item.client}: ${item.action}`).join('; ')}.
          {applyResult.claudeDesktopInstalled
            ? 'Claude Desktop detected; the MCP list has not been verified by hand. Fully restart and check.'
            : 'Claude Desktop was not detected.'}
        </p>
      ) : null}
      {error ? <p className="settings-error" data-testid="mcp-error">{error}</p> : null}
    </SettingsCard>
  )
}

function ConfigBlock(props: {
  title: string
  value: string
  copied: boolean
  onCopy(): void
  onApply?(): void
  busy?: boolean
}): React.JSX.Element {
  return (
    <section className="mcp-config">
      <div>
        <strong>{props.title}</strong>
        <button className="settings-button settings-button--secondary settings-button--compact" disabled={!props.value} onClick={props.onCopy}>{props.copied ? 'Copied' : 'Copy config'}</button>
        {props.onApply ? (
          <button className="settings-button settings-button--secondary settings-button--compact" data-testid="mcp-apply-client-configs" disabled={!props.value || props.busy} onClick={props.onApply}>
            Write local configs
          </button>
        ) : null}
      </div>
      <pre>{props.value || 'Loading…'}</pre>
    </section>
  )
}
