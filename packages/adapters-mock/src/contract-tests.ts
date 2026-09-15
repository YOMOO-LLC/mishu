/**
 * Reusable port-contract helpers. Other adapter packages import this subpath
 * from tests; T12.18 does not wire those packages itself.
 *
 * API:
 * - describeClockContract(makeClock, options?)
 * - describeTelephonyPortContract(makePort, { capabilities })
 * - describeVoiceSessionPortContract(makePort, { formats, capabilities })
 * - describeTextModelPortContract(makePort, options?)
 */
export { describeClockContract, type ContractClock } from './clock-port-contract.js'
export {
  describeTelephonyPortContract,
  type TelephonyPortContractOptions,
  type TelephonyPortFactory
} from './telephony-port-contract.js'
export {
  describeVoiceSessionPortContract,
  type VoiceSessionPortContractOptions,
  type VoiceSessionPortFactory
} from './voice-session-port-contract.js'
export {
  describeTextModelPortContract,
  type TextModelPortContractOptions,
  type TextModelPortFactory
} from './text-model-port-contract.js'
