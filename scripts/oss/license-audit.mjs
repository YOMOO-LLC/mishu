#!/usr/bin/env node
/**
 * Production-dependency license audit against the ADR-0004 allow list.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = resolve(dirname(scriptPath), '../..')

export const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0'
])

const COPYLEFT_RE = /\b(AGPL|GPL|LGPL|MPL|EUPL|CDDL|SSPL|OSL|CC-BY-SA|GFDL)\b/i

const ALIASES = new Map([
  ['MIT License', 'MIT'],
  ['Apache 2.0', 'Apache-2.0'],
  ['Apache-2', 'Apache-2.0'],
  ['Apache2', 'Apache-2.0'],
  ['Apache License 2.0', 'Apache-2.0'],
  ['BSD', 'BSD-3-Clause'],
  ['BSD-2', 'BSD-2-Clause'],
  ['BSD-3', 'BSD-3-Clause'],
  ['ISC License', 'ISC'],
  ['The Unlicense', 'Unlicense'],
  ['BlueOak-1.0.0', 'BlueOak-1.0.0'],
  ['Python-2.0', 'Python-2.0']
])

export function normalizeLicenseId(id) {
  const trimmed = String(id ?? '').trim().replace(/^[\s(]+|[\s)]+$/g, '')
  if (!trimmed) return ''
  return ALIASES.get(trimmed) ?? trimmed
}

function tokenizeExpression(expr) {
  return expr
    .replaceAll('(', ' ( ')
    .replaceAll(')', ' ) ')
    .split(/\s+/)
    .filter(Boolean)
}

function parseOrAnd(tokens) {
  // Parse SPDX with AND tighter than OR, parentheses.
  function parseOr(index) {
    const [left, next] = parseAnd(index)
    const options = [left]
    let i = next
    while (i < tokens.length && tokens[i].toUpperCase() === 'OR') {
      const [right, after] = parseAnd(i + 1)
      options.push(right)
      i = after
    }
    return [{ type: 'or', options }, i]
  }
  function parseAnd(index) {
    const [left, next] = parsePrimary(index)
    const parts = [left]
    let i = next
    while (i < tokens.length && tokens[i].toUpperCase() === 'AND') {
      const [right, after] = parsePrimary(i + 1)
      parts.push(right)
      i = after
    }
    return [{ type: 'and', parts }, i]
  }
  function parsePrimary(index) {
    if (tokens[index] === '(') {
      const [node, next] = parseOr(index + 1)
      if (tokens[next] !== ')') return [node, next]
      return [node, next + 1]
    }
    return [{ type: 'id', id: tokens[index] ?? '' }, index + 1]
  }
  const [tree] = parseOr(0)
  return tree
}

export function classifyLicense(expression) {
  const raw = String(expression ?? '').trim()
  if (!raw || raw === 'UNLICENSED' || /^SEE LICENSE IN /i.test(raw) || /^LicenseRef-/i.test(raw)) {
    return { ok: false, kind: 'unknown', id: raw || '(missing)' }
  }
  const tree = parseOrAnd(tokenizeExpression(raw))

  function evalNode(node) {
    if (node.type === 'id') {
      const id = normalizeLicenseId(node.id)
      if (ALLOWED_LICENSES.has(id)) return { ok: true, kind: 'allowed', id }
      if (COPYLEFT_RE.test(id)) return { ok: false, kind: 'copyleft', id }
      return { ok: false, kind: 'unknown', id }
    }
    if (node.type === 'or') {
      const results = node.options.map(evalNode)
      const allowed = results.find((result) => result.ok)
      if (allowed) return allowed
      if (results.some((result) => result.kind === 'copyleft')) {
        return { ok: false, kind: 'copyleft', id: raw }
      }
      return { ok: false, kind: 'unknown', id: raw }
    }
    const results = node.parts.map(evalNode)
    if (results.every((result) => result.ok)) return { ok: true, kind: 'allowed', id: raw }
    if (results.some((result) => result.kind === 'copyleft')) {
      return { ok: false, kind: 'copyleft', id: raw }
    }
    return { ok: false, kind: 'unknown', id: raw }
  }

  return evalNode(tree)
}

function readPnpmLicenses(root) {
  const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `pnpm licenses list --prod --json exited ${result.status}`)
  }
  const parsed = JSON.parse(result.stdout)
  if (!parsed || typeof parsed !== 'object') throw new Error('unexpected pnpm licenses JSON')
  return parsed
}

function flattenPackages(licenseJson) {
  const packages = []
  for (const [bucket, list] of Object.entries(licenseJson)) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const name = item.name ?? '(unknown)'
      const versions = item.versions ?? (item.version ? [item.version] : ['?'])
      const license = item.license || bucket
      for (const version of versions) {
        packages.push({ name, version, license })
      }
    }
  }
  return packages
}

export function auditLicenses(packages) {
  const counts = new Map()
  const problems = []
  for (const pkg of packages) {
    const verdict = classifyLicense(pkg.license)
    const key = verdict.id || pkg.license || '(missing)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (!verdict.ok) {
      problems.push({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        kind: verdict.kind
      })
    }
  }
  return { counts, problems, total: packages.length }
}

export function formatAudit({ counts, problems, total }) {
  const lines = ['# license-audit (production dependencies)', '', `packages: ${total}`, '', '## counts']
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  for (const [id, count] of sorted) {
    const allowed = classifyLicense(id).ok ? 'allow' : 'PROBLEM'
    lines.push(`  ${count.toString().padStart(4, ' ')}  ${id}  [${allowed}]`)
  }
  lines.push('', '## problems')
  if (problems.length === 0) {
    lines.push('  none')
  } else {
    const copyleft = problems.filter((p) => p.kind === 'copyleft')
    const unknown = problems.filter((p) => p.kind !== 'copyleft')
    if (copyleft.length) {
      lines.push('  copyleft:')
      for (const item of copyleft) {
        lines.push(`    ${item.name}@${item.version}  ${item.license}`)
      }
    }
    if (unknown.length) {
      lines.push('  unknown:')
      for (const item of unknown) {
        lines.push(`    ${item.name}@${item.version}  ${item.license}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

export function runLicenseAudit(argv = process.argv.slice(2), io = process, root = defaultRoot) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write('Usage: node scripts/oss/license-audit.mjs [--json]\n')
    return 0
  }
  const jsonMode = argv.includes('--json')
  const packages = flattenPackages(readPnpmLicenses(root))
  const audit = auditLicenses(packages)
  if (jsonMode) {
    io.stdout.write(`${JSON.stringify({
      total: audit.total,
      counts: Object.fromEntries(audit.counts),
      problems: audit.problems
    }, null, 2)}\n`)
  } else {
    io.stdout.write(formatAudit(audit))
  }
  return audit.problems.length > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = runLicenseAudit()
  } catch (error) {
    process.stderr.write(`license-audit failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
