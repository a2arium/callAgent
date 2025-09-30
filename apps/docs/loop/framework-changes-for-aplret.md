# Framework Changes Required for A-P-L-R-E-T Stage Dispatcher Architecture

**Status**: Implementation Plan  
**Related**: [A-P-L-R-E-T Stage Dispatcher Architecture](./aplret-stage-dispatcher.md)

## Overview

This document outlines the framework changes needed to fully support the production-ready A-P-L-R-E-T Stage Dispatcher architecture. Most patterns are **already possible** with the current framework, but some enhancements would make them easier and more standardized.

**Note**: This version has **minimal breaking changes** (only 2 breaking changes for Shield and Trace).

### Summary

- ✅ **80% Already Supported**: Core A-P-L-R-E-T loop, typed actions, ctx.vars, shield, rewards
- 🔧 **2 Breaking Changes**: Shield outcome types, trace always-on
- ✅ **Non-breaking Enhancements**: Effect safety (two-tier approach), stage invariants

---

## What Already Works ✅

### 1. Typed Intent System (ProposedAction)

**Status**: ✅ Fully supported

The framework already has discriminated union types for `ProposedAction`:

```typescript
// From packages/core/src/loop/oneTurn.ts
export type ProposedAction =
  | { kind: 'ask_user'; prompt: string; schema?: unknown }
  | { kind: 'subagent'; target: string; input: unknown; awaitCompletion?: boolean }
  | { kind: 'tool'; name: string; args: unknown; awaitCallback?: boolean }
  | { kind: 'language'; content: string }
  | { kind: 'internal'; intent: string; data?: unknown };
```

**No changes needed.**

### 2. Stage Dispatcher Pattern (ctx.vars)

**Status**: ✅ Fully supported

`ctx.vars` already has a type-safe API. **No changes needed.**

### 3. Module Contracts (A-P-L-R-E-T)

**Status**: ✅ Fully supported

All six modules are already defined. **No changes needed.**

### 4. Resume Contract

**Status**: ✅ Fully supported

The framework already handles `await_input`, `await_tool`, `await_child`. **No changes needed.**

### 5. M (MentalState) and ctx.vars Separation

**Status**: ✅ Fully supported

- `M` is exposed as `ctx.M` (readonly view)
- `ctx.vars` is writable
- Learning receives M and returns new M (immutable pattern)

**No changes needed.**

### 6. Reward Hooks

**Status**: ✅ Fully supported

Both `extrinsicReward` and `intrinsicReward` are already implemented. **No changes needed.**

---

## What Needs Enhancement 🔧

### 1. Effect Safety (Two-Tier Approach)

**Status**: ✅ Non-breaking enhancement

**Philosophy:**

1. **LLM calls** (`ctx.llm.call`) → **Already safe** (calllm library handles timeouts/retries internally)
2. **Framework methods** (`ctx.reply`, `ctx.tools`) → **Safe by default** (internal `withSafety` wrapper)
3. **Agent external calls** (fetch, database, custom APIs) → **Opt-in safety** via `runEffect()`

---

#### Tier 1: Framework Methods (Internally Safe)

**These methods get automatic timeout/retry protection:**

```typescript
// Framework adds safety transparently - agents use normally
await ctx.llm.call(message);
await ctx.reply(text);
await ctx.tools.invoke(toolName, args);
await ctx.requestInput(prompt);
```

**Implementation (internal helper):**

```typescript
// Add to packages/core/src/loop/effectSafety.ts (INTERNAL ONLY)
type SafetyOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
};

async function withSafety<T>(
  fn: () => Promise<T>,
  opts: SafetyOptions = {}
): Promise<T> {
  const {
    timeoutMs = 30000,
    maxRetries = 2,
    retryDelayMs = 1000
  } = opts;
  
  let lastError: Error;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Timeout wrapper
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        )
      ]);
    } catch (error) {
      lastError = error as Error;
      
      // Check if retryable
      const isRetryable = ['ECONNRESET', 'ETIMEDOUT', 'RATE_LIMIT', '429', '503']
        .some(pattern => lastError.message.includes(pattern));
      
      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }
      
      // Exponential backoff
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * retryDelayMs));
    }
  }
  
  throw lastError!;
}
```

**Update method implementations (framework internal):**

