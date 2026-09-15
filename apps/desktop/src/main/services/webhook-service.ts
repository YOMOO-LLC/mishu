import type {
  WebhookDeliverySummary,
  WebhookPublicConfig,
  WebhookRotateResult,
  WebhookSaveInput
} from '../../shared/contracts.js'
import type { WebhookBridge } from '../webhook/bridge.js'

export class WebhookService {
  constructor(private readonly bridge: WebhookBridge) {}

  get(): WebhookPublicConfig { return this.bridge.getPublicConfig() }
  save(input: WebhookSaveInput): WebhookPublicConfig & { secret?: string } { return this.bridge.saveConfig(input) }
  rotate(): WebhookRotateResult { return this.bridge.rotateSecret() }
  test(): Promise<WebhookDeliverySummary> { return this.bridge.sendTest() }
  deliveries(limit?: number): WebhookDeliverySummary[] { return this.bridge.listDeliveries(limit) }
}
