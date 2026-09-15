import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { JsonSchema } from './types.js'

const NO_SCHEMA_CANONICAL_VALUE = 'null'
const MAX_SCHEMA_LENGTH = 50_000

export function schemaHash(schema?: JsonSchema): string {
  const canonical = schema === undefined ? NO_SCHEMA_CANONICAL_VALUE : stableStringify(schema)
  if (canonical.length > MAX_SCHEMA_LENGTH) {
    throw new Error(`result_schema cannot exceed ${MAX_SCHEMA_LENGTH} characters`)
  }
  return createHash('sha256').update(canonical).digest('hex')
}

export function compileResultSchema(schema: JsonSchema): z.ZodType {
  assertSupportedSchema(schema)
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch (error) {
    throw new Error(`result_schema is invalid: ${message(error)}`)
  }
}

export function assertSupportedSchema(schema: JsonSchema): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('result_schema must be a JSON Schema object')
  }
  const type = schema.type
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'))
  if (!isObject) throw new Error('result_schema top-level type must be object')
  findUnsupportedReference(schema)
}

export function missingResultFor(schema: JsonSchema): Record<string, null> {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []
  return Object.fromEntries(required.map((name) => [name, null]))
}

function findUnsupportedReference(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) findUnsupportedReference(item)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && !child.startsWith('#/')) {
      throw new Error('result_schema does not support external $ref')
    }
    findUnsupportedReference(child)
  }
}

function stableStringify(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('result_schema contains a non-serializable value')
    return encoded
  }
  if (seen.has(value)) throw new Error('result_schema must not contain circular references')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], seen)}`)
      .join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
