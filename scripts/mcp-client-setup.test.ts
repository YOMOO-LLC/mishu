import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

describe('mcp-client-setup script', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('prints both snippets and backs up merge targets under a temporary HOME', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mcp-setup-home-'))
    directories.push(homeDir)
    const codexPath = join(homeDir, '.codex', 'config.toml')
    const claudePath = join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    mkdirSync(dirname(codexPath), { recursive: true })
    mkdirSync(dirname(claudePath), { recursive: true })
    writeFileSync(codexPath, '[projects."/existing"]\ntrust_level = "trusted"\n')
    writeFileSync(claudePath, JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'old' } } }))
    const env = { ...process.env, HOME: homeDir, LIVE_PHONE_USER_DATA_PATH: join(homeDir, 'app-data') }

    const printed = spawnSync(process.execPath, ['scripts/mcp-client-setup.mjs', '--print'], {
      cwd: process.cwd(), env, encoding: 'utf8'
    })
    expect(printed.status).toBe(0)
    expect(printed.stdout).toContain('[mcp_servers."live-phone"]')
    expect(printed.stdout).toContain('"mcpServers"')

    const applied = spawnSync(process.execPath, ['scripts/mcp-client-setup.mjs', '--apply', '--yes'], {
      cwd: process.cwd(), env, encoding: 'utf8'
    })
    expect(applied.status).toBe(0)
    expect(readFileSync(codexPath, 'utf8')).toContain('[projects."/existing"]')
    expect(readFileSync(codexPath, 'utf8')).toContain('[mcp_servers."live-phone"]')
    const claude = JSON.parse(readFileSync(claudePath, 'utf8')) as { theme: string; mcpServers: Record<string, unknown> }
    expect(claude.theme).toBe('dark')
    expect(claude.mcpServers.existing).toEqual({ command: 'old' })
    expect(claude.mcpServers['live-phone']).toBeTruthy()
    expect(readdirSync(dirname(codexPath)).some((name) => name.startsWith('config.toml.bak-'))).toBe(true)
    expect(readdirSync(dirname(claudePath)).some((name) => name.startsWith('claude_desktop_config.json.bak-'))).toBe(true)
  })

  it('refuses to write without the explicit --yes confirmation', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mcp-setup-confirm-'))
    directories.push(homeDir)
    const result = spawnSync(process.execPath, ['scripts/mcp-client-setup.mjs', '--apply'], {
      cwd: process.cwd(), env: { ...process.env, HOME: homeDir }, encoding: 'utf8'
    })

    expect(result.status).toBe(64)
    expect(result.stderr).toContain('confirm with --yes')
  })
})
