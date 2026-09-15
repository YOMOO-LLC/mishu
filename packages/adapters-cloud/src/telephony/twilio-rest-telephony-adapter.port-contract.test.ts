import { FakeClock } from '@mishu/adapters-mock/clock'
import { describeTelephonyPortContract } from '@mishu/adapters-mock/contract-tests'
import { FakeTwilioRest } from '../testing/fake-twilio-rest.js'
import { TwilioRestTelephonyAdapter } from './telephony-port.js'

describeTelephonyPortContract(
  () => new TwilioRestTelephonyAdapter(new FakeTwilioRest(), new FakeClock(0)),
  { capabilities: { concurrentCalls: 'many', ownerKinds: ['client', 'pstn'] } }
)
