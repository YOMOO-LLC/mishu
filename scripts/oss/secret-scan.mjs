#!/usr/bin/env node
/**
 * Workspace + git-history secret scanner.
 * Prints masked fragments only (first 4 + … + last 4). Never prints a full secret.
 */
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = resolve(dirname(scriptPath), '../..')
const defaultAllowlistPath = join(dirname(scriptPath), 'allowlist.json')

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.mp4', '.mov',
  '.zip', '.gz', '.tgz', '.br', '.node', '.wasm', '.pdf', '.dmg'
])

const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/

export const RULES = [
  {
    name: 'twilio-account-sid',
    regex: /\bAC[0-9a-fA-F]{32}\b/g
  },
  {
    name: 'twilio-api-key-sid',
    regex: /\bSK[0-9a-fA-F]{32}\b/g
  },
  {
    name: 'twilio-auth-token',
    regex: /(?:twilio[_-]?)?(?:auth[_-]?token)\s*['"]?\s*[:=]\s*['"]?([0-9a-f]{32})['"]?/gi,
    group: 1
  },
  {
    name: 'openai-api-key',
    regex: /(?<![A-Za-z0-9])(sk-(?:proj-|live-|test-|svcacct-)?[A-Za-z0-9_-]{10,})/g,
    group: 1
  },
  {
    name: 'private-key-block',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
  },
  {
    name: 'e164',
    regex: /\+[1-9]\d{6,14}/g,
    ignore: (value) => value.startsWith('+1555')
  },
  {
    name: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    skipPath: (path) => LOCKFILE.test(path)
  }
]

export function maskSecret(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ')
  if (!text) return '…'
  if (text.length <= 8) return `${text.slice(0, 2)}…${text.slice(-2)}`
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

export function loadAllowlist(path = defaultAllowlistPath) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const entries = parsed.entries
  if (!Array.isArray(entries)) throw new Error(`allowlist missing entries array: ${path}`)
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') throw new Error(`allowlist entry ${index} is not an object`)
    if (!entry.rule || typeof entry.rule !== 'string') throw new Error(`allowlist entry ${index} missing rule`)
    if (!entry.reason || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`allowlist entry ${index} (${entry.rule}) is missing a reason`)
    }
    if (!entry.value && !entry.pattern) {
      throw new Error(`allowlist entry ${index} (${entry.rule}) needs value or pattern`)
    }
    if (entry.pattern) {
      try {
        entry._regex = new RegExp(entry.pattern)
      } catch (error) {
        throw new Error(`allowlist entry ${index} has invalid pattern: ${error.message}`)
      }
    }
  }
  return entries
}

export function isAllowlisted(finding, entries) {
  return entries.some((entry) => {
    if (entry.rule !== finding.rule) return false
    if (entry.value && entry.value === finding.value) return true
    if (entry._regex && entry._regex.test(finding.value)) return true
    return false
  })
}

export function scanText(text, { path = '', source = 'workspace', commit = null, op = null } = {}) {
  const findings = []
  if (typeof text !== 'string' || text.length === 0) return findings
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of RULES) {
      if (rule.skipPath?.(path)) continue
      rule.regex.lastIndex = 0
      let match
      while ((match = rule.regex.exec(line)) !== null) {
        const value = rule.group ? match[rule.group] : match[0]
        if (!value) continue
        if (rule.ignore?.(value)) continue
        findings.push({
          source,
          commit,
          path,
          line: index + 1,
          rule: rule.name,
          value,
          op
        })
        if (match[0] === '') rule.regex.lastIndex += 1
      }
    }
  }
  return findings
}

function git(root, args, options = {}) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options
  })
}

export function listTrackedFiles(root) {
  const result = git(root, ['ls-files', '-z'])
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git ls-files failed')
  }
  return result.stdout.split('\0').filter(Boolean)
}

function isBinaryPath(path) {
  return BINARY_EXT.has(extname(path).toLowerCase())
}

function looksBinary(buffer) {
  const slice = buffer.subarray(0, Math.min(buffer.length, 8000))
  return slice.includes(0)
}

export function inspectDotenv(root) {
  const path = join(root, '.env')
  if (!existsSync(path)) {
    return { exists: false, gitignored: true, scanned: false }
  }
  const ignored = git(root, ['check-ignore', '-q', '.env']).status === 0
  return { exists: true, gitignored: ignored, scanned: false }
}

export function scanTrackedFiles(root, { files, allowlist } = {}) {
  const tracked = files ?? listTrackedFiles(root)
  const findings = []
  for (const file of tracked) {
    if (isBinaryPath(file)) continue
    const abs = join(root, file)
    if (!existsSync(abs)) continue
    let buffer
    try {
      buffer = readFileSync(abs)
    } catch {
      continue
    }
    if (looksBinary(buffer)) continue
    const text = buffer.toString('utf8')
    for (const finding of scanText(text, { path: file, source: 'workspace' })) {
      finding.allowlisted = isAllowlisted(finding, allowlist)
      findings.push(finding)
    }
  }
  return findings
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
  if (!match) return null
  return { oldLine: Number(match[1]), newLine: Number(match[2]) }
}

