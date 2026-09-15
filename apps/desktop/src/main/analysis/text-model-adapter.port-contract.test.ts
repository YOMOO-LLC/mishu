import { describeTextModelPortContract } from '@mishu/adapters-mock/contract-tests'
import { MockAnalysisBackend } from './backend.js'
import { AnalysisTextModelAdapter } from './text-model-adapter.js'

describeTextModelPortContract(() =>
  new AnalysisTextModelAdapter(new MockAnalysisBackend(['{"ok":true}']))
)
