import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { McpScope, McpServerStatus } from '../../shared/contracts.js'
import type { MainModuleContext } from '../module-context.js'
import { HttpApiRouter } from '../http/router.js'
import { McpTokenStore, isLoopbackRequest } from './auth.js'
import type { ApprovalManager } from './approvals.js'
import { createClientConfigs } from './client-configs.js'
import { registerResources } from './resources.js'
import {
  MCP_TOOL_SCOPES,
  TOOL_DESCRIPTIONS,
  TOOL_SCHEMAS,
  McpToolService,
  type McpToolName
} from './tools.js'

const ALL_SCOPES: ReadonlySet<McpScope> = new Set(['read', 'manage_campaigns', 'control_calls', 'send_messages'])
const MAX_BODY_BYTES = 1_048_576
const ENDPOINT_HEALTH_INTERVAL_MS = 30_000

interface PersistedSettings {
  enabled: boolean
  scopes: McpScope[]
}

export class McpServerController {
  readonly tokenStore: McpTokenStore
  readonly toolService: McpToolService
  private readonly settingsPath: string
  private readonly endpointPath: string
  private settings: PersistedSettings
  private httpServer?: HttpServer
  private endpoint?: string
  private endpointHealthTimer?: ReturnType<typeof setInterval>
  private readonly apiRouter: HttpApiRouter
  private readonly detachAdmin: () => void

  constructor(private readonly context: MainModuleContext, approvals: ApprovalManager) {
    this.settingsPath = join(context.userDataPath, 'mcp', 'settings.json')
    this.endpointPath = join(context.userDataPath, 'mcp', 'endpoint.json')
    this.tokenStore = new McpTokenStore(context.userDataPath)
    this.settings = this.loadSettings()
    this.toolService = new McpToolService({
      context,
      approvals,
      getScopes: () => new Set(this.settings.scopes)
    })
    this.detachAdmin = context.services.mcp.attach({
      status: () => this.status(),
      setEnabled: (enabled) => this.setEnabled(enabled),
      setScopes: (scopes) => this.setScopes(scopes),
      rotateToken: () => this.rotateToken(),
      clientConfigs: () => createClientConfigs(context.userDataPath)
    })
    this.apiRouter = new HttpApiRouter(context)
  }

  async initialize(): Promise<void> {
    if (this.settings.enabled) await this.start()
  }

  status(): McpServerStatus {
    this.ensureEndpointFile()
    return {
      enabled: this.settings.enabled,
      running: Boolean(this.httpServer?.listening && this.endpoint),
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      tokenFingerprint: this.tokenStore.fingerprint(),
      scopes: [...this.settings.scopes],
      clients: { codex: false, claudeDesktop: false }
    }
  }

  async setEnabled(enabled: boolean): Promise<McpServerStatus> {
    this.settings.enabled = Boolean(enabled)
    this.saveSettings()
    if (this.settings.enabled) await this.start()
    else await this.stop()
    return this.status()
  }

  setScopes(scopes: McpScope[]): McpServerStatus {
    const normalized = [...new Set(scopes)].filter((scope): scope is McpScope => ALL_SCOPES.has(scope))
    this.settings.scopes = normalized
    this.saveSettings()
    return this.status()
  }

  rotateToken(): { status: McpServerStatus; token: string } {
    const token = this.tokenStore.rotate()
    return { status: this.status(), token }
  }

  async dispose(): Promise<void> {
    this.detachAdmin()
    await this.stop()
  }

