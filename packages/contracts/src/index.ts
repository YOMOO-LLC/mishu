/** Public HTTP error envelope (ADR-0001 invariant 9). Desktop IPC types stay in src/shared/contracts.ts. */
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type ErrorBody = ErrorEnvelope['error']

/** Repo-relative OpenAPI path. A string constant so this package does not import outside its directory. */
export const OPENAPI_SPEC_PATH = 'docs/api/openapi.json'

/** Repo-relative foundation draft path. */
export const FOUNDATION_DRAFT_PATH = 'docs/api/drafts/foundation-v1.draft.json'
