import { describe, expect, it } from 'vitest'
import { api, apiOk, fakeE164, hangupQuietly, uniqueKey } from './helpers/http.js'
import { poll } from './helpers/poll.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'
import { TASK_TRANSITIONS, TERMINAL_TASK_STATUSES, type TaskStatus } from './helpers/types.js'

interface Task {
  id?: string
  taskId?: string
  to: string
  goal: string
  status: TaskStatus
  idempotencyKey: string
  attempts: number
  callId?: string
  outcome?: string
  createdAt: number
  updatedAt: number
}

function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return
  if (!TASK_TRANSITIONS[from].has(to)) {
    throw new Error(`illegal task transition ${from} -> ${to}`)
  }
}

describe('tasks (ADR-0001 I9, HTTP 202 semantics)', () => {
  it('I9: mock task submit returns 202 + id and reaches a terminal status without going backwards', async () => {
    await hangupQuietly()
    const to = fakeE164()
    const submitted = await apiOk<{ taskId: string; status: TaskStatus }>('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        to,
        goal: 'Confirm attendance for the contract suite',
        idempotencyKey: uniqueKey('task-submit')
      })
    })
    expect(submitted.status).toBe(202)
    expect(typeof submitted.body.taskId).toBe('string')
    expect(submitted.body.taskId.length).toBeGreaterThan(0)
    expect(['queued', 'awaiting_approval', 'dialing']).toContain(submitted.body.status)

    const seen: TaskStatus[] = [submitted.body.status]
    const finished = await poll(
      async () => {
        const current = await apiOk<Task>(`/tasks/${submitted.body.taskId}`)
        const status = current.body.status
        const previous = seen[seen.length - 1]
        if (previous) assertTransition(previous, status)
        if (seen[seen.length - 1] !== status) seen.push(status)
        return current.body
      },
      (task) => TERMINAL_TASK_STATUSES.has(task.status),
      { timeoutMs: 25_000, label: `task ${submitted.body.taskId} terminal` }
    )

    expect(TERMINAL_TASK_STATUSES.has(finished.status)).toBe(true)
    expect(finished.status).toBe('completed')
    expect(finished.outcome).toBeTruthy()
    expect(finished.to).toContain('*')
    expect(finished.to).not.toBe(to)
    if (finished.callId) expect(typeof finished.callId).toBe('string')

    const replay = await apiOk<Task>(`/tasks/${submitted.body.taskId}`)
    expect(replay.body.status).toBe(finished.status)
    expect(TERMINAL_TASK_STATUSES.has(replay.body.status)).toBe(true)

    const waited = await apiOk<Task>(`/tasks/${submitted.body.taskId}/wait?timeoutMs=2000`)
    expect(waited.body.status).toBe(finished.status)

    assertNoSecretLeaks(finished, 'task-final')
    await hangupQuietly()
  })
})
