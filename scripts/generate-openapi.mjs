import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOpenApiDocument } from '../apps/desktop/src/main/http/openapi.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'docs', 'api', 'openapi.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8')
console.log(`Generated ${output}`)
