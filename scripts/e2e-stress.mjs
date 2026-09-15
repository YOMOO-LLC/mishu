import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const options = parseArgs(process.argv.slice(2))
const runs = [
  ...Array.from({ length: options.mcp }, (_, index) => ({ kind: 'MCP', iteration: index + 1 })),
  ...Array.from({ length: options.full }, (_, index) => ({ kind: 'full', iteration: index + 1 }))
]
const results = []

for (const run of runs) {
  const args = ['exec', 'playwright', 'test']
  if (run.kind === 'MCP') args.push('--grep', 'MCP')
  const startedAt = performance.now()
  const result = await execute('pnpm', args)
  const durationSeconds = (performance.now() - startedAt) / 1_000
  const output = `${result.stdout}\n${result.stderr}`
  const teardownTimeouts = countMatches(output, /Test timeout of 30000ms exceeded[\s\S]{0,800}application\.close\(\)/g)
    + countMatches(output, /Worker teardown timeout of 30000ms exceeded/g)
  const durationLimitExceeded = run.kind === 'full' && durationSeconds > 90
  const entry = {
    ...run,
    durationSeconds,
    durationLimitExceeded,
    teardownTimeouts,
    exitCode: result.exitCode
  }
  results.push(entry)
  process.stdout.write(
    `[e2e-stress] ${run.kind} ${run.iteration}: ${result.exitCode === 0 ? 'PASS' : 'FAIL'} `
      + `${durationSeconds.toFixed(1)}s, teardown timeouts=${teardownTimeouts}\n`
  )
  if (durationLimitExceeded) process.stdout.write('[e2e-stress] full-run limit exceeded: 90.0s\n')
  if (result.exitCode !== 0) process.stdout.write(output)
}

const failures = results.filter(({ exitCode, durationLimitExceeded }) => exitCode !== 0 || durationLimitExceeded).length
const teardownTimeouts = results.reduce((total, result) => total + result.teardownTimeouts, 0)
process.stdout.write(`[e2e-stress] summary: ${runs.length - failures}/${runs.length} passed, teardown timeouts=${teardownTimeouts}\n`)
process.exitCode = failures === 0 && teardownTimeouts === 0 ? 0 : 1

function parseArgs(args) {
  const parsed = { mcp: 10, full: 3 }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag !== '--mcp' && flag !== '--full') throw new Error(`Unknown argument: ${flag}`)
    const value = Number.parseInt(args[index + 1] ?? '', 10)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`)
    parsed[flag.slice(2)] = value
    index += 1
  }
  return parsed
}

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }))
  })
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length
}
