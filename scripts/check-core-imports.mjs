#!/usr/bin/env node
/**
 * Boundary lint for packages/core, packages/contracts, packages/adapters-*,
 * and the host-agnostic engine layer (ADR-0001 invariant 1).
 *
 * Core forbids host/vendor modules and escaped relative imports. Contracts
 * cannot depend on core or app/adapter packages. Adapters-cloud may import
 * vendor SDKs and @mishu/core but never electron or src/spikes. Adapters-mock
 * also forbids vendor SDKs and network modules. src/main/http and
 * src/main/services may not import electron (src-engine-no-electron).
 * apps/cloud may not import electron, src/main/index.ts, src/main/phone-gateway.ts,
 * src/main/mcp/desktop-approval-presenter.ts, or anything under src/renderer/
 * (apps-cloud-no-desktop).
 * Type-only imports of forbidden modules are allowed in packages; type-only
 * imports that resolve outside the package (including into src/) are not.
 * Engine electron imports are forbidden even when type-only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
export const defaultRepoRoot = resolve(dirname(scriptPath), '..')

export const CORE_STUB_VERSION = 'mishu-core-0.0.0-stub'

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'out', '.git'])

const FORBIDDEN_MODULES = new Set([
  'electron',
  'node:sqlite',
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
  'node:child_process',
  'child_process',
  '@twilio/voice-sdk',
  'twilio',
  'ws',
  'dotenv',
  'openai'
])

const FORBIDDEN_MODULE_PREFIXES = [
  'electron/',
  'node:fs/',
  'fs/',
  'node:child_process/',
  'child_process/',
  '@twilio/voice-sdk/',
  'twilio/',
  'ws/',
  'dotenv/',
  'openai/'
]

const APP_ADAPTER_PREFIXES = ['@mishu/adapters-', 'apps/', 'src/', 'spikes/']
const APP_PATH_PREFIXES = ['apps/', 'src/', 'spikes/']

const MOCK_NETWORK_MODULES = new Set([
  'ws',
  'twilio',
  '@twilio/voice-sdk',
  'openai',
  'node:net',
  'net',
  'node:http',
  'http',
  'node:https',
  'https'
])

const MOCK_NETWORK_PREFIXES = [
  'ws/',
  'twilio/',
  '@twilio/voice-sdk/',
  'openai/',
  'node:net/',
  'net/',
  'node:http/',
  'http/',
  'node:https/',
  'https/'
]

export const RULE = {
  forbiddenModule: 'forbidden-module',
  escapedRelative: 'escaped-relative',
  contractsDependsOnCore: 'contracts-depends-on-core',
  contractsDependsOnApp: 'contracts-depends-on-app',
  adaptersDependsOnApp: 'adapters-depends-on-app',
  srcEngineNoElectron: 'src-engine-no-electron',
  appsCloudNoDesktop: 'apps-cloud-no-desktop'
}

/**
 * @typedef {{ file: string, line: number, spec: string, typeOnly: boolean, kind: string }} Specifier
 * @typedef {{ file: string, line: number, rule: string, spec: string }} Violation
 */

export function isForbiddenModule(spec) {
  if (FORBIDDEN_MODULES.has(spec)) return true
  return FORBIDDEN_MODULE_PREFIXES.some((prefix) => spec.startsWith(prefix))
}

export function isElectronSpecifier(spec) {
  return spec === 'electron' || spec.startsWith('electron/')
}

export function isMockNetworkOrVendor(spec) {
  if (MOCK_NETWORK_MODULES.has(spec)) return true
  return MOCK_NETWORK_PREFIXES.some((prefix) => spec.startsWith(prefix))
}

export function isAdaptersPackageName(packageName) {
  return packageName.startsWith('@mishu/adapters-')
}

export function isForbiddenModuleForPackage(packageName, spec) {
  if (packageName === '@mishu/adapters-mock') {
    return isElectronSpecifier(spec) || isMockNetworkOrVendor(spec)
  }
  if (isAdaptersPackageName(packageName)) {
    return isElectronSpecifier(spec)
  }
  return isForbiddenModule(spec)
}

export function isCoreSpecifier(spec) {
  return spec === '@mishu/core' || spec.startsWith('@mishu/core/')
}

export function isAppOrAdapterSpecifier(spec) {
  return APP_ADAPTER_PREFIXES.some((prefix) => spec === prefix.slice(0, -1) || spec.startsWith(prefix))
}

export function isAppPathSpecifier(spec) {
  return APP_PATH_PREFIXES.some((prefix) => spec === prefix.slice(0, -1) || spec.startsWith(prefix))
}