function parseDiffPath(line) {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  if (!match) return null
  return match[2] === '/dev/null' ? match[1] : match[2]
}

export async function scanGitHistory(root, { allowlist } = {}) {
  const findings = []
  const child = spawn('git', ['-C', root, 'log', '-p', '--all', `--format=${'\n'}---COMMIT---%H`], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  let commit = null
  let path = null
  let oldLine = 0
  let newLine = 0
  let inBinary = false

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.startsWith('---COMMIT---')) {
      commit = line.slice('---COMMIT---'.length).trim()
      path = null
      inBinary = false
      continue
    }
    if (!commit) continue
    if (line.startsWith('diff --git ')) {
      path = parseDiffPath(line)
      inBinary = false
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      inBinary = true
      continue
    }
    if (inBinary || !path || isBinaryPath(path)) continue
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('index ') || line.startsWith('new file ') || line.startsWith('deleted file ') || line.startsWith('similarity ') || line.startsWith('rename ')) {
      continue
    }
    const hunk = parseHunkHeader(line)
    if (hunk) {
      oldLine = hunk.oldLine
      newLine = hunk.newLine
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1)
      for (const finding of scanText(content, { path, source: 'history', commit, op: '+' })) {
        finding.line = newLine
        finding.allowlisted = isAllowlisted(finding, allowlist)
        findings.push(finding)
      }
      newLine += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const content = line.slice(1)
      for (const finding of scanText(content, { path, source: 'history', commit, op: '-' })) {
        finding.line = oldLine
        finding.allowlisted = isAllowlisted(finding, allowlist)
        findings.push(finding)
      }
      oldLine += 1
      continue
    }
    if (line.startsWith(' ') || line === '') {
      oldLine += 1
      newLine += 1
    }
  }

  const status = await new Promise((resolveStatus) => {
    child.on('close', resolveStatus)
  })
  if (status !== 0) {
    throw new Error(stderr.trim() || `git log -p --all exited ${status}`)
  }
  return findings
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const GITLEAKS_FALLBACK_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin'])

