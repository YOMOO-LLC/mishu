import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  session,
  Tray,
  type MenuItemConstructorOptions
} from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { url as inspectorUrl } from 'node:inspector'
import {
  CodexAppServerClient,
  CodexAppServerError,
  type CodexNotification
} from './codex/index.js'
import { resolveCodexCommand } from './codex/resolve-command.js'
import {
  configureUserDataPath,
  loadAppEnvironment,
  resolveRuntimeModeState,
  restoreExplicitMockOverride
} from './config/app-environment.js'
import { loadTwilioAccessToken } from './config/twilio-token.js'
import { CampaignStore } from './campaign-store.js'
import { resolveTenantFromCredential } from './tenant.js'
import { CallStore } from './call-store.js'
import { register as registerAppointments, AppointmentStore } from './appointments/index.js'
import { register as registerAnalysis } from './analysis/index.js'
import { register as registerCallControl } from './call-control/index.js'
import { register as registerCopilot } from './copilot/index.js'
import { ToolRegistry } from './copilot/registry.js'
import { register as registerCrm } from './crm/index.js'
import { register as registerContacts } from './contacts/index.js'
import { register as registerMcp } from './mcp/index.js'
import { register as registerTasks } from './tasks/index.js'
import type { MainModuleContext, MainModuleHandle } from './module-context.js'
import { PhoneCommandGateway } from './phone-gateway.js'
import { RecordingWriter } from './recording-writer.js'
import { ApprovalManager } from './mcp/approvals.js'
import { createMainServices, MainServices } from './services/index.js'
import { TwilioSettingsService } from './services/twilio-settings-service.js'
import { ShutdownCoordinator, type ShutdownStep } from './shutdown.js'
import {
  createTrayPauseAction,
  TrayController,
  type TrayMenuItemTemplate
} from './tray.js'
import { WebhookBridge } from './webhook/bridge.js'
import { WebhookConfigStore } from './webhook/config-store.js'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Appointment,
  CallBudgetSaveInput,
  CallLifecycleReport,
  CallSession,
  CallSummary,
  CallTaskSubmitInput,
  CampaignInput,
  CampaignWorkspace,
  GuardrailEvent,
  GeneralSettingsSaveInput,
  ListCallsRequest,
  ListAppointmentsRequest,
  ListCallTasksRequest,
  LivePhoneEvent,
  PhoneCommand,
  PhoneCommandResult,
  RecordChunkRequest,
  RecordFinishRequest,
  RecordingInfo,
  RecordStartRequest,
  RuntimeConfig,
  StartRealtimeRequest,
  StartRealtimeResponse,
  TranscriptEntry,
  TwilioSettingsSaveInput,
  WebhookDeliverySummary,
  WebhookPublicConfig,
  WebhookRotateResult,
  WebhookSaveInput
} from '../shared/contracts.js'
import { IPC, REALTIME_VOICES } from '../shared/contracts.js'
import { maskPhoneNumber } from '../shared/phone-mask.js'
import { CORE_STUB_VERSION } from '@mishu/core'
import { systemClock, systemIdGen } from '@mishu/core/clock'
import { DesktopTelephonyAdapter } from './telephony/desktop-telephony-adapter.js'

const RECORDING_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/

const userDataPath = configureUserDataPath(app)
if (CORE_STUB_VERSION.length < 1) {
  throw new Error('mishu core stub is missing from the main process bundle')
}
const loadedEnvironment = loadAppEnvironment({
  isPackaged: app.isPackaged,
  userDataPath
})
const twilioSettings = new TwilioSettingsService({
  userDataPath,
  env: process.env,
  ...(process.env.LIVE_PHONE_TWILIO_API_BASE_URL ? { apiBaseUrl: process.env.LIVE_PHONE_TWILIO_API_BASE_URL } : {}),
  audit: (action, details) => writeSettingsAudit(action, details),
  callInProgress: () => Boolean(getCallStore().getActiveCallId()),
  relaunch: () => {
    setTimeout(() => {
      restoreExplicitMockOverride(process.env, runtimeMode)
      app.relaunch()
      app.exit(0)
    }, 50)
  }
})
const runtimeMode = resolveRuntimeModeState({ isPackaged: app.isPackaged, settings: twilioSettings })
const mockMode = runtimeMode.mockMode
process.env.LIVE_PHONE_CONFIG_PATH = loadedEnvironment.configPath