export function isInsideDir(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel))
}

function copyWithNewlines(text) {
  let output = ''
  for (const ch of text) {
    output += ch === '\n' || ch === '\r' ? ch : ' '
  }
  return output
}

export function stripCommentsPreservingLines(source) {
  let output = ''
  let i = 0
  const length = source.length
  while (i < length) {
    const current = source[i]
    const next = source[i + 1]
    if (current === '/' && next === '/') {
      i += 2
      const start = i
      while (i < length && source[i] !== '\n') i += 1
      output += `  ${copyWithNewlines(source.slice(start, i))}`
      continue
    }
    if (current === '/' && next === '*') {
      i += 2
      const start = i
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      output += `  ${copyWithNewlines(source.slice(start, i))}`
      if (i < length) {
        output += '  '
        i += 2
      }
      continue
    }
    if (current === "'" || current === '"' || current === '`') {
      const quote = current
      const start = i
      i += 1
      while (i < length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      output += source.slice(start, i)
      continue
    }
    output += current
    i += 1
  }
  return output
}

function lineNumberAt(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1
  }
  return line
}

function isTypeOnlyImportClause(clause) {
  const trimmed = clause.trim()
  if (/^type\b/.test(trimmed)) return true
  const brace = trimmed.match(/^\{([\s\S]*)\}$/)
  if (!brace) return false
  const parts = brace[1].split(',').map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 && parts.every((part) => /^type\b/.test(part))
}

/**
 * @param {string} source
 * @param {string} file
 * @returns {Specifier[]}
 */
