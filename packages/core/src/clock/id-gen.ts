export interface IdGen {
  id(): string
}

/** Default IdGen. Uses the platform crypto.randomUUID (node:crypto in Node). */
export const systemIdGen: IdGen = {
  id: () => globalThis.crypto.randomUUID()
}