/** Resolve gitleaks from PATH, then Homebrew locations. Never rely on `which`. */
export function resolveGitleaksBin({
  pathEnv = process.env.PATH ?? '',
  extraDirs = GITLEAKS_FALLBACK_DIRS,
  names = process.platform === 'win32' ? ['gitleaks.exe', 'gitleaks'] : ['gitleaks']
} = {}) {
  const dirs = [...String(pathEnv).split(delimiter).filter(Boolean), ...extraDirs]
  const seen = new Set()
  for (const dir of dirs) {
    const key = resolve(dir)
    if (seen.has(key)) continue
    seen.add(key)
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return ''
}

export function runGitleaks(root, { workspaceOnly = false, pathEnv, extraDirs } = {}) {
  const bin = resolveGitleaksBin({ pathEnv, extraDirs })
  if (!bin) return { installed: false, findings: [] }
  const dir = mkdtempSync(join(tmpdir(), 'oss-gitleaks-'))
  const reportPath = join(dir, 'gitleaks.json')
  const args = ['detect', '--source', root, '--report-format', 'json', '--report-path', reportPath, '--no-banner', '--exit-code', '0']
  if (workspaceOnly) args.push('--no-git')
  else args.push('--log-opts', '--all')
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  let parsed = []
  if (existsSync(reportPath)) {
    try {
      const raw = readFileSync(reportPath, 'utf8').trim()
      parsed = raw ? JSON.parse(raw) : []
    } catch {
      parsed = []
    }
  }
  rmSync(dir, { recursive: true, force: true })
  if (!Array.isArray(parsed)) parsed = []
  const findings = parsed.map((item) => ({
    source: 'gitleaks',
    commit: item.Commit || item.commit || null,
    path: item.File || item.file || '',
    line: item.StartLine || item.startLine || null,
    rule: `gitleaks:${item.RuleID || item.ruleID || 'unknown'}`,
    value: item.Secret || item.Match || item.secret || ''
  }))
  return {
    installed: true,
    status: result.status,
    stderr: result.stderr,
    findings
  }
}

export function summarize(findings) {
  const bySource = { workspace: {}, history: {}, gitleaks: {} }
  const allowlisted = { workspace: 0, history: 0, gitleaks: 0 }
  const unallowlisted = { workspace: 0, history: 0, gitleaks: 0 }
  for (const finding of findings) {
    const source = bySource[finding.source] ? finding.source : 'workspace'
    const bucket = finding.allowlisted ? allowlisted : unallowlisted
    bucket[source] = (bucket[source] ?? 0) + 1
    const rules = bySource[source]
    const key = finding.rule
    if (!rules[key]) rules[key] = { total: 0, allowlisted: 0, unallowlisted: 0 }
    rules[key].total += 1
    if (finding.allowlisted) rules[key].allowlisted += 1
    else rules[key].unallowlisted += 1
  }
  return { bySource, allowlisted, unallowlisted }
}

function formatFinding(finding) {
  const masked = maskSecret(finding.value)
  const where = finding.commit
    ? `${finding.commit.slice(0, 12)} ${finding.path}:${finding.op ?? ''}${finding.line ?? '?'}`
    : `${finding.path}:${finding.line ?? '?'}`
  const flag = finding.allowlisted ? 'allowlisted' : 'HIT'
  return `[${finding.source}] ${flag} ${where} ${finding.rule} ${masked}`
}

export function formatReport({ findings, dotenv, gitleaks, showAllowlisted = false }) {
  const lines = ['# secret-scan', '']
  if (!dotenv.exists) lines.push('.env: not present (gitignore still lists it; contents never read)')
  else if (dotenv.gitignored) lines.push('.env: present, gitignored, contents not read')
  else lines.push('.env: present and NOT gitignored (treat as a leak of the file itself; contents not read)')

  if (!gitleaks.installed) lines.push('gitleaks: not installed; built-in scanner only')
  else lines.push(`gitleaks: ran (${gitleaks.findings.length} raw findings, merged and masked)`)

  lines.push('')
  const summary = summarize(findings)
  const printable = showAllowlisted ? findings : findings.filter((finding) => !finding.allowlisted)
  for (const finding of printable) lines.push(formatFinding(finding))
  if (!showAllowlisted) {
    const hidden = findings.length - printable.length
    if (hidden > 0) lines.push(`(${hidden} allowlisted hits omitted; pass --show-allowlisted to print them masked)`)
  }

  lines.push('', '## counts by rule')
  for (const source of ['workspace', 'history', 'gitleaks']) {
    const rules = summary.bySource[source]
    const names = Object.keys(rules).sort()
    if (names.length === 0) {
      lines.push(`${source}: none`)
      continue
    }
    lines.push(`${source}:`)
    for (const name of names) {
      const row = rules[name]
      lines.push(`  ${name}: ${row.total} (unallowlisted ${row.unallowlisted}, allowlisted ${row.allowlisted})`)
    }
  }
  const unallowlistedTotal = Object.values(summary.unallowlisted).reduce((a, b) => a + b, 0)
  lines.push('', `unallowlisted total: ${unallowlistedTotal}`)
  return { text: `${lines.join('\n')}\n`, summary, unallowlistedTotal }
}

function parseArgs(argv) {
  const options = {
    workspace: true,
    history: true,
    showAllowlisted: false,
    json: false,
    files: null,
    allowlist: defaultAllowlistPath,
    root: defaultRoot
  }
  const files = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace-only') {
      options.workspace = true
      options.history = false
    } else if (arg === '--history-only') {
      options.workspace = false
      options.history = true
    } else if (arg === '--show-allowlisted') {
      options.showAllowlisted = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--allowlist') {
      options.allowlist = argv[++i]
    } else if (arg === '--root') {
      options.root = resolve(argv[++i])
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag ${arg}`)
    } else {
      files.push(arg)
    }
  }
  if (files.length) options.files = files
  return options
}

export async function runSecretScan(argv = process.argv.slice(2), io = process) {
  const options = parseArgs(argv)
  if (options.help) {
    io.stdout.write(`Usage: node scripts/oss/secret-scan.mjs [--workspace-only] [--history-only] [--show-allowlisted] [--json] [--allowlist path] [files...]\n`)
    return 0
  }
  const allowlist = loadAllowlist(options.allowlist)
  const dotenv = inspectDotenv(options.root)
  let findings = []
  if (options.workspace) {
    findings = findings.concat(scanTrackedFiles(options.root, { files: options.files, allowlist }))
  }
  if (options.history) {
    findings = findings.concat(await scanGitHistory(options.root, { allowlist }))
  }
  const gitleaks = runGitleaks(options.root, { workspaceOnly: options.workspace && !options.history })
  if (gitleaks.installed) {
    for (const finding of gitleaks.findings) {
      finding.allowlisted = isAllowlisted({ ...finding, rule: finding.rule.replace(/^gitleaks:/, '') }, allowlist)
        || isAllowlisted(finding, allowlist)
      findings.push(finding)
    }
  }

  const report = formatReport({
    findings,
    dotenv,
    gitleaks,
    showAllowlisted: options.showAllowlisted
  })

  if (options.json) {
    io.stdout.write(`${JSON.stringify({
      dotenv,
      gitleaksInstalled: gitleaks.installed,
      summary: report.summary,
      unallowlistedTotal: report.unallowlistedTotal,
      findings: findings.map((finding) => ({
        source: finding.source,
        commit: finding.commit,
        path: finding.path,
        line: finding.line,
        rule: finding.rule,
        fragment: maskSecret(finding.value),
        allowlisted: finding.allowlisted
      }))
    }, null, 2)}\n`)
  } else {
    io.stdout.write(report.text)
  }

  if (dotenv.exists && !dotenv.gitignored) return 1
  return report.unallowlistedTotal > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runSecretScan().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    process.stderr.write(`secret-scan failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