```typescript
// ctx.llm.call - NO CHANGE NEEDED
// calllm library already handles timeouts/retries internally
// Just use it as-is

// In TaskContext.reply
async reply(parts: string | MessagePart[]): Promise<void> {
  return withSafety(
    () => this.underlyingReply(parts),
    { timeoutMs: 5000, maxRetries: 1 }
  );
}

// In TaskContext.tools.invoke
async invoke<T>(toolName: string, args: unknown): Promise<T> {
  return withSafety(
    () => this.underlyingToolsInvoke(toolName, args),
    { timeoutMs: 60000, maxRetries: 2 }
  );
}
```

**Default safety settings:**

```typescript
// Framework defaults (configurable per method)
const FRAMEWORK_SAFETY_DEFAULTS = {
  // llm: not needed - calllm handles internally
  reply: { timeoutMs: 5000, maxRetries: 1, retryDelayMs: 1000 },
  tools: { timeoutMs: 60000, maxRetries: 2, retryDelayMs: 1000 },
  requestInput: { timeoutMs: 300000, maxRetries: 0 }  // 5 min, no retry
};
```

**Agents don't change anything:**

```typescript
execution: async (a, ctx, m) => {
  // ✅ Just use normally - framework adds safety automatically
  const result = await ctx.llm.call('What is AI?');
  await ctx.reply(result[0].content);
}
```

---

#### Tier 2: External Calls (Explicit Safety via runEffect)

**For agent's own external calls, expose `runEffect()`:**

```typescript
// Add to packages/core/src/loop/effects.ts (PUBLIC API)
export type EffectOptions = {
  timeoutMs?: number;       // Default: 30000
  maxRetries?: number;      // Default: 2
  retryDelayMs?: number;    // Default: 1000
  retryableErrors?: string[];  // Custom patterns
};

/**
 * Wrap external async calls with timeout/retry protection.
 * Use this for fetch(), database calls, external APIs, etc.
 * 
 * Framework methods (ctx.llm, ctx.reply, ctx.tools) are already safe.
 * 
 * @example
 * const data = await runEffect(
 *   () => fetch('https://api.example.com').then(r => r.json()),
 *   { timeoutMs: 10000, maxRetries: 3 }
 * );
 */
export async function runEffect<T>(
  fn: () => Promise<T>,
  opts: EffectOptions = {}
): Promise<T> {
  const {
    timeoutMs = 30000,
    maxRetries = 2,
    retryDelayMs = 1000,
    retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'RATE_LIMIT', '429', '503']
  } = opts;
  
  let lastError: Error;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout exceeded')), timeoutMs)
        )
      ]);
    } catch (error) {
      lastError = error as Error;
      
      const isRetryable = retryableErrors.some(pattern =>
        lastError.message.includes(pattern)
      );
      
      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }
      
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * retryDelayMs));
    }
  }
  
  throw lastError!;
}
```

**Agent usage:**

```typescript
import { runEffect } from '@a2arium/callagent-core/loop/effects';

execution: async (a, ctx, m) => {
  // ✅ Framework methods - use directly (already safe)
  await ctx.reply('Fetching external data...');
  
  // ✅ External API - wrap with runEffect()
  const apiData = await runEffect(
    () => fetch('https://api.example.com/data').then(r => r.json()),
    { timeoutMs: 10000, maxRetries: 3 }
  );
  
  // ✅ Database query - wrap with runEffect()
  const dbRecord = await runEffect(
    () => database.query('SELECT * FROM users WHERE id = ?', [userId]),
    { timeoutMs: 5000, maxRetries: 1 }
  );
  
  // ✅ Custom service - wrap with runEffect()
  const processed = await runEffect(
    () => externalService.process(apiData),
    { 
      timeoutMs: 60000,
      retryableErrors: ['SERVICE_UNAVAILABLE', 'RATE_LIMIT']
    }
  );
  
  // ✅ Framework method - already safe
  await ctx.reply(`Result: ${processed}`);
  
  return { kind: 'internal', done: true };
}
```

**Impact**: 
- ✅ **Non-breaking**: Framework methods unchanged
- ✅ **Opt-in**: Agents wrap external calls when needed
- ✅ **Simple API**: Just wrap your async function
- ✅ **Flexible**: Custom timeout/retry per call
- ✅ **Trust framework**: ctx.llm, ctx.reply, etc. are safe by default

