import { describe, expect, it, vi } from 'vitest'
import type { PhoneStatusSnapshot } from '../shared/contracts.js'
import {
  TrayController,
  buildTrayMenuTemplate,
  createTrayPauseAction,
  trayStatusLabel,
  type TrayActions
} from './tray.js'

const READY: PhoneStatusSnapshot = {
  runtimeMode: 'mock',
  phoneConnection: 'ready',
  codexConnection: { status: 'ready' },
  controlMode: 'ai',
  updatedAt: 1
}

describe('tray menu', () => {
  it('sets the tray tooltip to Mishu', () => {
    const setToolTip = vi.fn()
    const controller = new TrayController({
      tray: {
        setToolTip,
        setContextMenu: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        destroy: vi.fn()
      },
      buildMenu: (template) => template,
      getState: () => ({ pendingApprovals: 0, paused: false }),
      actions: { showWindow: vi.fn(), setPaused: vi.fn(), quit: vi.fn() },
      refreshIntervalMs: 0
    })
    controller.start()
    expect(setToolTip).toHaveBeenCalledWith('Mishu')
    controller.dispose()
  })

  it('maps idle, call, and approval states to menu labels', () => {
    expect(trayStatusLabel({ phone: READY, pendingApprovals: 0 })).toBe('Idle')
    expect(trayStatusLabel({
      phone: {
        ...READY,
        call: { id: 'call-1', direction: 'inbound', peer: '+13125550198', status: 'ringing' }
      },
      pendingApprovals: 0
    })).toBe('On a call')
    expect(trayStatusLabel({ phone: READY, pendingApprovals: 2 })).toBe('Approvals pending 2')
  })

  it('maps the pause checkbox to the budget kill switch action', () => {
    const saveBudget = vi.fn()
    const writeAudit = vi.fn()
    const actions: TrayActions = {
      showWindow: vi.fn(),
      setPaused: createTrayPauseAction({ saveBudget, writeAudit }),
      quit: vi.fn()
    }
    const menu = buildTrayMenuTemplate({ phone: READY, pendingApprovals: 0, paused: false }, actions)
    const pause = menu.find(({ label }) => label === 'Pause taking tasks')
    expect(pause).toMatchObject({ type: 'checkbox', checked: false })
    pause?.click?.({ checked: true })
    expect(saveBudget).toHaveBeenCalledWith({ killSwitch: true })
    expect(writeAudit).toHaveBeenCalledWith(true)
  })
})
