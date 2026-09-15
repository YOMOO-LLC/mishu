/** T12.17 TextModel HTTP adapter. Responses transport and hangup judge live here. */
export const ADAPTERS_CLOUD_MODEL_TASK = 'T12.17'

export {
  OPENAI_RESPONSES_URL,
  createOpenAiResponsesTransport,
  createOpenAiTextModelPort,
  extractOutputText,
  extractUsage,
  type OpenAiResponsesTransportOptions,
  type OpenAiResponsesRequest,
  type OpenAiResponsesTransport
} from './model/openai-responses-transport.js'
export { openAiHangupJudge, resolveHangupModel } from './model/hangup-judge.js'
