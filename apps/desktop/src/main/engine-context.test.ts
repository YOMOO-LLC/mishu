import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Clock, IdGen } from '@mishu/core/clock'
import type { EngineContext } from './engine-context.js'
import type { ApprovalDecider } from './services/approval-service.js'
import { ApprovalService } from './services/approval-service.js'
import type { EngineTelephony } from './telephony/engine-telephony.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('EngineContext', () => {
  it('does not import electron', () => {
    const source = readFileSync(join(here, 'engine-context.ts'), 'utf8')
    expect(source).not.toMatch(/from ['"]electron['"]/)
    expect(source).not.toMatch(/from ['"]electron\//)
  })

  it('treats ApprovalService as the approval decision interface', () => {
    const decider: ApprovalDecider = new ApprovalService({ timeoutMs: 50 })
    expect(decider.listPending()).toEqual([])
    decider.dispose()
  })

  it('requires host-agnostic ports and clock on the engine surface', () => {
    const telephony: EngineTelephony = {
      capabilities: () => ({ concurrentCalls: 'single', ownerKinds: ['local_takeover'] }),
      dial: async () => undefined,
      answer: async () => undefined,
      reject: async () => undefined,
      hangup: async () => undefined,
      transferToOwner: async () => undefined,
      subscribe: () => () => undefined,
      getStatus: () => ({
        runtimeMode: 'mock',
        phoneConnection: 'ready',
        codexConnection: { status: 'ready' },
        controlMode: 'ai',
        updatedAt: 0
      }),
      execute: async () => ({
        requestId: 'r',
        ok: false,
        code: 'APP_NOT_READY',
        message: 'unused'
      })
    }
    const clock: Clock = {
      now: () => 0,
      setTimeout: (fn) => { fn(); return 0 },
      clearTimeout: () => undefined
    }
    const idGen: IdGen = { id: () => 'id-1' }
    const approvals: ApprovalDecider = new ApprovalService({ timeoutMs: 50 })
    const context = {
      telephony,
      approvals,
      clock,
      idGen,
      tenant: { tenantId: 'local' },
      userDataPath: '/tmp',
      isMock: true
    }
    const engine: Pick<EngineContext, 'telephony' | 'approvals' | 'clock' | 'idGen' | 'tenant' | 'userDataPath' | 'isMock'> = context
    expect(engine.telephony.capabilities({ tenantId: 'local' }).concurrentCalls).toBe('single')
    expect(engine.tenant.tenantId).toBe('local')
    approvals.dispose()
  })
})
