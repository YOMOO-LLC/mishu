import { describe, expect, it } from 'vitest'
import { testExclude } from './vitest.config.ts'

describe('vitest workspace collection', () => {
  it('excludes nested node_modules so pnpm workspace symlink tests are not collected twice', () => {
    expect(testExclude.some((pattern) => pattern.includes('**/node_modules/**'))).toBe(true)
  })
})
