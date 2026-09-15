import { useCallback, useEffect, useState } from 'react'
import type { CampaignInput, CampaignWorkspace } from '../../../shared/contracts'

export function useCampaigns() {
  const [workspace, setWorkspace] = useState<CampaignWorkspace>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setWorkspace(await window.livePhone.getCampaignWorkspace())
    } catch (loadError) {
      setError(toMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(async (operation: () => Promise<CampaignWorkspace>) => {
    setError('')
    try {
      const next = await operation()
      setWorkspace(next)
      return next
    } catch (operationError) {
      const message = toMessage(operationError)
      setError(message)
      throw operationError
    }
  }, [])

  return {
    workspace,
    loading,
    error,
    clearError: () => setError(''),
    saveCampaign: (campaign: CampaignInput) => run(() => window.livePhone.saveCampaign(campaign)),
    deleteCampaign: (id: string) => run(() => window.livePhone.deleteCampaign(id)),
    selectCampaign: (id: string) => run(() => window.livePhone.selectCampaign(id))
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
