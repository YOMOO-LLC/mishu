import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC, type PhoneCommandRequest, type PhoneCommandResult, type PhoneStatusSnapshot } from '../shared/contracts.js'
import { PhoneCommandGateway } from './phone-gateway.js'

const READY_STATUS: PhoneStatusSnapshot = {
  runtimeMode: 'mock',
  phoneConnection: 'ready',
  codexConnection: { status: 'ready' },
  controlMode: 'ai',
  selectedCampaignId: 'campaign-1',
  updatedAt: 1
}

class FakeIpcMain extends EventEmitter {}

class FakeWebContents extends EventEmitter {
  destroyed = false
  loading = false
  readonly send = vi.fn<(channel: string, request: PhoneCommandRequest) => void>()
  isDestroyed(): boolean { return this.destroyed }
  isLoadingMainFrame(): boolean { return this.loading }
}

function setup() {
  const ipcMain = new FakeIpcMain()
  const webContents = new FakeWebContents()
  const window = { isDestroyed: () => false, webContents }
  const audit = { writeAudit: vi.fn() }
  const gateway = new PhoneCommandGateway({
    ipcMain: ipcMain as never,
    getWindow: () => window as never,
    audit
  })
  ipcMain.emit(IPC.publishPhoneStatus, { sender: webContents }, READY_STATUS)
  return { ipcMain, webContents, audit, gateway }
}

afterEach(() => vi.useRealTimers())

describe('PhoneCommandGateway', () => {
  it('correlates a renderer response and records the caller actor in audit metadata', async () => {
    const { ipcMain, webContents, audit, gateway } = setup()
    webContents.send.mockImplementation((_channel, request) => {
      const result: PhoneCommandResult = { requestId: request.requestId, ok: true, status: READY_STATUS }
      ipcMain.emit(IPC.respondPhoneCommand, { sender: webContents }, result)
    })

    await expect(gateway.send({ type: 'hangup' }, { actor: 'mcp' })).resolves.toMatchObject({ ok: true })
    expect(webContents.send).toHaveBeenCalledWith(IPC.phoneCommand, expect.objectContaining({ command: { type: 'hangup' } }))
    expect(audit.writeAudit).toHaveBeenCalledWith(
      'mcp',
      'phone.command',
      undefined,
      expect.objectContaining({ command: 'hangup' })
    )
    gateway.dispose()
  })

  it('returns TIMEOUT when the renderer does not respond', async () => {
    vi.useFakeTimers()
    const { gateway } = setup()
    const pending = gateway.send({ type: 'getStatus' }, { actor: 'copilot', timeoutMs: 20 })
    await vi.advanceTimersByTimeAsync(20)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' })
    gateway.dispose()
  })

  it('fails closed when no renderer window exists', async () => {
    const ipcMain = new FakeIpcMain()
    const gateway = new PhoneCommandGateway({
      ipcMain: ipcMain as never,
      getWindow: () => undefined,
      audit: { writeAudit: vi.fn() }
    })
    await expect(gateway.send({ type: 'getStatus' }, { actor: 'mcp' })).resolves.toMatchObject({
      ok: false,
      code: 'APP_NOT_READY'
    })
    expect(() => gateway.getStatus()).toThrowError(expect.objectContaining({ code: 'APP_NOT_READY' }))
    gateway.dispose()
  })

  it('settles every pending command when the renderer reloads', async () => {
    const { webContents, gateway } = setup()
    const first = gateway.send({ type: 'getStatus' }, { actor: 'mcp' })
    const second = gateway.send({ type: 'hangup' }, { actor: 'mcp' })
    webContents.emit('did-start-loading')

    await expect(first).resolves.toMatchObject({ ok: false, code: 'APP_NOT_READY' })
    await expect(second).resolves.toMatchObject({ ok: false, code: 'APP_NOT_READY' })
    expect(() => gateway.getStatus()).toThrowError(expect.objectContaining({ code: 'APP_NOT_READY' }))
    gateway.dispose()
  })

  it('returns the latest renderer status snapshot', () => {
    const { gateway } = setup()
    expect(gateway.getStatus()).toEqual(READY_STATUS)
    gateway.dispose()
  })
})
