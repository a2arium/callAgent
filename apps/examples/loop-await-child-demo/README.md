# Loop Await Child Demo

This minimal example reproduces the `await_child` inbox regression. The parent agent
dispatches a cached child agent with `awaitCompletion: false` and expects the
child's completion payload to appear in `env.inbox.current` on the next turn.

Steps:

1. `ParentAgent` loads a URL from task input. If no HTML is present in its
   working memory it calls the cached `ChildAgent` with `awaitCompletion: false`.
2. The child immediately returns a large HTML payload (either from cache or by
   synthesising it) and the parent transitions with `{ kind: 'await_child' }`.
3. On the resume turn the parent expects to find a `child.completed` observation
   in `env.inbox.current`. Prior to the runtime fix this inbox was empty,
   proving the regression.

To run the parent agent after building:

```bash
yarn workspace loop-await-child-demo build
yarn callagent run apps/examples/loop-await-child-demo/dist/LoopAwaitChildDemoParentAgent.js '{"url":"https://example.com/demo"}'
```

Run the command twice to ensure the child result is served from cache on the
second attempt. The parent logs both inbox contents and the observed HTML
status so it is easy to verify the bug and the eventual fix.

