import type { GeneralSettings } from '@shared/contracts'
import { useGeneralSettings } from '../hooks/useGeneralSettings'
import { SettingsCard } from './ui'

export function GeneralSection(): React.JSX.Element {
  const { settings, loading, saving, error, notice, update } = useGeneralSettings()

  function toggle(key: keyof GeneralSettings, checked: boolean): void {
    void update({ [key]: checked })
  }

  return (
    <SettingsCard className="settings-subsection general-settings" testId="settings-section-general" title="General" description="Control what happens when the window closes, at launch, and after sign-in.">
      <div className="general-settings__options" data-testid={loading ? 'general-settings-loading' : 'general-settings-ready'}>
        <label className="webhook-row webhook-row--switch">
          <span>Minimize to tray when closing the window</span>
          <input
            type="checkbox"
            data-testid="general-minimize-to-tray"
            checked={settings?.minimizeToTray ?? true}
            disabled={loading || saving}
            onChange={(event) => toggle('minimizeToTray', event.target.checked)}
          />
        </label>
        <label className="webhook-row webhook-row--switch">
          <span>Start at login</span>
          <input
            type="checkbox"
            data-testid="general-launch-at-login"
            checked={settings?.launchAtLogin ?? false}
            disabled={loading || saving}
            onChange={(event) => toggle('launchAtLogin', event.target.checked)}
          />
        </label>
        <label className="webhook-row webhook-row--switch">
          <span>Stay hidden after launch</span>
          <input
            type="checkbox"
            data-testid="general-start-hidden"
            checked={settings?.startHidden ?? false}
            disabled={loading || saving}
            onChange={(event) => toggle('startHidden', event.target.checked)}
          />
        </label>
      </div>
      <p className="settings-help">Launch at login is supported on macOS and Windows; Linux is not supported yet.</p>
      {notice && <p className="settings-notice" data-testid="general-settings-notice">{notice}</p>}
      {error && <p className="settings-error" data-testid="general-settings-error">{error}</p>}
    </SettingsCard>
  )
}