export function findSpecifiers(source, file) {
  const stripped = stripCommentsPreservingLines(source)
  /** @type {Specifier[]} */
  const found = []
  const seen = new Set()

  /**
   * @param {number} index
   * @param {string} spec
   * @param {boolean} typeOnly
   * @param {string} kind
   */
  const push = (index, spec, typeOnly, kind) => {
    const line = lineNumberAt(source, index)
    const key = `${line}|${spec}|${typeOnly}|${kind}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ file, line, spec, typeOnly, kind })
  }

  const fromPattern = /\b(import|export)(?!\s*\()([\s\S]*?)\s+from\s+(['"])([^'"]+)\3/g
  let match
  while ((match = fromPattern.exec(stripped))) {
    const clause = match[2]
    const spec = match[4]
    const typeOnly = isTypeOnlyImportClause(clause)
    push(match.index, spec, typeOnly, match[1])
  }

  const sideEffect = /\bimport\s+(['"])([^'"]+)\1/g
  while ((match = sideEffect.exec(stripped))) {
    push(match.index, match[2], false, 'side-effect')
  }

  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  while ((match = dynamicImport.exec(stripped))) {
    push(match.index, match[2], false, 'dynamic')
  }

  const required = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  while ((match = required.exec(stripped))) {
    push(match.index, match[2], false, 'require')
  }

  return found
}

function listSourceFiles(root) {
  /** @type {string[]} */
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        walk(full)
        continue
      }
      const extIndex = entry.name.lastIndexOf('.')
      const ext = extIndex >= 0 ? entry.name.slice(extIndex) : ''
      if (SOURCE_EXT.has(ext)) files.push(full)
    }
  }
  walk(root)
  return files
}

function readPackageName(packageRoot) {
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) return ''
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return typeof parsed.name === 'string' ? parsed.name : ''
  } catch {
    return ''
  }
}

/**
 * @param {string} packageRoot
 * @param {Specifier} specifier
 * @returns {Violation | null}
 */
export function classifySpecifier(packageRoot, specifier) {
  const spec = specifier.spec
  const packageName = readPackageName(packageRoot)
  const isContracts = packageName === '@mishu/contracts'

  if (spec.startsWith('.')) {
    const resolved = resolve(dirname(specifier.file), spec.split(/[?#]/)[0])
    if (!isInsideDir(packageRoot, resolved)) {
      return { file: specifier.file, line: specifier.line, rule: RULE.escapedRelative, spec }
    }
    return null
  }

  if (isContracts && isCoreSpecifier(spec)) {
    return { file: specifier.file, line: specifier.line, rule: RULE.contractsDependsOnCore, spec }
  }

  if (isContracts && isAppOrAdapterSpecifier(spec)) {
    return { file: specifier.file, line: specifier.line, rule: RULE.contractsDependsOnApp, spec }
  }

  if (isAdaptersPackageName(packageName) && isAppPathSpecifier(spec)) {
    return { file: specifier.file, line: specifier.line, rule: RULE.adaptersDependsOnApp, spec }
  }

  if (isForbiddenModuleForPackage(packageName, spec) && !specifier.typeOnly) {
    return { file: specifier.file, line: specifier.line, rule: RULE.forbiddenModule, spec }
  }

  return null
}

/**
 * @param {string[]} packageRoots
 * @returns {Violation[]}
 */
export function collectViolations(packageRoots) {
  /** @type {Violation[]} */
  const violations = []
  for (const packageRoot of packageRoots) {
    const root = resolve(packageRoot)
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`package root is not a directory: ${root}`)
    }
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of findSpecifiers(source, file)) {
        const violation = classifySpecifier(root, specifier)
        if (violation) violations.push(violation)
      }
    }
  }
  return violations
}

const BUNDLE_RUNTIME_PATTERNS = [
  /\brequire\(\s*['"]@mishu\//,
  /\bfrom\s+['"]@mishu\//,
  /\bimport\(\s*['"]@mishu\//
]

/**
 * @param {string} outDir
 * @returns {Violation[]}
 */
export function collectBundleViolations(outDir) {
  const root = resolve(outDir)
  if (!existsSync(root)) {
    throw new Error(`bundle output directory is missing: ${root}`)
  }
  /** @type {Violation[]} */
  const violations = []
  const scanFiles = ['main', 'preload'].flatMap((dir) => {
    const sub = join(root, dir)
    return existsSync(sub) ? listSourceFiles(sub) : []
  })
  let mainSawStub = false
  for (const file of scanFiles) {
    const source = readFileSync(file, 'utf8')
    const rel = relative(root, file).replaceAll('\\', '/')
    if (rel.startsWith('main/') && source.includes(CORE_STUB_VERSION)) mainSawStub = true
    for (const pattern of BUNDLE_RUNTIME_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(source)) {
        violations.push({
          file,
          line: 1,
          rule: 'bundled-runtime-mishu',
          spec: '@mishu/'
        })
      }
    }
  }
  const mainDir = join(root, 'main')
  if (existsSync(mainDir) && !mainSawStub) {
    violations.push({
      file: mainDir,
      line: 1,
      rule: 'missing-core-stub',
      spec: CORE_STUB_VERSION
    })
  }
  return violations
}

export function formatViolations(violations, cwd = process.cwd()) {
  return violations.map((violation) => {
    const file = relative(cwd, violation.file).replaceAll('\\', '/') || violation.file
    return `${file}:${violation.line} ${violation.rule} ${violation.spec}`
  }).join('\n')
}

export function defaultPackageRoots(repoRoot = defaultRepoRoot) {
  return [
    join(repoRoot, 'packages/core'),
    join(repoRoot, 'packages/contracts'),
    join(repoRoot, 'packages/adapters-cloud'),
    join(repoRoot, 'packages/adapters-mock')
  ].filter((root) => existsSync(root))
}

export function defaultEngineRoots(repoRoot = defaultRepoRoot) {
  const desktopHttp = join(repoRoot, 'apps/desktop/src/main/http')
  const desktopServices = join(repoRoot, 'apps/desktop/src/main/services')
  if (existsSync(desktopHttp) || existsSync(desktopServices)) {
    return [desktopHttp, desktopServices].filter((root) => existsSync(root) && statSync(root).isDirectory())
  }
  return [
    join(repoRoot, 'src/main/http'),
    join(repoRoot, 'src/main/services')
  ].filter((root) => existsSync(root) && statSync(root).isDirectory())
}

export function defaultCloudHostRoots(repoRoot = defaultRepoRoot) {
  return [
    join(repoRoot, 'apps/cloud')
  ].filter((root) => existsSync(root) && statSync(root).isDirectory())
}

const CLOUD_FORBIDDEN_SPEC_PREFIXES = [
  'electron',
  'src/renderer',
  '@renderer',
  'src/main/index',
  'src/main/phone-gateway',
  'src/main/mcp/desktop-approval-presenter'
]

export function isForbiddenCloudHostSpecifier(spec) {
  if (isElectronSpecifier(spec)) return true
  return CLOUD_FORBIDDEN_SPEC_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`) || spec.startsWith(`${prefix}.`))
}