---

### 2. Shield Outcome Types (ShieldOutcome)

**Status**: 🔧 Breaking change required

**Current signature:**

```typescript
shield: (m: MentalState, a: ProposedAction) => ProposedAction | null
```

**Problems:**
- Returns `null` → veto (but no reason)
- No way to distinguish "defer to user" from "veto"
- Implicit pass/transform

**Breaking Change:**

```typescript
// Add to packages/core/src/loop/oneTurn.ts
export type ShieldOutcome =
  | { action: 'pass'; intent: ProposedAction }
  | { action: 'transform'; intent: ProposedAction; reason?: string }
  | { action: 'veto'; reason: string }
  | { action: 'defer'; askUser: string };

export type Modules = {
  // ... other modules
  shield: (m: MentalState, a: ProposedAction) => ShieldOutcome;
};
```

**Update `oneTurn.ts` handler:**

```typescript
const shieldOutcome = mods.shield(m1, chosen);

// Log decision
ctx.trace.append({
  turn: env.turn || 0,
  module: 'shield',
  event: shieldOutcome.action,
  data: { reason: shieldOutcome.action === 'veto' ? shieldOutcome.reason : undefined }
});

// Handle outcome
let safeAction: ProposedAction | null;
switch (shieldOutcome.action) {
  case 'pass':
  case 'transform':
    safeAction = shieldOutcome.intent;
    break;
  case 'veto':
    console.warn(`[Shield] Vetoed: ${shieldOutcome.reason}`);
    safeAction = null;
    break;
  case 'defer':
    safeAction = { kind: 'ask_user', prompt: shieldOutcome.askUser };
    break;
}
```

**Required agent updates:**

```typescript
// All agents must update shield
shield: (m, a): ShieldOutcome => {
  if (containsPII(a)) {
    return { action: 'veto', reason: 'PII_DETECTED' };
  }
  
  if (estimateCost(a) > m.reward.budget) {
    return {
      action: 'defer',
      askUser: `Action costs ${estimateCost(a)}. Proceed?`
    };
  }
  
  return { action: 'pass', intent: a };
}
```

**Impact**: 
- ⚠️ **BREAKING**: All agents must update shield
- ✅ Explicit decisions with reasons
- ✅ Better observability

---

### 3. Event Tracing (Always On)

**Status**: 🔧 Breaking change - trace always present

**Current:** `ctx.trace` is optional, needs null checks

**Breaking Change:** Make `ctx.trace` always present

```typescript
// Add to packages/core/src/loop/traceability.ts
export type TraceEvent = {
  timestamp: number;
  turn: number;
  module: 'attention' | 'perception' | 'learning' | 'policy' | 'shield' | 'execution' | 'transition';
  event: string;
  data?: Record<string, unknown>;
  latencyMs?: number;
  success?: boolean;
  error?: Error;
};

export class TraceLog {
  private events: TraceEvent[] = [];
  private maxSize: number;
  
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }
  
  append(event: Omit<TraceEvent, 'timestamp'>): void {
    this.events.push({ ...event, timestamp: Date.now() });
    if (this.events.length > this.maxSize) this.events.shift();
  }
  
  getEvents(): TraceEvent[] {
    return [...this.events];
  }
  
  query(filter: Partial<TraceEvent>): TraceEvent[] {
    return this.events.filter(e =>
      Object.entries(filter).every(([k, v]) => (e as any)[k] === v)
    );
  }
  
  export(): string {
    return JSON.stringify(this.events, null, 2);
  }
}

// Update TaskContext
declare module '../shared/types/index.js' {
  interface TaskContext {
    trace: TraceLog;  // Always present
  }
}
```

**Update `TaskEngine.createContext()`:**

```typescript
const ctx = {
  // ... existing properties ...
  trace: new TraceLog(1000)  // Always initialized
};
```

**Integrate into `oneTurn()` - log all modules:**

