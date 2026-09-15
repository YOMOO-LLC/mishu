import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  McpClientConfigApplyResult,
  McpClientConfigTargetResult,
  McpClientConfigs
} from '../../shared/contracts.js'

const CONFIG_NAME = 'live-phone'

export interface ApplyClientConfigsOptions {
  homeDir?: string
  platform?: NodeJS.Platform
  now?: () => number
}

export function createClientConfigs(userDataPath: string, projectPath = process.cwd()): McpClientConfigs {
  const shim = resolve(projectPath, 'scripts', 'mcp-stdio-shim.mjs')
  const escaped = escapeTomlString(shim)
  const escapedUserData = escapeTomlString(userDataPath)
  return {
    codexToml: [
      `[mcp_servers."${CONFIG_NAME}"]`,
      'command = "node"',
      `args = ["${escaped}"]`,
      `env = { LIVE_PHONE_USER_DATA_PATH = "${escapedUserData}" }`
    ].join('\n'),
    claudeDesktopJson: JSON.stringify({
      mcpServers: {
        [CONFIG_NAME]: {
          command: 'node',
          args: [shim],
          env: { LIVE_PHONE_USER_DATA_PATH: userDataPath }
        }
      }
    }, null, 2)
  }
}

export function applyLocalClientConfigs(
  configs: McpClientConfigs,
  options: ApplyClientConfigsOptions = {}
): McpClientConfigApplyResult {
  const homeDir = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const timestamp = options.now?.() ?? Date.now()
  const codexPath = join(homeDir, '.codex', 'config.toml')
  const claudePath = claudeConfigPath(homeDir, platform)
  const claudeDesktopInstalled = detectClaudeDesktop(homeDir, platform, claudePath)

  return {
    results: [
      mergeCodexConfig(codexPath, configs.codexToml, timestamp),
      mergeClaudeConfig(claudePath, configs.claudeDesktopJson, timestamp)
    ],
    claudeDesktopInstalled,
    claudeDesktopMcpVisible: claudeDesktopInstalled ? 'unverified' : 'not-installed'
  }
}

export function clientConfigPaths(
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform
): { codex: string; claudeDesktop: string } {
  return {
    codex: join(homeDir, '.codex', 'config.toml'),
    claudeDesktop: claudeConfigPath(homeDir, platform)
  }
}

function mergeCodexConfig(path: string, fragment: string, timestamp: number): McpClientConfigTargetResult {
  const original = readOptional(path)
  if (original !== undefined && hasCodexEntry(original)) {
    return { client: 'codex', path, action: 'unchanged' }
  }
  const separator = original && !original.endsWith('\n') ? '\n\n' : original ? '\n' : ''
  return writeMerged(path, `${original ?? ''}${separator}${fragment}\n`, original, 'codex', timestamp)
}

function mergeClaudeConfig(path: string, fragment: string, timestamp: number): McpClientConfigTargetResult {
  const original = readOptional(path)
  const document = original === undefined ? {} : parseJsonObject(original, path)
  const fragmentDocument = parseJsonObject(fragment, 'generated Claude Desktop fragment')
  const currentServers = document.mcpServers
  if (currentServers !== undefined && !isRecord(currentServers)) {
    throw new Error(`Claude Desktop config mcpServers must be an object: ${path}`)
  }
  const servers = currentServers ?? {}
  if (CONFIG_NAME in servers) return { client: 'claudeDesktop', path, action: 'unchanged' }
  const generatedServers = fragmentDocument.mcpServers
  if (!isRecord(generatedServers) || !isRecord(generatedServers[CONFIG_NAME])) {
    throw new Error('Generated Claude Desktop config is invalid')
  }
  const merged = {
    ...document,
    mcpServers: { ...servers, [CONFIG_NAME]: generatedServers[CONFIG_NAME] }
  }
  return writeMerged(path, `${JSON.stringify(merged, null, 2)}\n`, original, 'claudeDesktop', timestamp)
}

function writeMerged(
  path: string,
  content: string,
  original: string | undefined,
  client: McpClientConfigTargetResult['client'],
  timestamp: number
): McpClientConfigTargetResult {
  mkdirSync(dirname(path), { recursive: true })
  const backupPath = original === undefined ? undefined : `${path}.bak-${timestamp}`
  if (backupPath) copyFileSync(path, backupPath)
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${timestamp}.tmp`)
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  return {
    client,
    path,
    action: original === undefined ? 'created' : 'updated',
    ...(backupPath ? { backupPath } : {})
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed)) throw new Error(`JSON config must be an object: ${label}`)
  return parsed
}

function hasCodexEntry(raw: string): boolean {
  return /^\s*\[mcp_servers\.(?:"live-phone"|'live-phone'|live-phone)\]\s*(?:#.*)?$/m.test(raw)
}

function claudeConfigPath(homeDir: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (platform === 'win32') return join(process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  return join(homeDir, '.config', 'Claude', 'claude_desktop_config.json')
}

function detectClaudeDesktop(homeDir: string, platform: NodeJS.Platform, configPath: string): boolean {
  if (existsSync(configPath)) return true
  if (platform === 'darwin') {
    return existsSync('/Applications/Claude.app') || existsSync(join(homeDir, 'Applications', 'Claude.app'))
  }
  return false
}

function escapeTomlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
