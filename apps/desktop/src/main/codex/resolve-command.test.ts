import { describe, expect, it, vi } from 'vitest'
import { resolveCodexCommand } from './resolve-command.js'

describe('resolveCodexCommand', () => {
  it('prefers CODEX_BIN over every discovery path', () => {
    const shellLookup = vi.fn(() => '/configured/custom-codex')
    expect(resolveCodexCommand({
      env: { CODEX_BIN: 'custom-codex' }, shellLookup, isExecutable: () => true
    })).toEqual({
      command: '/configured/custom-codex', source: 'environment'
    })
    expect(shellLookup).toHaveBeenCalledWith('custom-codex')
  })

  it('uses a login shell result before common paths', () => {
    expect(resolveCodexCommand({
      env: {}, shellLookup: () => '/shell/codex', isExecutable: () => true
    })).toEqual({ command: '/shell/codex', source: 'login-shell' })
  })

  it('falls back to common paths and returns an actionable error when absent', () => {
    expect(resolveCodexCommand({
      env: {}, homeDirectory: '/home/me', shellLookup: () => undefined,
      isExecutable: (path) => path === '/home/me/.local/bin/codex'
    })).toEqual({ command: '/home/me/.local/bin/codex', source: 'common-path' })
    expect(resolveCodexCommand({
      env: {}, shellLookup: () => undefined, isExecutable: () => false
    }).error).toContain('Codex CLI was not found')
  })
})