  private async start(): Promise<void> {
    if (this.httpServer?.listening) return
    const server = createServer((request, response) => void this.handleRequest(request, response))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('MCP server did not receive a loopback TCP port')
    }
    this.httpServer = server
    this.endpoint = `http://127.0.0.1:${address.port}/mcp`
    this.writeEndpoint()
    this.startEndpointHealthCheck()
  }

  private async stop(): Promise<void> {
    const server = this.httpServer
    this.httpServer = undefined
    this.endpoint = undefined
    if (this.endpointHealthTimer) {
      clearInterval(this.endpointHealthTimer)
      this.endpointHealthTimer = undefined
    }
    rmSync(this.endpointPath, { force: true })
    if (!server) return
    await closeHttpServer(server)
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname !== '/mcp' && !pathname.startsWith('/v1/')) {
      sendJson(response, 404, { error: 'Not found' })
      return
    }
    if (!isLoopbackRequest(request.headers.host, stringHeader(request.headers.origin))) {
      const body = pathname === '/mcp'
        ? mcpHttpError('Forbidden: non-loopback Host or Origin')
        : { error: { code: 'SCOPE_DENIED', message: 'Forbidden: non-loopback Host or Origin' } }
      if (pathname.startsWith('/v1/')) this.context.services.auditHttp(`${request.method ?? 'GET'} ${pathname}`, 403, {})
      sendJson(response, 403, body)
      return
    }
    if (!this.tokenStore.authorizeTenant(stringHeader(request.headers.authorization))) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      const body = pathname === '/mcp'
        ? mcpHttpError('Unauthorized')
        : { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }
      if (pathname.startsWith('/v1/')) this.context.services.auditHttp(`${request.method ?? 'GET'} ${pathname}`, 401, {})
      sendJson(response, 401, body)
      return
    }
    if (pathname.startsWith('/v1/')) {
      await this.apiRouter.handle(request, response)
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, mcpHttpError('Method not allowed'))
      return
    }

    let body: unknown
    try {
      body = await readJson(request)
      const server = this.createProtocolServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      response.once('close', () => {
        void transport.close()
        void server.close()
      })
      await transport.handleRequest(request, response, body)
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, mcpHttpError(error instanceof Error ? error.message : 'Bad request'))
    }
  }

  private createProtocolServer(): McpServer {
    const server = new McpServer({ name: 'mishu', version: '1.0.0' })
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: { description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations },
      callback: (args: Record<string, unknown>) => Promise<CallToolResult>
    ) => void
    for (const name of Object.keys(MCP_TOOL_SCOPES) as McpToolName[]) {
      register(name, {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: TOOL_SCHEMAS[name],
        annotations: toolAnnotations(name)
      }, (args) => this.toolService.invoke(name, args))
    }
    registerResources(server, this.toolService)
    return server
  }

  private loadSettings(): PersistedSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<PersistedSettings>
      const scopes: McpScope[] = Array.isArray(parsed.scopes)
        ? parsed.scopes.filter((scope): scope is McpScope => typeof scope === 'string' && ALL_SCOPES.has(scope as McpScope))
        : ['read']
      return { enabled: parsed.enabled === true, scopes }
    } catch {
      return { enabled: false, scopes: ['read'] }
    }
  }

  private saveSettings(): void {
    atomicJson(this.settingsPath, this.settings)
  }

  private writeEndpoint(): void {
    if (!this.endpoint) return
    atomicJson(this.endpointPath, { endpoint: this.endpoint, tokenPath: this.tokenStore.tokenPath })
  }

  private ensureEndpointFile(): void {
    if (!this.endpoint || !this.httpServer?.listening || existsSync(this.endpointPath)) return
    try {
      this.writeEndpoint()
    } catch {
      console.warn('Failed to restore MCP endpoint discovery file')
    }
  }

  private startEndpointHealthCheck(): void {
    if (this.endpointHealthTimer) clearInterval(this.endpointHealthTimer)
    this.endpointHealthTimer = setInterval(
      () => this.ensureEndpointFile(),
      ENDPOINT_HEALTH_INTERVAL_MS
    )
    this.endpointHealthTimer.unref()
  }
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
    server.closeIdleConnections()
    server.closeAllConnections()
  })
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

function mcpHttpError(message: string): unknown {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null }
}

function toolAnnotations(name: McpToolName): ToolAnnotations {
  const scope = MCP_TOOL_SCOPES[name]
  if (scope === 'read') {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
  return {
    readOnlyHint: false,
    destructiveHint: name === 'campaign_delete' || name === 'call_hangup',
    idempotentHint: name === 'call_dial' || name === 'campaign_select' || name === 'call_hangup',
    openWorldHint: name === 'call_dial'
  }
}
