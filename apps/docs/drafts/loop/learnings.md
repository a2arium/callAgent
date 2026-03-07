# Agent Development Learnings

## ⚠️ Cognitive Module Signatures — Get the Arity Right!

**Problem**: When writing agent modules (`perception`, `learning`, `policy`, `execution`, `transition`), it's easy to use the wrong number of parameters. JavaScript/TypeScript won't warn you — it silently ignores extra arguments. Your module will run without errors but receive the wrong data, causing subtle loops or silent failures.

**What happened**: The `learning` module was written as `(prev, obs)`, but `oneTurn.ts` calls it as `learning(mPrev, prevAction, o, ...)`. So `obs` actually received `prevAction` (always empty), not the perception output. The agent looped forever because it could never see tool results.

### Correct Signatures Reference

These are the **actual call signatures** from `oneTurn.ts` — match your parameters to these:

```typescript
// perception(env, alpha, mem, llm)
perception: (env, alpha?, mem?, llm?) => { ... }

// learning(mPrev, prevAction, o, mem, writer, rPrev, llm)
learning: (mPrev, prevAction, obs, mem?, writer?, rPrev?, llm?) => { ... }
//                            ^^^ THIS is the perception output, NOT the 2nd arg!

// policy(m1, mPrev?, o?, mem?, llm?)  — arity-adaptive, see below
policy: (m) => { ... }                    // 1-arg: just mental state
policy: (m, mem, llm) => { ... }          // 3-arg: + memory + llm
policy: (m, o, mem, llm) => { ... }       // 4-arg: + observation
policy: (m, mPrev, o, mem, llm) => { ... } // 5-arg: + previous state

// execution(proposedAction, ctx, mem, m)
execution: (action, ctx, mem?, m?) => { ... }

// transition(env, exec, m, mem, llm)
transition: (env, exec, m?, mem?, llm?) => { ... }
```

### Key Rule

> **Always check `oneTurn.ts` for the actual call order before writing a module.**
> Never assume from the parameter name — `learning(prev, obs)` looks correct but is wrong because `prevAction` sits between them.