const codexResolution = resolveCodexCommand()
if (codexResolution.command) {
  process.env.CODEX_BIN = codexResolution.command
  process.env.LIVE_PHONE_CODEX_COMMAND = codexResolution.command
  delete process.env.LIVE_PHONE_CODEX_ERROR
} else {
  delete process.env.LIVE_PHONE_CODEX_COMMAND
  process.env.LIVE_PHONE_CODEX_ERROR = codexResolution.error
    ?? 'Codex CLI was not found. Install Codex and sign in, or set CODEX_BIN.'
}

if (!process.env.CODEX_WORKDIR?.trim() && app.isPackaged) {
  process.env.CODEX_WORKDIR = join(userDataPath, 'codex-workdir')
}
if (process.env.CODEX_WORKDIR?.trim()) {
  mkdirSync(process.env.CODEX_WORKDIR, { recursive: true })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  console.error('[startup] another Mishu instance already owns this userData directory')
  app.quit()
}

let mainWindow: BrowserWindow | undefined
let codex: CodexAppServerClient | undefined
let campaignStore: CampaignStore | undefined
let callStore: CallStore | undefined
let appointmentStore: AppointmentStore | undefined
let recordingWriter: RecordingWriter | undefined
let webhookBridge: WebhookBridge | undefined
let phoneGateway: PhoneCommandGateway | undefined
let telephonyPort: DesktopTelephonyAdapter | undefined
let services: MainServices | undefined
let approvalManager: ApprovalManager | undefined
let trayController: TrayController<Menu> | undefined
const toolRegistry = new ToolRegistry()
const moduleHandles: MainModuleHandle[] = []
let transcriptSequence = 0
const activeTranscripts = new Map<string, { id: string; text: string }>()
const shutdownCoordinator = new ShutdownCoordinator({
  forceExit: exitImmediately,
  commitExit: exitImmediately,
  onLog: logShutdown,
  onDisposeError: (step, error) => {
    logShutdown(`dispose error step=${JSON.stringify(step)} error=${JSON.stringify(errorMessage(error))}`)
  }
})

function logShutdown(message: string): void {
  console.error(`[shutdown] ${new Date().toISOString()} ${message}`)
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
}

function exitImmediately(): void {
  if (inspectorUrl()) {
    logShutdown('exit method=SIGKILL reason=inspector')
    process.kill(process.pid, 'SIGKILL')
    return
  }
  logShutdown('exit method=app.exit')
  app.exit(0)
}

function sendEvent(event: LivePhoneEvent): void {
  const window = mainWindow
  if (window && !window.isDestroyed()) window.webContents.send(IPC.event, event)
}

function getCodex(): CodexAppServerClient {
  if (codex) return codex
  if (!codexResolution.command) {
    throw new CodexAppServerError(process.env.LIVE_PHONE_CODEX_ERROR ?? 'Codex CLI was not found')
  }
  codex = new CodexAppServerClient({
    command: codexResolution.command,
    cwd: process.env.CODEX_WORKDIR || process.cwd()
  })
  codex.on('notification', handleCodexNotification)
  codex.on('serverRequest', (request) => {
    codex?.rejectServerRequest(request.id, {
      code: -32601,
      message: `Interactive server request is unavailable in phone mode: ${request.method}`
    })
  })
  codex.on('error', (error) => {
    sendEvent({ type: 'error', source: 'codex', message: error.message })
  })
  return codex
}

function getCampaignStore(): CampaignStore {
  const tenantId = resolveTenantFromCredential('ipc').tenantId
  campaignStore ??= new CampaignStore(join(app.getPath('userData'), 'campaigns.sqlite3'), { tenantId })
  return campaignStore
}

function getCallStore(): CallStore {
  const tenantId = resolveTenantFromCredential('ipc').tenantId
  callStore ??= new CallStore(join(app.getPath('userData'), 'calls.sqlite3'), { tenantId })
  return callStore
}

