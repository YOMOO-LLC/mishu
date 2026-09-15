import { useEffect, useState } from 'react'

import type { CopilotStatus } from '@shared/contracts'

const INITIAL_STATUS: CopilotStatus = { enabled: false, state: 'idle' }

export function useCopilotStatus(): CopilotStatus {
  const [status, setStatus] = useState<CopilotStatus>(INITIAL_STATUS)

  useEffect(() => window.livePhone.onEvent((event) => {
    if (event.type === 'copilot-status') setStatus(event.status)
  }), [])

  return status
}