```typescript
export async function oneTurn(ctx, env, mPrev, mods, prevAction, rPrev) {
  const trace = ctx.trace;  // No null check
  const turn = env.turn || 0;
  
  // Log each module automatically
  const tA = Date.now();
  const alpha = mods.attention(mPrev, env);
  trace.append({ turn, module: 'attention', event: 'signal', latencyMs: Date.now() - tA });
  
  const tP = Date.now();
  const o = mods.perception(env, alpha);
  trace.append({ turn, module: 'perception', event: 'observed', latencyMs: Date.now() - tP });
  
  // ... same for learning, policy, shield, execution, transition
}
```

**Required agent updates:**

```typescript
// Remove null checks
execution: async (a, ctx, m) => {
  // ❌ Old
  // if (ctx.trace) { ctx.trace.append(...); }
  
  // ✅ New (always safe)
  ctx.trace.append({ turn: 0, module: 'execution', event: 'custom' });
}
```

**Impact**: 
- ⚠️ **BREAKING**: Remove all `if (ctx.trace)` checks
- ✅ All turns automatically logged
- ✅ Better observability
- ⚠️ Small performance overhead (~1-2%)

---

### 4. Stage Invariant Validation (Optional)

**Status**: ✅ Non-breaking addition

**Add helper for stage validation:**

```typescript
// Add to packages/core/src/loop/stageInvariants.ts
export type StageInvariant = {
  required?: string[];
  forbidden?: string[];
  validate?: (ctx: TaskContext) => void;
};

export type StageInvariants<TStage extends string> = Record<TStage, StageInvariant>;

export function assertStageInvariants<TStage extends string>(
  ctx: TaskContext,
  stage: TStage,
  invariants: StageInvariants<TStage>
): void {
  const inv = invariants[stage];
  if (!inv) return;
  
  if (inv.required) {
    for (const key of inv.required) {
      if (!ctx.vars.has(key)) {
        throw new Error(`[StageInvariant] ${stage} requires ctx.vars.${key}`);
      }
    }
  }
  
  if (inv.forbidden) {
    for (const key of inv.forbidden) {
      if (ctx.vars.has(key)) {
        throw new Error(`[StageInvariant] ${stage} forbids ctx.vars.${key}`);
      }
    }
  }
  
  if (inv.validate) inv.validate(ctx);
}
```

**Agent usage (optional):**

```typescript
import { assertStageInvariants, type StageInvariants } from '@a2arium/callagent-core/loop/stageInvariants';

type Stage = 'idle' | 'awaiting_input' | 'executing';

const invariants: StageInvariants<Stage> = {
  idle: { forbidden: ['token'] },
  awaiting_input: { required: ['token'] },
  executing: {}
};

const V = {
  setStage: (ctx, s) => {
    assertStageInvariants(ctx, s, invariants);
    ctx.vars.set('stage', s);
  }
};
```

**Impact**: 
- ✅ **Non-breaking**: Opt-in
- ✅ Runtime validation for stages

---

### 5. ExecutableAction Type Fix

**Status**: ✅ Bug fix (non-breaking)

**Add missing cases:**

```typescript
export type ExecutableAction =
  | { kind: 'ask_user'; token: string }
  | { kind: 'subagent'; token?: string; result?: unknown }  // ✅ Add
  | { kind: 'tool'; token?: string; result?: unknown }
  | { kind: 'language'; echoed: boolean }
  | { kind: 'internal'; done: boolean };  // ✅ Add
```

---

## Implementation Priority

### Phase 1: Type Fixes (1 day)

1. Fix `ExecutableAction` type
2. Add `ShieldOutcome` types
3. Update `Modules` type

### Phase 2: Effect Safety (1-2 days, internal only)

4. Implement `withSafety()` helper (internal)
5. Add to `ctx.reply()`
6. Add to `ctx.tools.invoke()`
7. Implement `runEffect()` (public API for external calls)

### Phase 3: Tracing Infrastructure (2-3 days)

9. Implement `TraceLog` class
10. Add `trace` to TaskContext (required)
11. Integrate tracing into `oneTurn()`
12. Update `createContext()`

### Phase 4: Stage Validation (1 day, optional)

13. Implement `StageInvariants` helpers
14. Add examples

### Phase 5: Migration & Documentation (2 days)

15. Migration guide
16. Update example agents
17. API docs

**Total: 7-9 days**

---

## Migration Strategy

### Breaking Changes Summary

⚠️ **Only 2 breaking changes**:

