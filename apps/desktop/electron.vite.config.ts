import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const desktopRoot = import.meta.dirname
const workspaceRoot = resolve(desktopRoot, '../..')

const mishuWorkspacePackages = [
  '@mishu/core',
  '@mishu/contracts',
  '@mishu/adapters-cloud',
  '@mishu/adapters-mock'
]

const mishuAliases = [
  { find: /^@mishu\/contracts$/, replacement: resolve(workspaceRoot, 'packages/contracts/src/index.ts') },
  { find: /^@mishu\/core\/(.*)$/, replacement: `${resolve(workspaceRoot, 'packages/core/src')}/$1.ts` },
  { find: /^@mishu\/core$/, replacement: resolve(workspaceRoot, 'packages/core/src/index.ts') },
  { find: /^@mishu\/adapters-cloud\/(.*)$/, replacement: `${resolve(workspaceRoot, 'packages/adapters-cloud/src')}/$1.ts` },
  { find: /^@mishu\/adapters-cloud$/, replacement: resolve(workspaceRoot, 'packages/adapters-cloud/src/index.ts') },
  { find: /^@mishu\/adapters-mock\/(.*)$/, replacement: `${resolve(workspaceRoot, 'packages/adapters-mock/src')}/$1.ts` },
  { find: /^@mishu\/adapters-mock$/, replacement: resolve(workspaceRoot, 'packages/adapters-mock/src/index.ts') }
]

function mishuExternalizePlugin() {
  return externalizeDepsPlugin({ exclude: mishuWorkspacePackages })
}

export default defineConfig({
  main: {
    plugins: [mishuExternalizePlugin()],
    resolve: { alias: mishuAliases }
  },
  preload: {
    plugins: [mishuExternalizePlugin()],
    resolve: { alias: mishuAliases },
    build: {
      rollupOptions: {
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: [
        { find: '@renderer', replacement: resolve(desktopRoot, 'src/renderer') },
        { find: '@shared', replacement: resolve(desktopRoot, 'src/shared') },
        ...mishuAliases
      ]
    },
    plugins: [react()]
  }
})
