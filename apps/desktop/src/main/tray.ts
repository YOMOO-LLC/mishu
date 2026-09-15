import type { PhoneStatusSnapshot } from '../shared/contracts.js'

export interface TrayMenuItemTemplate {
  type?: 'separator' | 'checkbox'
  label?: string
  enabled?: boolean
  checked?: boolean
  click?(menuItem: { checked: boolean }): void
}

export interface TrayState {
  phone?: PhoneStatusSnapshot
  pendingApprovals: number
  paused: boolean
}

export interface TrayActions {
  showWindow(): void
  setPaused(paused: boolean): void
  quit(): void
}

export interface TraySurface<TMenu> {
  setToolTip(toolTip: string): void
  setContextMenu(menu: TMenu): void
  on(event: 'click', listener: () => void): void
  removeListener(event: 'click', listener: () => void): void
  destroy(): void
}

export interface TrayControllerOptions<TMenu> {
  tray: TraySurface<TMenu>
  buildMenu(template: TrayMenuItemTemplate[]): TMenu
  getState(): TrayState
  actions: TrayActions
  refreshIntervalMs?: number
}

export function createTrayPauseAction(options: {
  saveBudget(input: { killSwitch: boolean }): void
  writeAudit(paused: boolean): void
}): (paused: boolean) => void {
  return (paused) => {
    options.saveBudget({ killSwitch: paused })
    options.writeAudit(paused)
  }
}

export function trayStatusLabel(state: Pick<TrayState, 'phone' | 'pendingApprovals'>): string {
  if (state.pendingApprovals > 0) return `Approvals pending ${state.pendingApprovals}`
  const callStatus = state.phone?.call?.status
  return callStatus && !['idle', 'ended', 'error'].includes(callStatus) ? 'On a call' : 'Idle'
}

export function buildTrayMenuTemplate(
  state: TrayState,
  actions: TrayActions
): TrayMenuItemTemplate[] {
  return [
    { label: 'Show window', click: () => actions.showWindow() },
    { type: 'separator' },
    { label: `Status: ${trayStatusLabel(state)}`, enabled: false },
    {
      label: 'Pause taking tasks',
      type: 'checkbox',
      checked: state.paused,
      click: (item) => actions.setPaused(item.checked)
    },
    { type: 'separator' },
    { label: 'Quit', click: () => actions.quit() }
  ]
}

export class TrayController<TMenu> {
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly options: TrayControllerOptions<TMenu>) {}

  start(): void {
    this.options.tray.setToolTip('Mishu')
    this.options.tray.on('click', this.showWindow)
    this.refresh()
    const interval = this.options.refreshIntervalMs ?? 1_000
    if (interval > 0) {
      this.timer = setInterval(() => this.refresh(), interval)
      this.timer.unref?.()
    }
  }

  refresh(): void {
    this.options.tray.setContextMenu(this.options.buildMenu(
      buildTrayMenuTemplate(this.options.getState(), {
        ...this.options.actions,
        setPaused: (paused) => {
          this.options.actions.setPaused(paused)
          this.refresh()
        }
      })
    ))
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.options.tray.removeListener('click', this.showWindow)
    this.options.tray.destroy()
  }

  private readonly showWindow = (): void => this.options.actions.showWindow()
}