function getAppointmentStore(): AppointmentStore {
  appointmentStore ??= new AppointmentStore(getCallStore())
  return appointmentStore
}

function getRecordingWriter(): RecordingWriter {
  recordingWriter ??= new RecordingWriter(
    getCallStore(),
    join(app.getPath('userData'), 'recordings')
  )
  return recordingWriter
}

function getWebhookBridge(): WebhookBridge {
  webhookBridge ??= new WebhookBridge({
    store: getCallStore(),
    configStore: new WebhookConfigStore(join(app.getPath('userData'), 'webhooks'))
  })
  return webhookBridge
}

function getPhoneGateway(): PhoneCommandGateway {
  phoneGateway ??= new PhoneCommandGateway({
    ipcMain,
    getWindow: () => mainWindow,
    audit: {
      writeAudit(actor, action, callId, details) {
        getCallStore().writeAudit(action, callId, details, actor)
      }
    }
  })
  return phoneGateway
}

function getTelephony(): DesktopTelephonyAdapter {
  telephonyPort ??= new DesktopTelephonyAdapter(getPhoneGateway())
  return telephonyPort
}

function writeSettingsAudit(action: string, details: Record<string, unknown>): void {
  getCallStore().writeAudit(action, getCallStore().getActiveCallId(), details, 'ui')
}

function getServices(): MainServices {
  if (services) return services
  const configuredTimeout = Number(process.env.LIVE_PHONE_APPROVAL_TIMEOUT_MS)
  const approvalTimeoutMs = mockMode
    && Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 60_000
  services = createMainServices({
    userDataPath: app.getPath('userData'),
    isMock: mockMode,
    campaignStore: getCampaignStore(),
    callStore: getCallStore(),
    appointmentStore: getAppointmentStore(),
    recordingWriter: getRecordingWriter(),
    webhookBridge: getWebhookBridge(),
    telephony: getTelephony(),
    clock: systemClock,
    codex: getCodex,
    loadTwilioToken,
    twilioSettings,
    emitVoiceSettings: (settings) => sendEvent({ type: 'voice-settings', settings }),
    emitConnecting: () => sendEvent({ type: 'codex-state', state: { status: 'connecting' } }),
    approvalTimeoutMs,
    platform: process.platform,
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings)
  })
  services.realtime.subscribe((event) => {
    if (event.type === 'transcript') {
      const entry = recordTranscript({ ...event, threadId: event.threadId, role: event.role }, event.final)
      if (entry) sendEvent({ type: 'transcript', entry })
    } else if (event.type === 'started') {
      sendEvent({ type: 'codex-state', state: { status: 'connecting', threadId: event.threadId, sessionId: event.sessionId } })
      if (services?.voice.get().provider === 'gpt-live-api' && event.sessionId) sendEvent({ type: 'voice-session-ready', sessionId: event.sessionId })
    } else if (event.type === 'closed') {
      activeTranscripts.clear()
      sendEvent({ type: 'codex-state', state: { status: 'idle' } })
    } else if (event.type === 'error') {
      sendEvent({ type: 'codex-state', state: { status: 'error', message: event.message } })
      sendEvent({ type: 'error', source: 'codex', message: event.message })
    }
  })
  return services
}

function getApprovalManager(): ApprovalManager {
  approvalManager ??= new ApprovalManager({
    ipcMain,
    getWindow: () => mainWindow,
    service: getServices().approvals
  })
  return approvalManager
}

function buildDesktopContext(): MainModuleContext {
  const engine = {
    callStore: getCallStore(),
    appointmentStore: getAppointmentStore(),
    campaignStore: getCampaignStore(),
    recordingWriter: getRecordingWriter(),
    webhookBridge: getWebhookBridge(),
    toolRegistry,
    telephony: getTelephony(),
    clock: systemClock,
    idGen: systemIdGen,
    tenant: resolveTenantFromCredential('ipc'),
    userDataPath: app.getPath('userData'),
    isMock: mockMode,
    services: getServices(),
    approvals: getApprovalManager()
  }
  return {
    ...engine,
    ipcMain,
    getWindow: () => mainWindow,
    phoneGateway: getPhoneGateway(),
    codex: getCodex
  }
}

