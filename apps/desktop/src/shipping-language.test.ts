import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
const LEXICON_FILE = 'packages/core/src/caller-input.ts'
const WHOLE_FILE_ALLOWLIST: readonly string[] = []
const NAMED_CONSTANT = /^export const [A-Z0-9_]+ = /

const srcRoot = dirname(fileURLToPath(import.meta.url))
const desktopRoot = dirname(srcRoot)
const publicLayout = basename(desktopRoot) === 'desktop' && basename(dirname(desktopRoot)) === 'apps'
const repoRoot = publicLayout ? dirname(dirname(desktopRoot)) : desktopRoot
const cliRoot = publicLayout ? join(repoRoot, 'apps/cli') : join(repoRoot, 'cli')
const packagesRoot = join(repoRoot, 'packages')

function walkFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(abs, files)
    else files.push(abs)
  }
  return files
}

function listedSourceFiles(): string[] {
  const listed: string[] = []
  const consider = (abs: string) => {
    const file = relative(repoRoot, abs).replaceAll('\\', '/')
    if (/\.test\.(ts|mjs)$/.test(file)) return
    if (/(^|\/)cli\/test\//.test(file)) return
    if (file.startsWith('packages/') && !/^packages\/[^/]+\/src\//.test(file)) return
    listed.push(file)
  }
  for (const abs of walkFiles(srcRoot)) consider(abs)
  for (const abs of walkFiles(cliRoot)) consider(abs)
  for (const abs of walkFiles(packagesRoot)) consider(abs)
  return listed
}

describe('shipping language', () => {
  it('keeps the CJK allowlist free of whole-file entries', () => {
    expect(WHOLE_FILE_ALLOWLIST).toEqual([])
  })

  it('keeps non-test src, cli, and packages files free of CJK except named caller-input constants', () => {
    const failures: string[] = []
    for (const file of listedSourceFiles()) {
      if (WHOLE_FILE_ALLOWLIST.includes(file)) continue
      const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (!CJK.test(line)) return
        if (file === LEXICON_FILE && NAMED_CONSTANT.test(line.trim())) return
        failures.push(`${file}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
