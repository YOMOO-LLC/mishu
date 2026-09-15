import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORE_STUB_VERSION,
  collectBundleViolations,
  collectCloudHostViolations,
  collectEngineViolations,
  collectViolations,
  defaultRepoRoot,
  formatViolations,
  run
} from './check-core-imports.mjs'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeWorkspace(): { root: string; core: string; contracts: string; cloud: string; mock: string } {
  const root = mkdtempSync(join(tmpdir(), 'check-core-imports-'))
  directories.push(root)
  const core = join(root, 'packages', 'core')
  const contracts = join(root, 'packages', 'contracts')
  const cloud = join(root, 'packages', 'adapters-cloud')
  const mock = join(root, 'packages', 'adapters-mock')
  mkdirSync(join(core, 'src'), { recursive: true })
  mkdirSync(join(contracts, 'src'), { recursive: true })
  mkdirSync(join(cloud, 'src'), { recursive: true })
  mkdirSync(join(mock, 'src'), { recursive: true })
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@mishu/core', private: true, type: 'module' }))
  writeFileSync(join(contracts, 'package.json'), JSON.stringify({ name: '@mishu/contracts', private: true, type: 'module' }))
  writeFileSync(join(cloud, 'package.json'), JSON.stringify({ name: '@mishu/adapters-cloud', private: true, type: 'module' }))
  writeFileSync(join(mock, 'package.json'), JSON.stringify({ name: '@mishu/adapters-mock', private: true, type: 'module' }))
  return { root, core, contracts, cloud, mock }
}

function write(file: string, source: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, source)
}

function rules(packageRoots: string[]): string[] {
  return collectViolations(packageRoots).map((violation) => `${violation.rule} ${violation.spec}`)
}

