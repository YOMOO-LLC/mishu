#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const scriptPath = fileURLToPath(import.meta.url)
const projectPath = resolve(dirname(scriptPath), '..')

/** Private-build userData folder name. Snapshot export rewrites the value to mishu. */
const APP_USER_DATA_DIR_NAME = 'mishu'

export async function runMcpClientSetup(argv = process.argv.slice(2), options = {}) {
  const output = options.stdout ?? process.stdout
  const errorOutput = options.stderr ?? process.stderr
  const homeDir = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const flags = new Set(argv)
  if (flags.has('--help') || flags.has('-h')) {
    output.write('Usage: node scripts/mcp-client-setup.mjs --print | --apply --yes\n')
    return 0
  }
  const shouldPrint = flags.has('--print')
  const shouldApply = flags.has('--apply')
  const unknown = argv.filter((argument) => !['--print', '--apply', '--yes'].includes(argument))
  if (unknown.length || (!shouldPrint && !shouldApply)) {
    errorOutput.write('Use --print to inspect snippets, or --apply --yes to back up and merge them.\n')
    return 64
  }
  if (shouldApply && !flags.has('--yes')) {
    errorOutput.write('--apply writes local config files; inspect --print first, then confirm with --yes.\n')
    return 64
  }

  const module = await tsImport('../apps/desktop/src/main/mcp/client-configs.ts', import.meta.url)
  const userDataPath = options.userDataPath ?? process.env.LIVE_PHONE_USER_DATA_PATH ?? defaultUserDataPath(homeDir, platform)
  const configs = module.createClientConfigs(userDataPath, projectPath)
  const paths = module.clientConfigPaths(homeDir, platform)

  if (shouldPrint) {
    output.write([
      `# Codex: ${paths.codex} (${existsSync(paths.codex) ? 'found' : 'not found; will create'})`,
      configs.codexToml,
      '',
      `# Claude Desktop: ${paths.claudeDesktop} (${existsSync(paths.claudeDesktop) ? 'found' : 'not found; will create'})`,
      configs.claudeDesktopJson,
      ''
    ].join('\n'))
  }

  if (shouldApply) {
    const result = module.applyLocalClientConfigs(configs, { homeDir, platform })
    for (const item of result.results) {
      output.write(`${item.client}: ${item.action} ${item.path}${item.backupPath ? ` (backup: ${item.backupPath})` : ''}\n`)
    }
    output.write(result.claudeDesktopInstalled
      ? 'Claude Desktop detected; MCP list visibility is not verified. Restart Claude Desktop and check Settings > Developer.\n'
      : 'Claude Desktop was not detected; MCP list verification is not applicable.\n')
  }
  return 0
}

function defaultUserDataPath(homeDir, platform) {
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', APP_USER_DATA_DIR_NAME)
  if (platform === 'win32') return join(process.env.APPDATA || join(homeDir, 'AppData', 'Roaming'), APP_USER_DATA_DIR_NAME)
  return join(process.env.XDG_CONFIG_HOME || join(homeDir, '.config'), APP_USER_DATA_DIR_NAME)
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runMcpClientSetup().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`MCP client setup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
