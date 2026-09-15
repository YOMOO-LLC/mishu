import { parseHostArgs, startCloudHost } from './host.js'

function printHelp(): void {
  process.stderr.write(
    'Usage: mishu-cloud [--data-dir <path>] [--port <n>]\n' +
      'Headless /v1 reference host. Prints one ready JSON line with baseUrl and tokenFile.\n' +
      'The bearer token is written to tokenFile (mode 0600) and is never printed.\n'
  )
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return
  }
  const host = await startCloudHost(parseHostArgs(argv))
  const stop = (): void => {
    void host.stop().finally(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.stdout.write(`${JSON.stringify(host.ready)}\n`)
}

void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
