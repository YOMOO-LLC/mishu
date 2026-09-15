#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

/** Private-build userData folder name. Snapshot export rewrites the value to mishu. */
const APP_USER_DATA_DIR_NAME = 'mishu'

const userDataPath = process.env.LIVE_PHONE_USER_DATA_PATH || defaultUserDataPath()
const endpointPath = join(userDataPath, 'mcp', 'endpoint.json')

async function main() {
  let endpointConfig
  let token
  try {
    endpointConfig = JSON.parse(await readFile(endpointPath, 'utf8'))
    token = (await readFile(endpointConfig.tokenPath, 'utf8')).trim()
    if (!endpointConfig.endpoint || !token) throw new Error('endpoint metadata is incomplete')
  } catch (error) {
    fatal(`Mishu MCP is unavailable. Start the desktop app and enable MCP in Settings. (${error.message})`)
    return
  }

  const stdio = new StdioServerTransport()
  const http = new StreamableHTTPClientTransport(new URL(endpointConfig.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await Promise.allSettled([stdio.close(), http.close()])
  }

  stdio.onmessage = (message) => {
    void http.send(message).catch((error) => fatal(`Mishu MCP request failed: ${error.message}`))
  }
  http.onmessage = (message) => {
    void stdio.send(message).catch((error) => fatal(`Mishu MCP stdio failed: ${error.message}`))
  }
  stdio.onerror = (error) => fatal(`Mishu MCP stdio failed: ${error.message}`)
  http.onerror = (error) => {
    if (!String(error.message).includes('405')) process.stderr.write(`Mishu MCP transport warning: ${error.message}\n`)
  }
  stdio.onclose = () => void close()
  http.onclose = () => void close()

  await http.start()
  await stdio.start()
}

function defaultUserDataPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_USER_DATA_DIR_NAME)
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_USER_DATA_DIR_NAME)
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_USER_DATA_DIR_NAME)
}

function fatal(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  setTimeout(() => process.exit(1), 10).unref()
}

main().catch((error) => fatal(`Mishu MCP shim failed: ${error.message}`))
