import type { Clock, IdGen } from '@mishu/core/clock'
import type { TextModelPort } from '@mishu/core/ports'
import type { AppointmentStore } from './appointments/store.js'
import type { CallStore } from './call-store.js'
import type { CampaignStore } from './campaign-store.js'
import type { ToolRegistry } from './copilot/registry.js'
import type { RecordingWriter } from './recording-writer.js'
import type { ApprovalDecider } from './services/approval-service.js'
import type { MainServices } from './services/index.js'
import type { TenantContext } from './tenant.js'
import type { EngineTelephony } from './telephony/engine-telephony.js'
import type { WebhookBridge } from './webhook/bridge.js'

/**
 * Host-agnostic engine surface. Desktop and a future headless host assemble
 * the same stores and services; Electron ipcMain/getWindow stay off this type.
 */
export interface EngineContext {
  callStore: CallStore
  appointmentStore: AppointmentStore
  campaignStore: CampaignStore
  recordingWriter: RecordingWriter
  webhookBridge: WebhookBridge
  toolRegistry: ToolRegistry
  telephony: EngineTelephony
  approvals: ApprovalDecider
  clock: Clock
  idGen: IdGen
  tenant: TenantContext
  userDataPath: string
  isMock: boolean
  services: MainServices
  textModel?: TextModelPort
}
