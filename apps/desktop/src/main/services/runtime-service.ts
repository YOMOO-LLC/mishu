import type { RuntimeConfig } from '../../shared/contracts.js'
import type { TwilioSettingsService } from './twilio-settings-service.js'

export class RuntimeService {
  constructor(
    private readonly loadTwilioToken: () => Promise<string | undefined>,
    private readonly mockMode: boolean,
    private readonly twilio?: TwilioSettingsService
  ) {}

  async getConfig(): Promise<RuntimeConfig> {
    const mockMode = this.mockMode
    const twilioPhoneNumber = this.twilio?.phoneNumber() ?? process.env.TWILIO_PHONE_NUMBER?.trim()
    const tickRaw = Number(process.env.LIVE_PHONE_GUARDRAIL_TICK_MS)
    const configPath = process.env.LIVE_PHONE_CONFIG_PATH?.trim()
    const codexCommand = process.env.LIVE_PHONE_CODEX_COMMAND?.trim()
    const codexError = process.env.LIVE_PHONE_CODEX_ERROR?.trim()
    return {
      mockMode,
      ...(!mockMode ? { twilioToken: await this.loadTwilioToken() } : {}),
      ...(twilioPhoneNumber ? { twilioPhoneNumber } : {}),
      ...(Number.isFinite(tickRaw) && tickRaw > 0 ? { guardrailTickMs: tickRaw } : {}),
      ...(configPath ? { configPath } : {}),
      ...(codexCommand ? { codexCommand } : {}),
      ...(codexError ? { codexError } : {}),
      ...(mockMode && !(this.twilio?.get().configured)
        ? { runtimeNotice: 'Twilio is not configured; simulation mode is active. Open Settings → Phone line (Twilio).' }
        : {})
    }
  }
}
