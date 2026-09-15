export {
  DECISION_STRICTNESS,
  TENANT_ID,
  type AllowedPacket,
  type CallerContext,
  type Clock,
  type DisclosureDecision,
  type DisclosureResult,
  type ExpectedOutcome,
  type HighFrequencyFact,
  type KnowledgeField,
  type KnowledgeItem,
  type KnowledgeKind,
  type QueryInferFn,
  type QuestionCategory,
  type RetrievedHit,
  type ScriptedQuestion,
  type SensitiveCategory,
  type TrustFixture,
  type TrustLevel,
  type Visibility,
  type WithheldRef
} from './knowledge/types.js'
export {
  chineseBigrams,
  englishWords,
  isStopword,
  normalizeText,
  significantQueryTokens,
  tokenize,
  type LexicalTokens
} from './knowledge/normalize.js'
export {
  createRetriever,
  toHitMap,
  type KnowledgeRetriever,
  type RetrieverOptions
} from './knowledge/retrieve.js'
export {
  classifyVisibility,
  disclose,
  matrixCells,
  matrixDecision
} from './knowledge/disclose.js'
export {
  APPEND_TOKEN_LIMIT,
  estimateTokens,
  INSTRUCTIONS_TOKEN_BUDGET,
  truncateToTokenBudget
} from './knowledge/tokens.js'
export {
  appendTokenCount,
  boundAppendContent,
  neutralizeInjection,
  wrapReferenceData,
  wrapSpeakableInstruction,
  type BoundedAppend
} from './knowledge/wrap-reference.js'
export {
  compileHighFrequencyInstructions,
  type CompiledInstructions
} from './knowledge/compile-instructions.js'
export { defaultQueryInfer, inferQueryFromTranscripts } from './knowledge/infer-query.js'
export type {
  KnowledgeIndexEntry,
  KnowledgeSelector,
  SelectorError,
  SelectorInput,
  SelectorResult,
  SelectorSource,
  SelectorUsage
} from './knowledge/selector.js'
