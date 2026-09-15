## Summary

-

## Test plan

- [ ] `git commit -s` (DCO) on every commit in this PR
- [ ] `pnpm check` is green
- [ ] `pnpm test:contract:cloud` is green if `/v1`, campaigns, tasks, webhooks, or `apps/cloud` changed
- [ ] `node scripts/check-core-imports.mjs` reports 0 violations
- [ ] No secrets, tokens, Account SIDs, or real E.164 numbers (examples stay `+1555…`)
- [ ] Shipping code is English only (no CJK in `src/`, `cli/`, `packages/*/src`)
- [ ] Mocks by default; this PR does not place live calls or call paid APIs
- [ ] No change that disables AI disclosure in official builds
