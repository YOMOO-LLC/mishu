import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC, type ApprovalRequest } from '../../shared/contracts.js'
import { ApprovalManager } from './approvals.js'
import { ApprovalService } from '../services/approval-service.js'

class FakeIpcMain extends EventEmitter {}
class FakeWebContents extends EventEmitter {
  readonly send = vi.fn<(channel: string, request: ApprovalRequest) => void>()
  isDestroyed(): boolean { return false }
}

afterEach(() => vi.useRealTimers())

describe('ApprovalManager', () => {
  it('accepts a decision only from the active renderer', async () => {
    const ipcMain = new FakeIpcMain()
    const webContents = new FakeWebContents()
    const window = {
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      flashFrame: vi.fn(),
      webContents
    }
    const manager = new ApprovalManager({
      ipcMain: ipcMain as never,
      getWindow: () => window as never,
      timeoutMs: 100
    })
    const pending = manager.request({
      kind: 'call_dial', title: 'Dial', summary: 'Dial?', details: {}, requestedBy: 'mcp'
    })
    const request = webContents.send.mock.calls[0]?.[1]
    expect(request).toBeDefined()
    ipcMain.emit(IPC.respondApproval, { sender: webContents }, {
      id: request?.id, approved: true, decidedAt: Date.now()
    })
    await expect(pending).resolves.toMatchObject({ approved: true })
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.flashFrame.mock.calls).toEqual([[true], [false]])
    manager.dispose()
  })

  it('fails closed after the timeout', async () => {
    vi.useFakeTimers()
    const ipcMain = new FakeIpcMain()
    const webContents = new FakeWebContents()
    const window = {
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      flashFrame: vi.fn(),
      webContents
    }
    const manager = new ApprovalManager({
      ipcMain: ipcMain as never,
      getWindow: () => window as never,
      timeoutMs: 10
    })
    const pending = manager.request({
      kind: 'call_dial', title: 'Dial', summary: 'Dial?', details: {}, requestedBy: 'mcp'
    })
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toEqual({ approved: false, code: 'APPROVAL_TIMEOUT' })
    expect(window.flashFrame.mock.calls).toEqual([[true], [false]])
    manager.dispose()
  })

  it('decides through ApprovalService with no window at all', async () => {
    const service = new ApprovalService({ timeoutMs: 1_000 })
    const pending = service.create({
      kind: 'call_dial', title: 'Dial', summary: 'Dial?', details: { peer: '+13125550198' }, requestedBy: 'http'
    })
    expect(service.listPending()).toHaveLength(1)
    expect(service.decide({ id: pending.request.id, approved: true, decidedAt: Date.now() })).toBe(true)
    await expect(pending.outcome).resolves.toMatchObject({ approved: true })
    expect(service.listPending()).toHaveLength(0)
    service.dispose()
  })

  it('does not throw when the desktop presenter has no window', async () => {
    const ipcMain = new FakeIpcMain()
    const manager = new ApprovalManager({
      ipcMain: ipcMain as never,
      getWindow: () => undefined,
      timeoutMs: 1_000
    })
    const pending = manager.create({
      kind: 'call_dial', title: 'Dial', summary: 'Dial?', details: {}, requestedBy: 'http'
    })
    expect(manager.listPending()).toHaveLength(1)
    expect(manager.decide({ id: pending.request.id, approved: false, decidedAt: Date.now() })).toBe(true)
    await expect(pending.outcome).resolves.toMatchObject({ approved: false, code: 'APPROVAL_DENIED' })
    manager.dispose()
  })
})
