import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyLocalClientConfigs, clientConfigPaths, createClientConfigs } from './client-configs'

describe('MCP client config merge', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('backs up existing files and only appends the live-phone entries', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mcp-client-configs-'))
    directories.push(homeDir)
    const paths = clientConfigPaths(homeDir, 'darwin')
    mkdirSync(dirname(paths.codex), { recursive: true })
    mkdirSync(dirname(paths.claudeDesktop), { recursive: true })
    const codexOriginal = '[projects."/work"]\ntrust_level = "trusted"\n'
    const claudeOriginal = JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'existing' } } }, null, 2)
    writeFileSync(paths.codex, codexOriginal)
    writeFileSync(paths.claudeDesktop, claudeOriginal)

    const result = applyLocalClientConfigs(
      createClientConfigs('/tmp/app-data', '/tmp/project'),
      { homeDir, platform: 'darwin', now: () => 1234 }
    )

    expect(result).toMatchObject({
      claudeDesktopInstalled: true,
      claudeDesktopMcpVisible: 'unverified',
      results: [
        { client: 'codex', action: 'updated', backupPath: `${paths.codex}.bak-1234` },
        { client: 'claudeDesktop', action: 'updated', backupPath: `${paths.claudeDesktop}.bak-1234` }
      ]
    })
    expect(readFileSync(`${paths.codex}.bak-1234`, 'utf8')).toBe(codexOriginal)
    expect(readFileSync(paths.codex, 'utf8')).toContain('[projects."/work"]')
    expect(readFileSync(paths.codex, 'utf8')).toContain('[mcp_servers."live-phone"]')
    expect(readFileSync(`${paths.claudeDesktop}.bak-1234`, 'utf8')).toBe(claudeOriginal)
    const claude = JSON.parse(readFileSync(paths.claudeDesktop, 'utf8')) as {
      theme: string
      mcpServers: Record<string, unknown>
    }
    expect(claude.theme).toBe('dark')
    expect(claude.mcpServers.existing).toEqual({ command: 'existing' })
    expect(claude.mcpServers['live-phone']).toMatchObject({ command: 'node' })
  })

  it('does not overwrite existing live-phone entries', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mcp-client-existing-'))
    directories.push(homeDir)
    const paths = clientConfigPaths(homeDir, 'darwin')
    mkdirSync(dirname(paths.codex), { recursive: true })
    mkdirSync(dirname(paths.claudeDesktop), { recursive: true })
    writeFileSync(paths.codex, '[mcp_servers."live-phone"]\ncommand = "custom"\n')
    writeFileSync(paths.claudeDesktop, JSON.stringify({
      mcpServers: { 'live-phone': { command: 'custom' } }
    }))

    const result = applyLocalClientConfigs(createClientConfigs('/new/data'), {
      homeDir, platform: 'darwin', now: () => 4567
    })

    expect(result.results.map(({ action }) => action)).toEqual(['unchanged', 'unchanged'])
    expect(readFileSync(paths.codex, 'utf8')).toContain('command = "custom"')
    expect(readFileSync(paths.claudeDesktop, 'utf8')).toContain('"custom"')
  })
})
