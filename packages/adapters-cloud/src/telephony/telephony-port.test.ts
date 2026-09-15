import { describe, expect, it } from 'vitest'
import { FakeClock } from '@mishu/adapters-mock/clock'
import { FakeTwilioRest } from '../testing/fake-twilio-rest.js'
import { TwilioRestTelephonyAdapter } from './telephony-port.js'

describe('TwilioRestTelephonyAdapter hangup', () => {
  it('rejects a blank tenantId on an unknown call instead of returning silently', async () => {
    const adapter = new TwilioRestTelephonyAdapter(new FakeTwilioRest(), new FakeClock(0))
    await expect(adapter.hangup({
      tenantId: '',
      callId: 'unknown-call',
      commandId: 'cmd-hangup-blank',
      reason: 'local_hangup'
    })).rejects.toThrow('tenantId is invalid')
  })
})