function registerModules(): void {
  const context = buildDesktopContext()
  const analysis = registerAnalysis({
    callStore: context.callStore,
    codex: context.codex,
    isMock: context.isMock,
    onAnalyzed: (event) => context.webhookBridge.publishCallAnalyzed(event),
    schedulerIntervalMs: context.isMock ? 50 : 5_000
  })
  moduleHandles.push(
    registerCallControl(context),
    registerCopilot(context),
    registerCrm(context),
    registerAppointments(context),
    registerContacts(context),
    registerMcp(context),
    analysis,
    registerTasks(context, analysis.service)
  )
}

function recordTranscript(
  params: Record<string, unknown>,
  final: boolean
): TranscriptEntry | undefined {
  const threadId = typeof params.threadId === 'string' ? params.threadId : 'unknown'
  const role = params.role === 'assistant' ? 'assistant' : 'caller'
  const key = `${threadId}:${role}`
  let current = activeTranscripts.get(key)
  if (role === 'assistant' && !current && activeCallHasEndRequest()) return undefined
  if (!current) {
    current = { id: `${key}:${transcriptSequence++}`, text: '' }
    activeTranscripts.set(key, current)
  }
  if (final) {
    current.text = typeof params.text === 'string' ? params.text : current.text
  } else if (typeof params.delta === 'string') {
    current.text += params.delta
  }
  const entry: TranscriptEntry = {
    id: current.id,
    speaker: role,
    text: current.text,
    final,
    timestamp: Date.now()
  }
  if (final) activeTranscripts.delete(key)
  try {
    getCallStore().reportTranscriptEntry(entry, 'main')
  } catch (error) {
    sendEvent({
      type: 'error',
      source: 'codex',
      message: error instanceof Error ? error.message : String(error)
    })
  }
  return entry
}

function activeCallHasEndRequest(): boolean {
  const store = getCallStore()
  const callId = store.getActiveCallId()
  if (!callId) return false
  return Boolean(store.getDatabase().prepare(`
    SELECT 1 FROM audit_log
    WHERE call_id = ? AND action = 'copilot.call.end_requested'
    LIMIT 1
  `).get(callId))
}

function handleCodexNotification(notification: CodexNotification): void {
  const params = (notification.params ?? {}) as Record<string, unknown>
  getServices().realtime.codexProvider.notification(notification)
  if (notification.method === 'item/completed') {
    const item = params.item as Record<string, unknown> | undefined
    if (
      item?.type === 'agentMessage' &&
      typeof item.text === 'string' &&
      !activeCallHasEndRequest()
    ) {
      sendEvent({ type: 'assistant-message', text: item.text })
    }
  }
}

