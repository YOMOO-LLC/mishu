import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CallSession,
  CallSummary,
  RecordingInfo,
  TranscriptEntry
} from '../../../shared/contracts'
import { usePhoneController } from './usePhoneController'

const PAGE_SIZE = 20
const REFRESH_AFTER_END_DELAY_MS = 500

export interface CallDetailData {
  session?: CallSession
  transcript: TranscriptEntry[]
  recording?: RecordingInfo
}

export function useCallHistory() {
  const { state } = usePhoneController()
  const [summaries, setSummaries] = useState<CallSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<CallDetailData>({ transcript: [] })
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const previousCallStatus = useRef(state.call?.status)

  const loadPage = useCallback(async (offset: number): Promise<CallSummary[]> => {
    const page = await window.livePhone.listCalls({ limit: PAGE_SIZE, offset })
    setHasMore(page.length === PAGE_SIZE)
    return page
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const page = await loadPage(0)
      setSummaries(page)
    } catch (refreshError) {
      setError(toMessage(refreshError))
    } finally {
      setLoading(false)
    }
  }, [loadPage])

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    setError('')
    try {
      const page = await loadPage(summaries.length)
      setSummaries((current) => [...current, ...page])
    } catch (loadMoreError) {
      setError(toMessage(loadMoreError))
    } finally {
      setLoading(false)
    }
  }, [loading, hasMore, summaries.length, loadPage])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const previous = previousCallStatus.current
    previousCallStatus.current = state.call?.status
    const wasActive =
      previous === 'active' ||
      previous === 'held' ||
      previous === 'ringing' ||
      previous === 'dialing' ||
      previous === 'connecting'
    const settled = state.call?.status === 'ended' || state.call?.status === 'error'
    if (!wasActive || !settled) return
    const timer = window.setTimeout(() => void refresh(), REFRESH_AFTER_END_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [state.call?.status, refresh])

  const selectCall = useCallback(async (id: string) => {
    setSelectedId(id)
    setDetailLoading(true)
    setDetailError('')
    setDetail({ transcript: [] })
    try {
      const [session, transcript, recording] = await Promise.all([
        window.livePhone.getCall(id),
        window.livePhone.getCallTranscript(id),
        window.livePhone.getRecording(id).catch(() => undefined)
      ])
      if (!session) throw new Error('Call does not exist or was deleted')
      setDetail({ session, transcript, recording })
    } catch (selectError) {
      setDetailError(toMessage(selectError))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedId(undefined)
    setDetail({ transcript: [] })
    setDetailError('')
  }, [])

  return {
    summaries,
    loading,
    error,
    hasMore,
    refresh,
    loadMore,
    selectedId,
    detail,
    detailLoading,
    detailError,
    selectCall,
    clearSelection
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}