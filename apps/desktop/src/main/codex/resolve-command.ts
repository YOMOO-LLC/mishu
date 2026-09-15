import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export interface CodexCommandResolution {
  command?: string
  source?: 'environment' | 'login-shell' | 'common-path'
  error?: string
}

export interface CodexCommandResolverOptions {
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  shellLookup?: (command?: string) => string | undefined
  isExecutable?: (path: string) => boolean
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function loginShellLookup(command = 'codex'): string | undefined {
  try {
    return execFileSync('/bin/zsh', ['-lc', 'command -v -- "$CODEX_LOOKUP_COMMAND"'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_LOOKUP_COMMAND: command },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000
    }).trim() || undefined
  } catch {
    return undefined
  }
}

export function resolveCodexCommand({
  env = process.env,
  homeDirectory = homedir(),
  shellLookup = loginShellLookup,
  isExecutable = executable
}: CodexCommandResolverOptions = {}): CodexCommandResolution {
  const configured = env.CODEX_BIN?.trim()
  if (configured) {
    if (configured.includes('/')) {
      return isExecutable(configured)
        ? { command: configured, source: 'environment' }
        : { error: `Configured CODEX_BIN is not executable: ${configured}` }
    }
    const resolved = shellLookup(configured)?.trim()
    return resolved && isExecutable(resolved)
      ? { command: resolved, source: 'environment' }
      : { error: `Configured CODEX_BIN was not found: ${configured}` }
  }

  const fromShell = shellLookup('codex')?.trim()
  if (fromShell && isExecutable(fromShell)) {
    return { command: fromShell, source: 'login-shell' }
  }

  const commonPaths = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(homeDirectory, '.local/bin/codex')
  ]
  const common = commonPaths.find(isExecutable)
  if (common) return { command: common, source: 'common-path' }

  return {
    error: 'Codex CLI was not found. Install Codex, sign in with ChatGPT, or set CODEX_BIN in the app configuration.'
  }
}
