import { CallDetail } from './CallDetail'
import { useCallHistory } from './hooks/useCallHistory'

function formatRowTime(timestamp?: number): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined || milliseconds < 0) return '—'
  const totalSeconds = Math.floor(milliseconds / 1000)
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function statusLabel(status: string): string {
  switch (status) {
    case 'ringing':
      return 'Incoming ring'
    case 'dialing':
      return 'Dialing'
    case 'connecting':
      return 'Connecting'
    case 'active':
      return 'On a call'
    case 'held':
      return 'On hold'
    case 'ended':
      return 'Call ended'
    case 'error':
      return 'Connection failed'
    case 'idle':
      return 'Waiting for calls'
    default:
      return status
  }
}

export function CallHistoryPanel(): React.JSX.Element {
  const {
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
  } = useCallHistory()

  const selectedSession = detail.session

  if (selectedId && selectedSession) {
    return (
      <CallDetail
        session={selectedSession}
        transcript={detail.transcript}
        recording={detail.recording}
        onBack={clearSelection}
      />
    )
  }

  return (
    <section className="panel history-panel" data-testid="panel-history" aria-labelledby="history-title">
      <div className="panel__heading history-panel__heading">
        <div>
          <span className="eyebrow">CALL HISTORY</span>
          <h2 id="history-title">Call history</h2>
        </div>
        <button className="history-panel__refresh" data-testid="history-refresh" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="history-panel__body">
        {detailLoading && selectedId ? (
          <p className="history-panel__status" data-testid="history-detail-loading">Loading call details…</p>
        ) : detailError && selectedId ? (
          <p className="history-panel__status history-panel__status--error" data-testid="history-error">
            {detailError}
            <button onClick={clearSelection}>Back to list</button>
          </p>
        ) : loading ? (
          <p className="history-panel__status" data-testid="history-loading">Loading call history…</p>
        ) : error ? (
          <div className="history-panel__status history-panel__status--error" data-testid="history-error">
            <p>{error}</p>
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        ) : summaries.length === 0 ? (
          <div className="history-panel__empty" data-testid="history-empty">
            <strong>No call history yet</strong>
            <p>Finished calls will appear here.</p>
          </div>
        ) : (
          <>
            <ul className="history-list" data-testid="history-list">
              {summaries.map((call) => (
                <li key={call.id}>
                  <button
                    className="history-row"
                    data-testid="history-row"
                    onClick={() => void selectCall(call.id)}
                  >
                    <span className="history-row__time">{formatRowTime(call.startedAt ?? call.createdAt)}</span>
                    <span className={`history-row__direction history-row__direction--${call.direction}`}>
                      {call.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                    </span>
                    <strong className="history-row__peer">{call.peer}</strong>
                    <span className="history-row__duration">{formatDuration(call.durationMs)}</span>
                    <span className="history-row__campaign">{call.campaignName ?? '—'}</span>
                    <span className={`history-row__status history-row__status--${call.status}`}>
                      {statusLabel(call.status)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {hasMore && (
              <div className="history-panel__more">
                <button data-testid="history-load-more" onClick={() => void loadMore()} disabled={loading}>
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}