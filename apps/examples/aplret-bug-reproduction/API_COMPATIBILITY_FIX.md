# API Compatibility Fix for ctx.vars

## Issue

After implementing the bug fixes for memory persistence, users reported an error in production:

```
Error: ctx.vars.get is not a function
at readVar (file://.../packages/core/dist/loop/stageHelpers.js:6:35)
```

## Root Cause

The `attachWorkingMemory()` method (used when resuming parent agents after A2A calls) was creating a **Proxy** object for `ctx.vars`, while `startTask()` creates an **object with methods** (`.get()`, `.set()`, etc.).

This inconsistency broke framework code like `stageHelpers.ts` which expects `ctx.vars.get()` to be available.

### Code Comparison

**startTask() - CORRECT API:**
```typescript
(ctx as any).vars = {
    get: (key: string) => varCache.get(key),
    set: (key: string, value: unknown) => { ... },
    merge: (patch: Record<string, unknown>) => { ... },
    update: (key: string, fn: Function) => { ... },
    delete: (key: string) => { ... },
    keys: () => Array.from(varCache.keys()),
    has: (key: string) => varCache.has(key)
};
```

**attachWorkingMemory() - BROKEN (Proxy):**
```typescript
(ctx as any).vars = new Proxy({}, {
    get: (_t, prop: string) => varCache.get(prop),
    set: (_t, prop: string, value: unknown) => { ... },
    // ❌ No .get() method! Only property access via Proxy
});
```

## The Fix

Changed `attachWorkingMemory()` to create the **same object-based API** as `startTask()`:

```typescript
// ✅ FIX: Use the same API as startTask() - object with methods, not Proxy
(ctx as any).vars = {
    get: (key: string) => {
        if (key.includes('.')) {
            // Handle nested paths
            const baseKey = key.split('.')[0];
            const baseObj = varCache.get(baseKey) as Record<string, unknown>;
            // ... traverse path ...
        }
        return varCache.get(key);
    },
    set: (key: string, value: unknown) => { ... },
    merge: (patch: Record<string, unknown>) => { ... },
    update: (key: string, fn: Function) => { ... },
    delete: (key: string) => { ... },
    keys: () => Array.from(varCache.keys()),
    has: (key: string) => { ... }
} as any;
```

## Impact

### Before Fix
- ❌ `ctx.vars.get('stage')` - Error in A2A resume
- ❌ `stageHelpers.setStage()` - Broken
- ❌ Any framework code using `ctx.vars` methods - Broken after A2A

### After Fix
- ✅ `ctx.vars.get('stage')` - Works everywhere
- ✅ `stageHelpers.setStage()` - Works correctly
- ✅ Consistent API across all code paths
- ✅ A2A parent resume works with all framework helpers

## Files Modified

**packages/core/src/core/orchestration/taskEngine.ts**
- `attachWorkingMemory()` method (lines 175-302)
- Changed from Proxy to object-based API
- Now matches `startTask()` implementation

## Testing

The fix ensures:
1. ✅ Bug reproduction agent still works
2. ✅ Production agents using `stageHelpers` work after A2A
3. ✅ All `ctx.vars` methods available in all contexts
4. ✅ No breaking changes to user code

## Related Issues

This fix complements the memory persistence fixes:
- Bug #1: Memory vars persistence (6 sub-issues)
- Bug #2: Multiple A2A calls support
- **This issue**: API consistency between startTask and attachWorkingMemory

All three are now resolved! ✅