async function loadTwilioToken(): Promise<string | undefined> {
  return loadTwilioAccessToken({
    credentials: twilioSettings.credentials(),
    identity: twilioSettings.identity()
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.realtimeStarted, (_event, id: unknown) => getServices().realtime.markStarted(id))
  ipcMain.handle(IPC.voiceSettingsGet, () => getServices().voice.get())
  ipcMain.handle(IPC.voiceSettingsSave, (_event, input) => getServices().voice.save(input))
  ipcMain.handle(IPC.openAiSettingsGet, () => getServices().openai.get())
  ipcMain.handle(IPC.openAiSettingsSave, (_event, input) => getServices().openai.save(input))
  ipcMain.handle(IPC.openAiSettingsTest, () => getServices().openai.test())
  ipcMain.handle(IPC.getRuntimeConfig, () => getServices().runtime.getConfig())
  ipcMain.handle(IPC.getCampaignWorkspace, () => getServices().campaigns.workspace({ reveal: true }))
  ipcMain.handle(IPC.getCampaign, (_event, id: string) => getServices().campaigns.get(id, { reveal: true }))
  ipcMain.handle(IPC.saveCampaign, (_event, campaign: CampaignInput) => getServices().campaigns.create(campaign, { reveal: true }))
  ipcMain.handle(IPC.deleteCampaign, (_event, id: string) => getServices().campaigns.delete(id, { reveal: true }))
  ipcMain.handle(IPC.selectCampaign, (_event, id: string) => getServices().campaigns.select(id, { reveal: true }))
  ipcMain.handle(IPC.startRealtime, (_event, request: StartRealtimeRequest) => getServices().realtime.start(request))
  ipcMain.handle(IPC.appendSpeech, async (_event, text: unknown) => {
    try {
      await getServices().realtime.appendSpeech(text)
    } catch (error) {
      if (error instanceof CodexAppServerError && error.message === 'No realtime session is active') return
      throw error
    }
  })
  ipcMain.handle(IPC.appendText, (_event, text: unknown) => getServices().realtime.appendText(text))
  ipcMain.handle(IPC.stopRealtime, () => getServices().realtime.stop())
  ipcMain.handle(IPC.reportCallLifecycle, (_event, report: CallLifecycleReport) => getServices().reportCall(report))
  ipcMain.handle(IPC.reportTranscriptEntry, (_event, entry: TranscriptEntry) => getServices().reportTranscript(entry))
  ipcMain.handle(IPC.listCalls, (_event, request: ListCallsRequest) => getServices().calls.list(request ?? {}))
  ipcMain.handle(IPC.getCall, (_event, id: string) => getServices().calls.find(id, { reveal: true }))
  ipcMain.handle(IPC.getCallTranscript, (_event, id: string) => getServices().calls.transcript(id, { reveal: true }))
  ipcMain.handle(IPC.submitTask, (_event, input: CallTaskSubmitInput) => getServices().tasks.submit(input, 'ui'))
  ipcMain.handle(IPC.listTasks, (_event, request: ListCallTasksRequest) => getServices().tasks.list(request ?? {}))
  ipcMain.handle(IPC.getTask, (_event, id: string) => getServices().tasks.get(id))
  ipcMain.handle(IPC.waitTask, (_event, id: string, timeoutMs: number) => getServices().tasks.wait(id, timeoutMs))
  ipcMain.handle(IPC.cancelTask, (_event, id: string) => getServices().tasks.cancel(id))
  ipcMain.handle(IPC.budgetGet, () => getServices().budget.get())
  ipcMain.handle(IPC.budgetSave, (_event, input: CallBudgetSaveInput) => getServices().budget.save(input))
  ipcMain.handle(IPC.generalSettingsGet, () => getServices().settings.general.get())
  ipcMain.handle(IPC.generalSettingsSave, (_event, input: GeneralSettingsSaveInput) =>
    getServices().settings.general.save(input))
  ipcMain.handle(IPC.twilioSettingsGet, () => getServices().twilio.get())
  ipcMain.handle(IPC.twilioSettingsSave, (_event, input: TwilioSettingsSaveInput) =>
    getServices().twilio.save(input))
  ipcMain.handle(IPC.twilioSettingsImport, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: app.getPath('home'),
      properties: ['openFile', 'showHiddenFiles']
    })
    const path = result.filePaths[0]
    return result.canceled || !path ? { cancelled: true as const } : getServices().twilio.importEnv(path)
  })
  ipcMain.handle(IPC.twilioSettingsTest, () => getServices().twilio.test())
  ipcMain.handle(IPC.appRelaunch, () => getServices().twilio.relaunch())
  ipcMain.handle(IPC.listAppointments, (_event, request: ListAppointmentsRequest) => getServices().calls.listAppointments(request ?? {}))
  ipcMain.handle(IPC.getCallAppointments, (_event, id: string) => getServices().calls.callAppointments(id, { reveal: true }))
  ipcMain.handle(IPC.recordStart, (_event, request: RecordStartRequest) => getServices().recordings.start(request))
  ipcMain.handle(IPC.recordChunk, (_event, request: RecordChunkRequest) => getServices().recordings.chunk(request))
  ipcMain.handle(IPC.recordFinish, (_event, request: RecordFinishRequest) => getServices().recordings.finish(request))
  ipcMain.handle(IPC.getRecording, (_event, callId: string) => getServices().recordings.get(callId))
  ipcMain.handle(IPC.reportGuardrailEvent, (_event, event: GuardrailEvent) => getServices().reportGuardrail(event))
  ipcMain.handle(IPC.listGuardrailEvents, (_event, callId: unknown) => getServices().calls.guardrails(callId))
  ipcMain.handle(IPC.webhookGetConfig, () => getServices().webhooks.get())
  ipcMain.handle(IPC.webhookSaveConfig, (_event, input: WebhookSaveInput) => getServices().webhooks.save(input))
  ipcMain.handle(IPC.webhookRotateSecret, () => getServices().webhooks.rotate())
  ipcMain.handle(IPC.webhookSendTest, () => getServices().webhooks.test())
  ipcMain.handle(IPC.webhookListDeliveries, (_event, request: { limit?: number }) => getServices().webhooks.deliveries(request?.limit))
  if (mockMode && process.env.NODE_ENV !== 'production') {
    ipcMain.handle(
      IPC.debugPhoneCommand,
      (_event, command: PhoneCommand): Promise<PhoneCommandResult> => getPhoneGateway().send(command, { actor: 'debug' })
    )
    ipcMain.handle(
      IPC.debugApprovalRequest,
      (_event, request: ApprovalRequest): Promise<ApprovalDecision> => getApprovalManager().requestExisting(request)
    )
  }
}

