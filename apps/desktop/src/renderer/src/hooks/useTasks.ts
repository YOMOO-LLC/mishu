import { useCallback, useEffect, useState } from 'react'
import type { CallTask } from '@shared/contracts'

export function useTasks(): {
  tasks: CallTask[]
  loading: boolean
  error: string
  refresh(): Promise<void>
  cancel(id: string): Promise<void>
} {
  const [tasks, setTasks] = useState<CallTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTasks(await window.livePhone.listTasks({ limit: 100 }))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const cancel = useCallback(async (id: string): Promise<void> => {
    try {
      await window.livePhone.cancelTask(id)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [refresh])

  return { tasks, loading, error, refresh, cancel }
}
