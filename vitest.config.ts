import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

/** Keep nested node_modules excluded; replacing defaults with node_modules/** only skipped the repo root. */
export const testExclude = [...configDefaults.exclude, 'tests/e2e/**', 'apps/desktop/tests/e2e/**', 'out/**', 'apps/desktop/out/**']

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mishu\/contracts$/, replacement: resolve('packages/contracts/src/index.ts') },
      { find: /^@mishu\/core\/(.*)$/, replacement: `${resolve('packages/core/src')}/$1.ts` },
      { find: /^@mishu\/core$/, replacement: resolve('packages/core/src/index.ts') },
      { find: /^@mishu\/adapters-cloud\/(.*)$/, replacement: `${resolve('packages/adapters-cloud/src')}/$1.ts` },
      { find: /^@mishu\/adapters-cloud$/, replacement: resolve('packages/adapters-cloud/src/index.ts') },
      { find: /^@mishu\/adapters-mock\/(.*)$/, replacement: `${resolve('packages/adapters-mock/src')}/$1.ts` },
      { find: /^@mishu\/adapters-mock$/, replacement: resolve('packages/adapters-mock/src/index.ts') }
    ]
  },
  test: {
    exclude: testExclude
  }
})
