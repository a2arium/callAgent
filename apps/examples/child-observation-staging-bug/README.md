# Child Observation Staging Bug Reproduction

This example demonstrates a bug in the APLRET framework where child completion observations are not properly staged in `env.inbox.current` when child agents complete synchronously (cache hit).

## The Bug

When a parent agent calls a child agent with `awaitCompletion: false`:

1. **Expected behavior**: Child completes → Framework stages `child.completed` observation in `env.inbox.current` → Parent loop resumes → Perception finds observation → Learning processes it → Policy makes correct decision

2. **Actual behavior (bug)**: Child completes synchronously → Framework resumes parent loop immediately → `env.inbox.current` is empty → Perception finds nothing → Policy makes wrong decision → Agent fails or loops

## Reproduction Steps

1. Run the test: `npm test`
2. Observe the logs:
   - First run: Child completes normally (cache miss)
   - Second run: Child completes synchronously (cache hit) - **BUG REPRODUCED HERE**
   - Look for: `[PERCEPTION] Analyzing inbox` with `inboxCount: 0` and `hasChildCompletion: false`

## Expected Log Output

```
[PERCEPTION] Analyzing inbox { turn: 2, inboxCount: 0, hasChildCompletion: false, childToken: undefined, hasResult: false }
```

This shows the bug: the parent loop resumed after child completion but `env.inbox.current` is empty, so no child completion observation was staged.

## Files

- `ParentAgent.ts` - Parent agent that calls child with `awaitCompletion: false`
- `ChildAgent.ts` - Child agent with caching enabled (causes synchronous completion on second run)
- `test.js` - Test runner that demonstrates the bug
- `parent-agent.json` / `child-agent.json` - Agent configurations

## Running

```bash
npm install
npm run build
npm test
```

## Related Issues

- Framework fails with "Cannot read properties of undefined (reading 'bind')" on synchronous child completions
- Child completion observations not staged in inbox for synchronous completions
