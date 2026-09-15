import { useCallback, useEffect, useState } from 'react'
import type { GeneralSettings, GeneralSettingsSaveInput } from '@shared/contracts'

export function useGeneralSettings() {
  const [settings, setSettings] = useState<GeneralSettings>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSettings(await window.livePhone.getGeneralSettings())
    } catch (reason) {
      setError(toMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const update = useCallback(async (input: GeneralSettingsSaveInput) => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      setSettings(await window.livePhone.saveGeneralSettings(input))
      setNotice('General settings saved')
    } catch (reason) {
      setError(toMessage(reason))
      void window.livePhone.getGeneralSettings().then(setSettings).catch(() => undefined)
    } finally {
      setSaving(false)
    }
  }, [])

  return { settings, loading, saving, error, notice, refresh, update }
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
