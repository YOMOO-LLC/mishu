import { useEffect, useState } from 'react'
import type { CrmProvider } from '../../../shared/contracts'
import { useCrmSettings } from '../hooks/useCrmSettings'
import { SettingsCard, StatusBadge } from './ui'

const DATA_CENTERS = [
  ['com', 'US (.com)'],
  ['eu', 'EU (.eu)'],
  ['in', 'India (.in)'],
  ['com.au', 'Australia (.com.au)'],
  ['com.cn', 'China (.com.cn)'],
  ['jp', 'Japan (.jp)'],
  ['sa', 'Saudi Arabia (.sa)'],
  ['ca', 'Canada (.ca)']
] as const

export function CrmSection(): React.JSX.Element {
  const { config, syncLog, loading, saving, error, notice, saveAndTest, save, refresh } = useCrmSettings()
  const [provider, setProvider] = useState<CrmProvider>('mock')
  const [dataCenter, setDataCenter] = useState('com')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [grantCode, setGrantCode] = useState('')
  const [postCallSync, setPostCallSync] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    if (!config || hydrated) return
    setProvider(config.provider)
    setDataCenter(config.dataCenter ?? 'com')
    setPostCallSync(config.postCallSync)
    setHydrated(true)
  }, [config, hydrated])

  async function connect(): Promise<void> {
    await saveAndTest({
      provider,
      dataCenter,
      postCallSync,
      ...(provider === 'zoho' ? { clientId, clientSecret, grantCode } : {})
    })
    setGrantCode('')
  }

  async function toggleSync(enabled: boolean): Promise<void> {
    setPostCallSync(enabled)
    await save({ provider, dataCenter, postCallSync: enabled })
  }

  return (
    <SettingsCard className="crm-settings" testId="settings-section-crm" title="CRM integration" description="Mock is the default. Zoho credentials stay in a 0600 file in the main process." badge={<StatusBadge className="crm-status" testId="crm-connection-status" tone={config?.connected ? 'success' : 'neutral'}>{loading ? 'Loading…' : config?.connected ? 'Connected' : 'Not connected'}</StatusBadge>}>

      <div className="crm-form">
        <label className="crm-row">
          <span>Provider</span>
          <select
            data-testid="crm-provider"
            value={provider}
            disabled={loading || saving}
            onChange={(event) => setProvider(event.target.value as CrmProvider)}
          >
            <option value="mock">Mock (local demo)</option>
            <option value="zoho">Zoho CRM</option>
          </select>
        </label>

        {provider === 'zoho' && (
          <div className="crm-zoho-fields" data-testid="crm-zoho-fields">
            <label className="crm-row">
              <span>Data center</span>
              <select data-testid="crm-data-center" value={dataCenter} onChange={(event) => setDataCenter(event.target.value)}>
                {DATA_CENTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="crm-row">
              <span>Client ID</span>
              <input data-testid="crm-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" />
            </label>
            <label className="crm-row">
              <span>Client Secret</span>
              <input data-testid="crm-client-secret" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" />
            </label>
            <label className="crm-row">
              <span>One-time grant code</span>
              <input data-testid="crm-grant-code" type="password" value={grantCode} onChange={(event) => setGrantCode(event.target.value)} autoComplete="off" />
            </label>
          </div>
        )}

        <label className="crm-row crm-row--switch">
          <span>Sync after the call</span>
          <input
            type="checkbox"
            data-testid="crm-post-call-sync"
            checked={postCallSync}
            disabled={loading || saving}
            onChange={(event) => void toggleSync(event.target.checked)}
          />
        </label>

        <button className="settings-button settings-button--primary crm-connect" data-testid="crm-connect" disabled={loading || saving} onClick={() => void connect()}>
          {saving ? 'Connecting…' : provider === 'mock' ? 'Enable Mock' : 'Connect Zoho'}
        </button>
      </div>

      {notice && <p className="settings-notice" data-testid="crm-notice">{notice}</p>}
      {(error || config?.lastError) && <p className="settings-error" data-testid="crm-error">{error || config?.lastError}</p>}

      <div className="crm-sync-log">
        <div className="crm-sync-log__heading">
          <h4>Recent syncs</h4>
          <button className="settings-button settings-button--secondary settings-button--compact" data-testid="crm-refresh" onClick={() => void refresh()}>Refresh</button>
        </div>
        {syncLog.length === 0 ? (
          <p data-testid="crm-sync-empty">No sync records yet</p>
        ) : (
          <ul data-testid="crm-sync-list">
            {syncLog.map((entry) => (
              <li key={entry.id} data-testid={`crm-sync-${entry.id}`}>
                <strong>{statusLabel(entry.status)}</strong>
                <span>{new Date(entry.updatedAt).toLocaleString('en-US')}</span>
                {entry.lastError && <small>{entry.lastError}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  )
}

function statusLabel(status: string): string {
  return ({
    pending: 'Pending',
    processing: 'Syncing',
    succeeded: 'Synced',
    failed: 'Retrying',
    dead: 'Sync failed'
  } as Record<string, string>)[status] ?? status
}
