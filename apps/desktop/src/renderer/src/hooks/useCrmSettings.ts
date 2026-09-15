import { useCallback, useEffect, useState } from 'react'
import type { CrmPublicConfig, CrmSaveInput } from '../../../shared/contracts'

export interface CrmSyncLogEntry {
  id: number
  callId: string
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead'
  attempts: number
  createdAt: number
  updatedAt: number
  lastError?: string
}

export function useCrmSettings(): {
  config?: CrmPublicConfig
  syncLog: CrmSyncLogEntry[]
  loading: boolean
  saving: boolean
  error: string
  notice: string
  saveAndTest: (input: CrmSaveInput) => Promise<void>
  save: (input: CrmSaveInput) => Promise<void>
  refresh: () => Promise<void>
} {
  const [config, setConfig] = useState<CrmPublicConfig>()
  const [syncLog, setSyncLog] = useState<CrmSyncLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextLog] = await Promise.all([
        window.livePhone.getCrmConfig(),
        window.livePhone.listCrmSyncLog({ limit: 20 })
      ])
      setConfig(nextConfig)
      setSyncLog(nextLog as CrmSyncLogEntry[])
    } catch (loadError) {
      setError(toMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(async (input: CrmSaveInput) => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const next = await window.livePhone.saveCrmConfig(input)
      setConfig(next)
      setNotice('CRM settings saved')
    } catch (saveError) {
      setError(toMessage(saveError))
    } finally {
      setSaving(false)
    }
  }, [])

  const saveAndTest = useCallback(async (input: CrmSaveInput) => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await window.livePhone.saveCrmConfig(input)
      const result = await window.livePhone.testCrmConnection()
      await refresh()
      if (!result.ok) throw new Error(result.error ?? 'CRM connection failed')
      setNotice('CRM connected')
    } catch (connectionError) {
      setError(toMessage(connectionError))
      await refresh()
    } finally {
      setSaving(false)
    }
  }, [refresh])

  return { config, syncLog, loading, saving, error, notice, saveAndTest, save, refresh }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
