import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isLoopbackRequest, type McpTokenStore } from '../../desktop/src/main/mcp/auth.js'
import { HttpApiRouter } from '../../desktop/src/main/http/router.js'
import type { EngineContext } from '../../desktop/src/main/engine-context.js'
import {
  CAPABILITY_UNAVAILABLE_STATUS,
  unavailableBody,
  unavailableFor
} from './unavailable.js'

export interface CloudReadyLine {
  ready: true
  baseUrl: string
  tokenFile: string
}

export interface CloudHttpHost {
  server: Server
  baseUrl: string
  ready: CloudReadyLine
  close(): Promise<void>
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function drain(request: IncomingMessage): void {
  request.resume()
}

export async function listenCloudHttp(options: {
  context: EngineContext
  tokenStore: McpTokenStore
  port?: number
}): Promise<CloudHttpHost> {
  const router = new HttpApiRouter(options.context)
  const tokenStore = options.tokenStore
  const server = createServer((request, response) => {
    void handle(request, response, router, tokenStore, options.context)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo | null
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Headless host did not receive a loopback TCP port')
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  return {
    server,
    baseUrl,
    ready: { ready: true, baseUrl, tokenFile: tokenStore.tokenPath },
    close: () => closeServer(server)
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  router: HttpApiRouter,
  tokenStore: McpTokenStore,
  context: EngineContext
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const method = request.method ?? 'GET'
  if (!pathname.startsWith('/v1/')) {
    drain(request)
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
    return
  }
  if (!isLoopbackRequest(request.headers.host, stringHeader(request.headers.origin))) {
    drain(request)
    context.services.auditHttp(`${method} ${pathname}`, 403, {})
    sendJson(response, 403, { error: { code: 'SCOPE_DENIED', message: 'Forbidden: non-loopback Host or Origin' } })
    return
  }
  if (!tokenStore.authorizeTenant(stringHeader(request.headers.authorization))) {
    drain(request)
    response.setHeader('WWW-Authenticate', 'Bearer')
    context.services.auditHttp(`${method} ${pathname}`, 401, {})
    sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    return
  }
  const blocked = unavailableFor(method, pathname)
  if (blocked) {
    drain(request)
    context.services.auditHttp(`${method} ${pathname}`, CAPABILITY_UNAVAILABLE_STATUS, {})
    sendJson(response, CAPABILITY_UNAVAILABLE_STATUS, unavailableBody(blocked.message))
    return
  }
  const handled = await router.handle(request, response)
  if (!handled) {
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
  })
}
