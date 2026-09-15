import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export function engineFilePath(): string {
  return process.env.CONTRACT_ENGINE_FILE ?? join(tmpdir(), 'kue-t102-contract-engine.json')
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  let pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/mcp')) pathname = `${pathname.slice(0, -4)}/v1`
  else if (!pathname.endsWith('/v1')) pathname = `${pathname}/v1`
  url.pathname = pathname || '/v1'
  return url.toString().replace(/\/$/, '')
}
