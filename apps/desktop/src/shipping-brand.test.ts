import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = dirname(fileURLToPath(import.meta.url))
const BANNED_PHRASES = ['Codex' + ' Phone', 'Codex' + ' takeover'] as const
const SPEAKER_LABEL = /(?:speaker\s*===\s*'assistant'\s*\?\s*'Codex'|\?\s*'Codex'\s*:\s*speaker\s*===\s*'caller')/

/**
 * User-visible "Codex" strings that name the optional local technical source,
 * the Codex CLI binary, or the Codex CLI MCP client config. Each entry must
 * stay a technical label, not product branding.
 */
const CODEX_ALLOWLIST: ReadonlyArray<{ file: string; snippet: string; reason: string }> = [
  {
    file: 'src/renderer/src/App.tsx',
    snippet: 'Connecting to local Codex app-server',
    reason: 'Footer connection status names the optional local Codex app-server'
  },
  {
    file: 'src/renderer/src/App.tsx',
    snippet: 'Local Codex app-server · GPT Live connected',
    reason: 'Footer ready state names the local Codex app-server voice source'
  },
  {
    file: 'src/renderer/src/App.tsx',
    snippet: 'Codex app-server / GPT Live error',
    reason: 'Footer error state names the Codex app-server technical source'
  },
  {
    file: 'src/renderer/src/App.tsx',
    snippet: "label={voiceProvider === 'gpt-live-api' ? 'GPT Live · API' : 'Local Codex app-server'}",
    reason: 'Header connection pill names the local Codex app-server source'
  },
  {
    file: 'src/renderer/src/App.tsx',
    snippet: 'Codex CLI is unavailable',
    reason: 'Warning refers to the Codex CLI binary, not the product brand'
  },
  {
    file: 'src/renderer/src/settings/VoiceSection.tsx',
    snippet: 'Codex app-server (local)',
    reason: 'Voice source option and badge name the optional local adapter'
  },
  {
    file: 'src/renderer/src/settings/VoiceSection.tsx',
    snippet: 'Codex app-server uses local sign-in',
    reason: 'Source help text describes Codex app-server authentication'
  },
  {
    file: 'src/renderer/src/settings/VoiceSection.tsx',
    snippet: 'Codex app-server uses the Campaign voice',
    reason: 'GPT Live options help names the Codex app-server voice path'
  },
  {
    file: 'src/renderer/src/settings/McpSection.tsx',
    snippet: 'Codex and Claude Desktop configs',
    reason: 'Confirm dialog refers to the Codex CLI as an MCP client'
  },
  {
    file: 'src/renderer/src/settings/McpSection.tsx',
    snippet: 'Codex · ~/.codex/config.toml',
    reason: 'MCP client config card names the Codex CLI config path'
  }
]

function walkFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(abs, files)
    else files.push(abs)
  }
  return files
}

function listedUiFiles(): string[] {
  const renderer = join(srcRoot, 'renderer')
  const tray = join(srcRoot, 'main/tray.ts')
  const files = walkFiles(renderer)
  if (existsSync(tray)) files.push(tray)
  return files
    .filter((abs) => !/\.test\.(ts|tsx)$/.test(abs))
    .filter((abs) => /\.(tsx|html|css)$/.test(abs) || abs.endsWith(`${join('main', 'tray.ts')}`) || abs.endsWith('main/tray.ts'))
    .map((abs) => `src/${relative(srcRoot, abs).replaceAll('\\', '/')}`)
}

function readUiFile(file: string): string {
  return readFileSync(join(srcRoot, file.replace(/^src\//, '')), 'utf8')
}

describe('shipping brand', () => {
  it('keeps banned Codex speaker labels out of the UI', () => {
    const failures: string[] = []
    for (const file of listedUiFiles()) {
      const lines = readUiFile(file).split('\n')
      lines.forEach((line, index) => {
        for (const phrase of BANNED_PHRASES) {
          if (line.includes(phrase)) {
            failures.push(`${file}:${index + 1}: banned phrase "${phrase}": ${line.trim()}`)
          }
        }
        if (SPEAKER_LABEL.test(line)) {
          failures.push(`${file}:${index + 1}: Codex used as a speaker label: ${line.trim()}`)
        }
      })
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('allowlists remaining Codex strings as technical source labels', () => {
    const unused = new Set(CODEX_ALLOWLIST.map((entry) => `${entry.file}::${entry.snippet}`))
    const unexplained: string[] = []
    for (const file of listedUiFiles()) {
      const lines = readUiFile(file).split('\n')
      lines.forEach((line, index) => {
        if (!line.includes('Codex')) return
        const matched = CODEX_ALLOWLIST.find((entry) => entry.file === file && line.includes(entry.snippet))
        if (!matched) {
          unexplained.push(`${file}:${index + 1}: ${line.trim()}`)
          return
        }
        unused.delete(`${matched.file}::${matched.snippet}`)
      })
    }
    expect(unexplained, unexplained.join('\n')).toEqual([])
    expect([...unused], `unused allowlist entries:\n${[...unused].join('\n')}`).toEqual([])
  })
})
