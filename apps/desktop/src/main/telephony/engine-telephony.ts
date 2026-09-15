import type { TelephonyPort } from '@mishu/core/ports'
import type {
  PhoneCommand,
  PhoneCommandResult,
  PhoneStatusSnapshot
} from '../../shared/contracts.js'

/**
 * Engine-facing telephony: TelephonyPort plus the snapshot and command
 * dispatch PhoneService / /v1 need (campaign, goal, and actor stay on
 * PhoneCommand so behaviour does not change).
 */
export interface EngineTelephony extends TelephonyPort {
  getStatus(): PhoneStatusSnapshot
  execute(
    command: PhoneCommand,
    options: { actor: string; timeoutMs?: number }
  ): Promise<PhoneCommandResult>
}
