import type { CallTask, CallTaskStatus } from '@shared/contracts'
import { useTasks } from './hooks/useTasks'

const STATUS_LABELS: Record<CallTaskStatus, string> = {
  queued: 'Queued', awaiting_approval: 'Awaiting approval', dialing: 'Dialing', in_call: 'On a call',
  analyzing: 'Analyzing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled'
}

export function TasksPanel({ onOpenCall }: { onOpenCall(callId: string): void }): React.JSX.Element {
  const { tasks, loading, error, refresh, cancel } = useTasks()
  return (
    <section className="panel tasks-panel" data-testid="panel-tasks">
      <div className="panel__heading">
        <div><span className="eyebrow">CALL TASKS</span><h2>Tasks</h2></div>
        <button className="secondary" onClick={() => void refresh()}>Refresh</button>
      </div>
      {loading ? <p className="tasks-empty">Loading tasks…</p> : tasks.length === 0 ? (
        <p className="tasks-empty" data-testid="tasks-empty">No call tasks yet. Agents can submit them over HTTP, MCP, or CLI.</p>
      ) : (
        <div className="tasks-list" data-testid="tasks-list">
          {tasks.map((task) => <TaskCard key={task.id} task={task} onCancel={cancel} onOpenCall={onOpenCall} />)}
        </div>
      )}
      {error && <p className="action-error">{error}</p>}
    </section>
  )
}

function TaskCard({ task, onCancel, onOpenCall }: {
  task: CallTask
  onCancel(id: string): Promise<void>
  onOpenCall(callId: string): void
}): React.JSX.Element {
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status)
  return (
    <article className="task-card" data-testid={`task-${task.id}`}>
      <header>
        <div><strong>{task.goal}</strong><small>{task.to}</small></div>
        <span className={`task-status task-status--${task.status}`}>{STATUS_LABELS[task.status]}</span>
      </header>
      <dl>
        <div><dt>Attempts</dt><dd>{task.attempts}/{task.constraints.maxAttempts ?? 1}</dd></div>
        <div><dt>Created</dt><dd>{new Date(task.createdAt).toLocaleString('en-US')}</dd></div>
        {task.outcome && <div><dt>Outcome</dt><dd>{task.outcome}</dd></div>}
      </dl>
      {task.result !== undefined && <pre className="task-result">{JSON.stringify(task.result, null, 2)}</pre>}
      {task.error && <p className="action-error">{task.error}</p>}
      <footer>
        {task.callId && <button className="secondary" onClick={() => onOpenCall(task.callId as string)}>Linked call {task.callId}</button>}
        {!terminal && <button className="secondary" onClick={() => void onCancel(task.id)}>Cancel task</button>}
      </footer>
    </article>
  )
}
