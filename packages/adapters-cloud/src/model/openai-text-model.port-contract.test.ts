import { describeTextModelPortContract } from '@mishu/adapters-mock/contract-tests'
import { createOpenAiTextModelPort } from './openai-responses-transport.js'

function fakeResponses(): Response {
  return new Response(JSON.stringify({ output_text: '{"ok":true}' }), { status: 200 })
}

describeTextModelPortContract(() =>
  createOpenAiTextModelPort({
    apiKey: 'sk-fake-not-a-real-key',
    url: 'https://example.test/v1/responses',
    defaultModel: 'gpt-5.6-luna',
    fetch: async () => fakeResponses()
  })
)
