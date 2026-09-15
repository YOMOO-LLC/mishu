export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function poll<T, S extends T>(
  read: () => Promise<T>,
  match: (value: T) => value is S,
  options?: { timeoutMs?: number; intervalMs?: number; label?: string }
): Promise<S>
export async function poll<T>(
  read: () => Promise<T>,
  match: (value: T) => boolean,
  options?: { timeoutMs?: number; intervalMs?: number; label?: string }
): Promise<T>
export async function poll<T>(
  read: () => Promise<T>,
  match: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 150
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (match(last)) return last
    await sleep(intervalMs)
  }
  throw new Error(`${options.label ?? 'poll'} timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`)
}