function resolveRelativeTarget(fromFile, spec) {
  const withoutQuery = spec.split(/[?#]/)[0]
  const withoutJs = withoutQuery.replace(/\.js$/, '')
  const candidates = [
    resolve(dirname(fromFile), `${withoutJs}.ts`),
    resolve(dirname(fromFile), `${withoutJs}.tsx`),
    resolve(dirname(fromFile), withoutQuery),
    resolve(dirname(fromFile), join(withoutJs, 'index.ts'))
  ]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

export function isForbiddenCloudHostFile(repoRoot, target) {
  const rel = relative(repoRoot, target).replaceAll('\\', '/')
  const shipped = rel.replace(/^apps\/desktop\//, '')
  if (shipped.startsWith('src/renderer/') || shipped === 'src/renderer') return true
  if (shipped === 'src/main/index.ts' || shipped === 'src/main/index.js' || shipped === 'src/main/index.mts') return true
  if (shipped.startsWith('src/main/phone-gateway.')) return true
  if (shipped.includes('src/main/mcp/desktop-approval-presenter.')) return true
  return false
}

/**
 * @param {string[]} engineRoots
 * @returns {Violation[]}
 */
export function collectEngineViolations(engineRoots) {
  /** @type {Violation[]} */
  const violations = []
  for (const engineRoot of engineRoots) {
    const root = resolve(engineRoot)
    if (!existsSync(root) || !statSync(root).isDirectory()) continue
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of findSpecifiers(source, file)) {
        if (!isElectronSpecifier(specifier.spec)) continue
        violations.push({
          file: specifier.file,
          line: specifier.line,
          rule: RULE.srcEngineNoElectron,
          spec: specifier.spec
        })
      }
    }
  }
  return violations
}

/**
 * @param {string[]} cloudRoots
 * @param {string} [repoRoot]
 * @returns {Violation[]}
 */
export function collectCloudHostViolations(cloudRoots, repoRoot = defaultRepoRoot) {
  /** @type {Violation[]} */
  const violations = []
  const root = resolve(repoRoot)
  for (const cloudRoot of cloudRoots) {
    const directory = resolve(cloudRoot)
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue
    for (const file of listSourceFiles(directory)) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of findSpecifiers(source, file)) {
        if (isForbiddenCloudHostSpecifier(specifier.spec)) {
          violations.push({
            file: specifier.file,
            line: specifier.line,
            rule: RULE.appsCloudNoDesktop,
            spec: specifier.spec
          })
          continue
        }
        if (!specifier.spec.startsWith('.')) continue
        const target = resolveRelativeTarget(specifier.file, specifier.spec)
        if (target && isForbiddenCloudHostFile(root, target)) {
          violations.push({
            file: specifier.file,
            line: specifier.line,
            rule: RULE.appsCloudNoDesktop,
            spec: specifier.spec
          })
        }
      }
    }
  }
  return violations
}

export function parseArgs(argv) {
  /** @type {string[]} */
  const roots = []
  let checkBundle = null
  let repoRoot = defaultRepoRoot
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root' && argv[i + 1]) {
      roots.push(resolve(argv[i + 1]))
      i += 1
      continue
    }
    if (arg === '--repo-root' && argv[i + 1]) {
      repoRoot = resolve(argv[i + 1])
      i += 1
      continue
    }
    if (arg === '--check-bundle') {
      checkBundle = argv[i + 1] && !argv[i + 1].startsWith('-')
        ? resolve(argv[++i])
        : join(repoRoot, 'out')
      continue
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true, roots, checkBundle, repoRoot }
    }
  }
  return { help: false, roots, checkBundle, repoRoot }
}

export function run(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const options = parseArgs(argv)
  if (options.help) {
    io.stdout.write('Usage: node scripts/check-core-imports.mjs [--root dir]... [--check-bundle [outDir]]\n')
    return 0
  }
  /** @type {Violation[]} */
  const violations = []
  const packageRoots = options.roots.length > 0 ? options.roots : defaultPackageRoots(options.repoRoot)
  violations.push(...collectViolations(packageRoots))
  if (options.roots.length === 0) {
    violations.push(...collectEngineViolations(defaultEngineRoots(options.repoRoot)))
    violations.push(...collectCloudHostViolations(defaultCloudHostRoots(options.repoRoot), options.repoRoot))
  }
  if (options.checkBundle) {
    violations.push(...collectBundleViolations(options.checkBundle))
  }
  if (violations.length > 0) {
    io.stderr.write(`${formatViolations(violations)}\n`)
    return 1
  }
  const scanned = options.checkBundle
    ? `${packageRoots.length} package(s) + bundle ${relative(options.repoRoot, options.checkBundle) || options.checkBundle}`
    : `${packageRoots.length} package(s)`
  io.stdout.write(`check-core-imports: 0 violations (${scanned})\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = run()
  } catch (error) {
    process.stderr.write(`check-core-imports failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
