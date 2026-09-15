import { useCallback, useEffect, useState } from 'react'
import type {
  McpClientConfigApplyResult,
  McpClientConfigs,
  McpScope,
  McpServerStatus
} from '@shared/contracts'

export function useMcpSettings() {
  const [status, setStatus] = useState<McpServerStatus>()
  const [configs, setConfigs] = useState<McpClientConfigs>()
  const [lastRotatedToken, setLastRotatedToken] = useState<string>()
  const [applyResult, setApplyResult] = useState<McpClientConfigApplyResult>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [nextStatus, nextConfigs] = await Promise.all([
        window.livePhone.getMcpStatus(),
        window.livePhone.getMcpClientConfigs()
      ])
      setStatus(nextStatus)
      setConfigs(nextConfigs)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const setEnabled = useCallback(async (enabled: boolean) => {
    setStatus((current) => current ? { ...current, enabled } : current)
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await window.livePhone.setMcpEnabled(enabled))
    } catch (reason) {
      void window.livePhone.getMcpStatus().then(setStatus).catch(() => undefined)
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const setScopes = useCallback(async (scopes: McpScope[]) => {
    setStatus((current) => current ? { ...current, scopes } : current)
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await window.livePhone.setMcpScopes(scopes))
    } catch (reason) {
      void window.livePhone.getMcpStatus().then(setStatus).catch(() => undefined)
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const rotateToken = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.livePhone.rotateMcpToken()
      setStatus(result.status)
      setLastRotatedToken(result.token)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const applyClientConfigs = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    setApplyResult(undefined)
    try {
      setApplyResult(await window.livePhone.applyMcpClientConfigs())
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    status,
    configs,
    lastRotatedToken,
    applyResult,
    loading,
    busy,
    error,
    refresh,
    setEnabled,
    setScopes,
    rotateToken,
    applyClientConfigs
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