describe('check-core-imports', () => {
  it('passes a compliant core and contracts package', () => {
    const { core, contracts } = makeWorkspace()
    write(join(core, 'src/index.ts'), `
import { createHash } from 'node:crypto'
import type { ErrorEnvelope } from '@mishu/contracts'
import { CORE_STUB_VERSION } from './version.ts'
export type { ErrorEnvelope }
void createHash
void CORE_STUB_VERSION
`)
    write(join(core, 'src/version.ts'), `export const CORE_STUB_VERSION = '${CORE_STUB_VERSION}'\n`)
    write(join(contracts, 'src/index.ts'), `
export interface ErrorEnvelope { error: { code: string; message: string } }
import type { Buffer } from 'node:buffer'
export type { Buffer }
`)
    expect(collectViolations([core, contracts])).toEqual([])
  })

  it.each([
    ['electron', "import { app } from 'electron'\n"],
    ['node:sqlite', "import { DatabaseSync } from 'node:sqlite'\n"],
    ['node:fs', "import { readFileSync } from 'node:fs'\n"],
    ['node:fs/promises', "import { readFile } from 'node:fs/promises'\n"],
    ['fs', "import fs from 'fs'\n"],
    ['fs/promises', "import { readFile } from 'fs/promises'\n"],
    ['node:child_process', "import { spawn } from 'node:child_process'\n"],
    ['child_process', "import { spawn } from 'child_process'\n"],
    ['@twilio/voice-sdk', "import { Device } from '@twilio/voice-sdk'\n"],
    ['twilio', "import twilio from 'twilio'\n"],
    ['ws', "import WebSocket from 'ws'\n"],
    ['dotenv', "import dotenv from 'dotenv'\n"],
    ['openai', "import OpenAI from 'openai'\n"]
  ] as const)('catches forbidden value import of %s', (spec, source) => {
    const { core } = makeWorkspace()
    write(join(core, 'src/index.ts'), source)
    expect(rules([core])).toContain(`forbidden-module ${spec}`)
  })

  it('catches escaped relative imports, including type-only imports into src/', () => {
    const { core } = makeWorkspace()
    write(join(core, 'src/index.ts'), `
import { foo } from '../../../src/main/campaign-store.ts'
import type { Campaign } from '../../../src/shared/contracts.ts'
export { bar } from '../../../spikes/cloud-media/protocol/clock.ts'
`)
    const found = rules([core])
    expect(found.filter((entry) => entry.startsWith('escaped-relative '))).toHaveLength(3)
  })

  it('catches dynamic import() and require() of forbidden modules', () => {
    const { core } = makeWorkspace()
    write(join(core, 'src/index.ts'), `
export async function load() {
  await import('electron')
  require('fs')
}
`)
    expect(rules([core])).toEqual([
      'forbidden-module electron',
      'forbidden-module fs'
    ])
  })

  it('catches export-from of a forbidden module', () => {
    const { core } = makeWorkspace()
    write(join(core, 'src/index.ts'), `export { Device } from '@twilio/voice-sdk'\n`)
    expect(rules([core])).toEqual(['forbidden-module @twilio/voice-sdk'])
  })

  it('allows type-only imports of forbidden modules', () => {
    const { core } = makeWorkspace()
    write(join(core, 'src/index.ts'), `
import type { BrowserWindow } from 'electron'
import { type DatabaseSync } from 'node:sqlite'
export type { PathLike } from 'node:fs'
`)
    expect(collectViolations([core])).toEqual([])
  })

  it('still forbids mixed type/value imports of forbidden modules', () => {
    const { core } = makeWorkspace()
    write(join(core, 'src/index.ts'), `import { type BrowserWindow, app } from 'electron'\n`)
    expect(rules([core])).toEqual(['forbidden-module electron'])
  })

  it('ignores forbidden names that only appear in comments', () => {
    const { core } = makeWorkspace()
    write(join(core, 'src/index.ts'), `
// import { app } from 'electron'
/* import fs from 'fs' */
export const ok = true
`)
    expect(collectViolations([core])).toEqual([])
  })

  it('flags contracts depending on @mishu/core', () => {
    const { contracts } = makeWorkspace()
    write(join(contracts, 'src/index.ts'), `import { CORE_STUB_VERSION } from '@mishu/core'\n`)
    expect(rules([contracts])).toEqual(['contracts-depends-on-core @mishu/core'])
  })

  it('flags contracts depending on app or adapter packages', () => {
    const { contracts } = makeWorkspace()
    write(join(contracts, 'src/index.ts'), `
import { PhoneService } from '@mishu/adapters-local'
import type { Router } from 'src/main/http/router.ts'
`)
    expect(rules([contracts])).toEqual([
      'contracts-depends-on-app @mishu/adapters-local',
      'contracts-depends-on-app src/main/http/router.ts'
    ])
  })

  it('prints file:line + rule and exits 1 when the CLI sees a violation', () => {
    const { core } = makeWorkspace()
    write(join(core, 'src/bad.ts'), `import 'dotenv'\n`)
    const stderrChunks: string[] = []
    const code = run(['--root', core], {
      stdout: { write() { return true } },
      stderr: { write(chunk: string) { stderrChunks.push(String(chunk)); return true } }
    } as { stdout: { write: (chunk: string) => boolean }; stderr: { write: (chunk: string) => boolean } })
    expect(code).toBe(1)
    const text = stderrChunks.join('')
    expect(text).toContain('bad.ts:1 forbidden-module dotenv')
    expect(formatViolations(collectViolations([core]), core)).toContain('src/bad.ts:1 forbidden-module dotenv')
  })

  it('exits 0 for the real workspace stubs', () => {
    const stdoutChunks: string[] = []
    const code = run(['--repo-root', defaultRepoRoot], {
      stdout: { write(chunk: string) { stdoutChunks.push(String(chunk)); return true } },
      stderr: { write() { return true } }
    } as { stdout: { write: (chunk: string) => boolean }; stderr: { write: (chunk: string) => boolean } })
    expect(code).toBe(0)
    expect(stdoutChunks.join('')).toContain('0 violations')
  })

  it('allows adapters-cloud to import vendor SDKs and @mishu/core', () => {
    const { cloud } = makeWorkspace()
    write(join(cloud, 'src/index.ts'), `
import WebSocket from 'ws'
import twilio from 'twilio'
import { CORE_STUB_VERSION } from '@mishu/core'
void WebSocket
void twilio
void CORE_STUB_VERSION
`)
    expect(collectViolations([cloud])).toEqual([])
  })

  it('flags electron imports in adapters-cloud', () => {
    const { cloud } = makeWorkspace()
    write(join(cloud, 'src/index.ts'), `import { app } from 'electron'\n`)
    expect(rules([cloud])).toEqual(['forbidden-module electron'])
  })

  it('flags adapters-cloud escaped relative and app path imports into src/ or spikes/', () => {
    const { cloud } = makeWorkspace()
    write(join(cloud, 'src/index.ts'), `
import { foo } from '../../../src/main/campaign-store.ts'
import type { Campaign } from '../../../src/shared/contracts.ts'
export { bar } from '../../../spikes/cloud-media/protocol/clock.ts'
import { PhoneService } from 'src/main/http/router.ts'
`)
    const found = rules([cloud])
    expect(found.filter((entry) => entry.startsWith('escaped-relative '))).toHaveLength(3)
    expect(found).toContain('adapters-depends-on-app src/main/http/router.ts')
  })

  it('allows adapters-mock to import @mishu/core', () => {
    const { mock } = makeWorkspace()
    write(join(mock, 'src/index.ts'), `
import { CORE_STUB_VERSION } from '@mishu/core'
import type { ErrorEnvelope } from '@mishu/contracts'
void CORE_STUB_VERSION
export type { ErrorEnvelope }
`)
    expect(collectViolations([mock])).toEqual([])
  })

  it.each([
    ['electron', "import { app } from 'electron'\n"],
    ['ws', "import WebSocket from 'ws'\n"],
    ['twilio', "import twilio from 'twilio'\n"],
    ['openai', "import OpenAI from 'openai'\n"],
    ['node:net', "import net from 'node:net'\n"],
    ['node:http', "import http from 'node:http'\n"]
  ] as const)('flags adapters-mock vendor or network import of %s', (spec, source) => {
    const { mock } = makeWorkspace()
    write(join(mock, 'src/index.ts'), source)
    expect(rules([mock])).toContain(`forbidden-module ${spec}`)
  })

  it('flags electron in src/main/http and src/main/services including type-only', () => {
    const { root } = makeWorkspace()
    const httpDir = join(root, 'src/main/http')
    const servicesDir = join(root, 'src/main/services')
    mkdirSync(httpDir, { recursive: true })
    mkdirSync(servicesDir, { recursive: true })
    write(join(httpDir, 'router.ts'), `import { ipcMain } from 'electron'\n`)
    write(join(servicesDir, 'phone-service.ts'), `import type { BrowserWindow } from 'electron'\n`)
    const found = collectEngineViolations([httpDir, servicesDir]).map((violation) => `${violation.rule} ${violation.spec}`)
    expect(found).toEqual([
      'src-engine-no-electron electron',
      'src-engine-no-electron electron'
    ])
  })

  it('allows node:sqlite in the engine layer', () => {
    const { root } = makeWorkspace()
    const httpDir = join(root, 'src/main/http')
    mkdirSync(httpDir, { recursive: true })
    write(join(httpDir, 'router.ts'), `import { DatabaseSync } from 'node:sqlite'\n`)
    expect(collectEngineViolations([httpDir])).toEqual([])
  })

  it('flags electron and desktop-host files in apps/cloud, including type-only electron', () => {
    const { root } = makeWorkspace()
    const cloudDir = join(root, 'apps/cloud/src')
    mkdirSync(join(root, 'src/main/http'), { recursive: true })
    mkdirSync(join(root, 'src/main/mcp'), { recursive: true })
    mkdirSync(join(root, 'src/renderer'), { recursive: true })
    mkdirSync(cloudDir, { recursive: true })
    write(join(root, 'src/main/index.ts'), 'export {}\n')
    write(join(root, 'src/main/phone-gateway.ts'), 'export {}\n')
    write(join(root, 'src/main/mcp/desktop-approval-presenter.ts'), 'export {}\n')
    write(join(root, 'src/renderer/App.tsx'), 'export {}\n')
    write(join(root, 'src/main/http/router.ts'), 'export {}\n')
    write(join(cloudDir, 'bad.ts'), `
import type { App } from 'electron'
import { gateway } from '../../../src/main/phone-gateway.ts'
import { desktop } from '../../../src/main/index.ts'
import { presenter } from '../../../src/main/mcp/desktop-approval-presenter.ts'
import { AppUi } from '../../../src/renderer/App.tsx'
void gateway
void desktop
void presenter
void AppUi
`)
    write(join(cloudDir, 'ok.ts'), `import { HttpApiRouter } from '../../../src/main/http/router.ts'\nvoid HttpApiRouter\n`)
    const found = collectCloudHostViolations([join(root, 'apps/cloud')], root).map((violation) => `${violation.rule} ${violation.spec}`)
    expect(found).toEqual(expect.arrayContaining([
      'apps-cloud-no-desktop electron',
      'apps-cloud-no-desktop ../../../src/main/phone-gateway.ts',
      'apps-cloud-no-desktop ../../../src/main/index.ts',
      'apps-cloud-no-desktop ../../../src/main/mcp/desktop-approval-presenter.ts',
      'apps-cloud-no-desktop ../../../src/renderer/App.tsx'
    ]))
    expect(found.some((entry) => entry.includes('http/router'))).toBe(false)
  })

  it('flags a main bundle that still runtime-imports @mishu/', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-core-bundle-'))
    directories.push(root)
    mkdirSync(join(root, 'main'), { recursive: true })
    mkdirSync(join(root, 'preload'), { recursive: true })
    writeFileSync(join(root, 'main/index.js'), `const core = require("@mishu/core");\n`)
    writeFileSync(join(root, 'preload/index.cjs'), `module.exports = {}\n`)
    const found = collectBundleViolations(root).map((violation) => violation.rule)
    expect(found).toContain('bundled-runtime-mishu')
    expect(found).toContain('missing-core-stub')
  })
})
