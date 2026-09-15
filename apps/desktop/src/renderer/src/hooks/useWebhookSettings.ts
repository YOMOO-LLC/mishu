import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WebhookDeliverySummary,
  WebhookPublicConfig,
  WebhookSaveInput
} from '../../../shared/contracts'

export interface UseWebhookSettings {
  config?: WebhookPublicConfig
  deliveries: WebhookDeliverySummary[]
  loading: boolean
  refreshing: boolean
  error: string
  notice: string
  lastRotatedSecret?: string
  saveConfig: (input: WebhookSaveInput) => Promise<void>
  rotateSecret: () => Promise<void>
  sendTest: () => Promise<void>
  refresh: () => Promise<void>
  clearError: () => void
  clearNotice: () => void
}

export interface WebhookFormFields {
  url: string
  enabled: boolean
  events: string[]
}

/**
 * Decide whether the settings form should be (re)initialized from a freshly
 * loaded config. The form hydrates exactly once from the first delivered
 * config, and never overwrites user edits:
 *  - no config yet  -> nothing to apply
 *  - already hydrated -> keep user-owned fields
 *  - user has edited (dirty) -> never clobber, even if the initial load
 *    resolves after the user typed
 */
export function shouldHydrateConfig(
  config: WebhookPublicConfig | undefined,
  hydrated: boolean,
  dirty: boolean
): boolean {
  return Boolean(config) && !hydrated && !dirty
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useWebhookSettings(): UseWebhookSettings {
  const [config, setConfig] = useState<WebhookPublicConfig>()
  const [deliveries, setDeliveries] = useState<WebhookDeliverySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastRotatedSecret, setLastRotatedSecret] = useState<string>()
  const firstLoad = useRef(true)

  const refresh = useCallback(async () => {
    setError('')
    if (firstLoad.current) setLoading(true)
    else setRefreshing(true)
    try {
      const [nextConfig, nextDeliveries] = await Promise.all([
        window.livePhone.getWebhookConfig(),
        window.livePhone.listWebhookDeliveries({ limit: 20 })
      ])
      setConfig(nextConfig)
      setDeliveries(nextDeliveries)
    } catch (loadError) {
      setError(toMessage(loadError))
    } finally {
      firstLoad.current = false
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveConfig = useCallback(async (input: WebhookSaveInput) => {
    setError('')
    setNotice('')
    try {
      const result = await window.livePhone.saveWebhookConfig(input)
      setConfig(result)
      setNotice('Webhook settings saved')
    } catch (saveError) {
      setError(toMessage(saveError))
    }
  }, [])

  const rotateSecret = useCallback(async () => {
    setError('')
    setNotice('')
    try {
      const result = await window.livePhone.rotateWebhookSecret()
      setLastRotatedSecret(result.secret)
      setConfig(result.config)
      setNotice('New secret generated; copy it now (shown only this once)')
    } catch (rotateError) {
      setError(toMessage(rotateError))
    }
  }, [])

  const sendTest = useCallback(async () => {
    setError('')
    setNotice('')
    try {
      const summary = await window.livePhone.sendWebhookTest()
      setNotice(`Test event delivery status: ${summary.status}`)
      await refresh()
    } catch (testError) {
      setError(toMessage(testError))
    }
  }, [refresh])

  return {
    config,
    deliveries,
    loading,
    refreshing,
    error,
    notice,
    lastRotatedSecret,
    saveConfig,
    rotateSecret,
    sendTest,
    refresh,
    clearError: () => setError(''),
    clearNotice: () => setNotice('')
  }
}