function createWindow(forceShow = false): BrowserWindow {
  const existing = mainWindow
  if (existing && !existing.isDestroyed()) return existing
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0b0d12',
    title: 'Mishu',
    show: false,
    webPreferences: {
      additionalArguments: [`--live-phone-runtime-mode=${mockMode ? 'mock' : 'twilio'}`],
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window
  window.once('ready-to-show', () => {
    if (forceShow || !getServices().settings.general.get().startHidden) window.show()
  })
  window.on('close', (event) => {
    if (shutdownCoordinator.isShuttingDown) return
    shutdownCoordinator.handleWindowClose(
      event,
      getServices().settings.general.get().minimizeToTray,
      () => window.hide()
    )
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

function showMainWindow(): void {
  const window = createWindow(true)
  window.show()
  window.focus()
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources/tray/trayTemplate.png'))
  icon.setTemplateImage(true)
  const tray = new Tray(icon)
  trayController = new TrayController<Menu>({
    tray: {
      setToolTip: (toolTip) => tray.setToolTip(toolTip),
      setContextMenu: (menu) => tray.setContextMenu(menu),
      on: (_event, listener) => tray.on('click', listener),
      removeListener: (_event, listener) => tray.removeListener('click', listener),
      destroy: () => tray.destroy()
    },
    buildMenu: (template: TrayMenuItemTemplate[]) =>
      Menu.buildFromTemplate(template as MenuItemConstructorOptions[]),
    getState: () => {
      let phone
      try { phone = getServices().phone.status() } catch { phone = undefined }
      return {
        ...(phone ? { phone } : {}),
        pendingApprovals: getServices().approvals.listPending().length,
        paused: getServices().budget.get().killSwitch
      }
    },
    actions: {
      showWindow: showMainWindow,
      setPaused: createTrayPauseAction({
        saveBudget: (input) => { getServices().budget.save(input) },
        writeAudit: (paused) => {
          getCallStore().writeAudit(
            paused ? 'tray.tasks.paused' : 'tray.tasks.resumed',
            getCallStore().getActiveCallId(),
            { killSwitch: paused },
            'tray'
          )
        }
      }),
      quit: () => app.quit()
    }
  })
  trayController.start()
}

function registerRecordingProtocol(): void {
  protocol.handle('live-phone-recording', async (request) => {
    const url = new URL(request.url)
    const match = /^\/([^/]+)$/.exec(url.pathname)
    const callId = match?.[1] ?? url.hostname
    if (!callId || !RECORDING_CALL_ID_PATTERN.test(callId)) {
      return new Response('Recording not found', { status: 404 })
    }
    const recording = getCallStore().getRecording(callId)
    if (!recording || recording.status !== 'complete' || !recording.mime) {
      return new Response('Recording not found', { status: 404 })
    }
    const storedPath = getCallStore().getRecordingPath(callId)
    if (!storedPath) {
      return new Response('Recording not found', { status: 404 })
    }
    const writer = getRecordingWriter()
    const root = resolve(writer.getRecordingsPath())
    const candidate = resolve(storedPath)
    if (candidate !== root && !candidate.startsWith(`${root}/`)) {
      return new Response('Recording not found', { status: 404 })
    }
    const fileResponse = await net.fetch(urlToFileUrl(candidate))
    if (!fileResponse.ok) {
      return new Response('Recording not found', { status: 404 })
    }
    return new Response(fileResponse.body, {
      headers: { 'content-type': recording.mime }
    })
  })
}

function urlToFileUrl(filePath: string): string {
  return `file://${encodeURI(filePath)}`
}

if (hasSingleInstanceLock) protocol.registerSchemesAsPrivileged([
  {
    scheme: 'live-phone-recording',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

if (hasSingleInstanceLock) app.on('second-instance', () => {
  console.error('[startup] second instance requested; focusing the existing window')
  showMainWindow()
})

if (hasSingleInstanceLock) void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })
  registerRecordingProtocol()
  getRecordingWriter().initialize()
  getWebhookBridge().startScheduler(5_000)
  registerIpc()
  getPhoneGateway()
  registerModules()
  createWindow()
  createTray()
  app.on('activate', () => {
    showMainWindow()
  })
})

if (hasSingleInstanceLock) app.on('window-all-closed', () => logShutdown('window-all-closed'))

if (hasSingleInstanceLock) app.on('before-quit', (event) => {
  logShutdown('before-quit')
  if (shutdownCoordinator.isShuttingDown) {
    logShutdown('committed quit allowed')
    return
  }
  // Playwright waits for its app.quit() inspector evaluation to return before
  // disconnecting. Deferring the committed quit prevents Node from waiting on
  // that debugger while Playwright is still waiting on the evaluation result.
  event.preventDefault()
  shutdownCoordinator.begin(shutdownSteps())
})

if (hasSingleInstanceLock) app.on('will-quit', () => logShutdown('will-quit'))

if (hasSingleInstanceLock) process.once('exit', (code) => {
  logShutdown(`process exit code=${code}`)
  shutdownCoordinator.cancelDeadline()
})

function shutdownSteps(): ShutdownStep[] {
  const handles = moduleHandles.splice(0)
  return [
    {
      name: 'campaign store',
      dispose: () => {
        const store = campaignStore
        campaignStore = undefined
        store?.close()
      }
    },
    {
      name: 'call store',
      dispose: () => {
        const store = callStore
        callStore = undefined
        appointmentStore = undefined
        store?.close()
      }
    },
    {
      name: 'recording writer',
      dispose: () => {
        const writer = recordingWriter
        recordingWriter = undefined
        writer?.close()
      }
    },
    {
      name: 'webhook bridge',
      dispose: () => {
        const bridge = webhookBridge
        webhookBridge = undefined
        bridge?.close()
      }
    },
    {
      name: 'Codex app-server',
      dispose: () => {
        const client = codex
        codex = undefined
        return client?.dispose()
      }
    },
    {
      name: 'phone gateway',
      dispose: () => {
        const gateway = phoneGateway
        phoneGateway = undefined
        telephonyPort = undefined
        gateway?.dispose()
      }
    },
    {
      name: 'main services',
      dispose: () => {
        const value = services
        services = undefined
        value?.dispose()
      }
    },
    {
      name: 'approval manager',
      dispose: () => {
        const manager = approvalManager
        approvalManager = undefined
        manager?.dispose()
      }
    },
    ...handles.map((handle, index) => ({
      name: `main module ${index + 1}`,
      dispose: () => handle.dispose()
    })),
    {
      name: 'main window',
      dispose: () => {
        const window = mainWindow
        mainWindow = undefined
        if (window && !window.isDestroyed()) window.destroy()
      }
    },
    {
      name: 'tray',
      dispose: () => {
        const controller = trayController
        trayController = undefined
        controller?.dispose()
      }
    }
  ]
}
