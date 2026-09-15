import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { startCloudHost } from '../../apps/cloud/src/host.js'
import { QUICKSTART_PEER, runQuickstart } from './quickstart.js'

const hosts: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
})

describe('examples/quickstart-api', () => {
  it('creates a campaign, places a mock call to +15555550100, approves it, and reads the transcript', async () => {
    const host = await startCloudHost({ port: 0 })
    hosts.push(host)
    const token = readFileSync(host.ready.tokenFile, 'utf8').trim()
    expect(JSON.stringify(host.ready)).not.toContain(token)

    const result = await runQuickstart({
      baseUrl: host.ready.baseUrl,
      token,
      peer: QUICKSTART_PEER,
      requireApproval: true
    })

    expect(result.campaignId).toMatch(/\S/)
    expect(result.approvalId).toMatch(/\S/)
    expect(result.taskId).toMatch(/\S/)
    expect(result.taskStatus).toBe('completed')
    expect(result.callId).toMatch(/\S/)
    expect(result.callStatus).toBe('ended')
    expect(Array.isArray(result.transcript)).toBe(true)
  }, 30_000)
})