1. **Shield signature change**:
   ```typescript
   // ❌ Old
   shield: (m, a) => a  // or return null
   
   // ✅ New (required)
   shield: (m, a): ShieldOutcome => ({ action: 'pass', intent: a })
   ```

2. **Trace is always present**:
   ```typescript
   // ❌ Old
   if (ctx.trace) { ctx.trace.append(...); }
   
   // ✅ New (required)
   ctx.trace.append(...);  // Always safe
   ```

**Effect safety is non-breaking:**
- Framework methods (ctx.llm, ctx.reply) are automatically safe
- External calls can opt-in to `runEffect()`

### Migration Steps

#### Step 1: Update Shield (Required)

```typescript
shield: (m, a): ShieldOutcome => {
  if (containsPII(a)) return { action: 'veto', reason: 'PII_DETECTED' };
  return { action: 'pass', intent: a };
}
```

#### Step 2: Remove Trace Null Checks (Required)

```typescript
// Just remove the if statement
ctx.trace.append({ ... });
```

#### Step 3: Wrap External Calls (Optional)

```typescript
import { runEffect } from '@a2arium/callagent-core/loop/effects';

// Wrap external APIs, database calls, etc.
const data = await runEffect(
  () => fetch('https://api.example.com').then(r => r.json()),
  { timeoutMs: 10000 }
);
```

### Automated Migration

```bash
npx @a2arium/callagent-migrate --version 2.0 --path ./apps/examples
```

Handles:
- ✅ Shield signature conversion
- ✅ Trace null check removal

---

## Testing Requirements

### Unit Tests
- `runEffect()` timeout/retry logic
- `ShieldOutcome` exhaustive matching
- `assertStageInvariants()` validation
- `TraceLog` query/export

### Integration Tests
- Framework method safety (internal)
- External call safety via `runEffect()`
- Shield veto with reason logging
- Trace events across full turn

### Breaking Changes Validation
- ❌ Old shield signature fails TypeScript
- ✅ `ctx.trace` never undefined
- ✅ All example agents compile

---

## File Checklist

### New Files
- [ ] `packages/core/src/loop/effectSafety.ts` - withSafety helper (internal)
- [ ] `packages/core/src/loop/effects.ts` - runEffect (public API)
- [ ] `packages/core/src/loop/stageInvariants.ts` - Stage validation
- [ ] `packages/core/src/loop/traceability.ts` - TraceLog

### Modified Files
- [ ] `packages/core/src/loop/oneTurn.ts` - ShieldOutcome, tracing
- [ ] `packages/core/src/core/orchestration/taskEngine.ts` - Initialize trace, add withSafety to reply/tools
- [ ] `packages/core/src/index.ts` - Export runEffect

---

## Summary

### What's Already Supported (80%)

✅ Typed intents (ProposedAction)  
✅ Stage dispatcher (ctx.vars)  
✅ Module contracts (A-P-L-R-E-T)  
✅ Resume contract (await_*)  
✅ M vs ctx.vars separation  
✅ Reward hooks  

### What's Changing (20%)

#### Breaking Changes (2)
🔧 Shield → `ShieldOutcome` (required)  
🔧 Trace always present (required)  

#### Non-Breaking Enhancements
✅ Effect safety (two-tier: internal + runEffect)  
✅ Stage invariants (optional)  
✅ ExecutableAction fix  

### Migration Impact

**Estimated effort per agent**: 15-20 minutes
- Shield update: 10-15 minutes
- Trace cleanup: 5 minutes

**Total migration**: ~5-7 hours for 20 agents

**Framework implementation**: 7-9 days

### Benefits

✅ **Clean API**: Framework methods stay unchanged  
✅ **Safety by default**: ctx.llm (via calllm), ctx.reply, ctx.tools are safe  
✅ **Opt-in external safety**: runEffect() for custom calls  
✅ **Better observability**: Always-on tracing  
✅ **Explicit decisions**: Shield reasons tracked  
✅ **Minimal breaking changes**: Only 2 required updates  

### Key Design Decision

**Three-tier effect safety** gives us the best of both worlds:
1. **LLM calls** → Already safe (calllm library handles it)
2. **Framework methods** → Safe by default (internal withSafety)
3. **Agent external calls** → Opt-in safety (runEffect)

This avoids the complexity of wrapping everything while still providing safety where it matters, and respects that calllm already has robust safety built-in!
