import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'contract',
    include: ['tests/contract/**/*.contract.ts'],
    exclude: [...configDefaults.exclude],
    globalSetup: ['tests/contract/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
    reporters: ['verbose']
  }
})
