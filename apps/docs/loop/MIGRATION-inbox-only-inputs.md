# Migration Guide: Inbox-Only Input System

## Overview

This guide explains how to migrate your agents from the legacy dual-input system (`env.input` + `env.inbox.current`) to the new unified inbox-only architecture where **all inputs flow through `env.inbox.current` as observations**.

## What Changed

### Before (Legacy)
```typescript
export type EnvironmentState = {
    time: string;
    input: unknown;              // ❌ REMOVED
    inbox: ObservationInbox;
    // ... other fields
};
```

Agents had to check both places:
```typescript
perception: (env) => {
    // Initial input came from env.input
    const initialInput = env.input;
    
    // Resumed input came from inbox
    const resumedInput = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    
    return { input: initialInput || resumedInput };
}
```

### After (Inbox-Only)
```typescript
export type EnvironmentState = {
    time: string;
    // input field removed
    inbox: ObservationInbox;
    // ... other fields
};
```

All inputs now flow through inbox:
```typescript
perception: (env) => {
    // ALL inputs (initial and resumed) come from inbox
    const userInput = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    
    return { input: userInput?.payload?.value };
}
```

## Why This Change?

### Architectural Consistency
The APLRET framework emphasizes that **everything flows through observations**. The dual-path system violated this principle by treating initial inputs differently from resumed inputs.

### Simplified Agent Code
- **Before**: Check both `env.input` and `env.inbox.current`
- **After**: Single, consistent check of `env.inbox.current`

### Better Turn Semantics
All inputs become part of the observation flow, making turn-based execution more predictable.

## Migration Steps

### 1. Update Perception Module

**Before:**
```typescript
perception: (env: EnvironmentState) => {
    // Check env.input for initial input
    if (env.input) {
        return { payload: env.input };
    }
    
    // Check inbox for resumed input
    const userObs = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    if (userObs) {
        return { payload: userObs.payload.value };
    }
    
    return {};
}
```

**After:**
```typescript
perception: (env: EnvironmentState) => {
    // Single, unified check for all user inputs
    const userInput = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    
    return { 
        payload: userInput?.payload?.value 
    };
}
```

### 2. Update Attention Module (if using env.input)

**Before:**
```typescript
attention: (m, env) => ({
    hasInput: Boolean(env.input)
})
```

**After:**
```typescript
attention: (m, env) => ({
    hasInput: env.inbox.current.length > 0
})
```

### 3. Remove Direct env.input References

Search your codebase for `env.input` and replace with inbox checks:

```bash
# Find all references
grep -r "env\.input" your-agent-directory/
```

## Common Patterns

### Pattern 1: Simple Input Extraction
```typescript
perception: (env: EnvironmentState) => {
    const userInput = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    return { text: userInput?.payload?.value as string };
}
```

### Pattern 2: Structured Input
```typescript
perception: (env: EnvironmentState) => {
    const userInput = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    const inputValue = userInput?.payload?.value as { 
        caseId?: string; 
        mode?: string 
    };
    
    return {
        caseId: inputValue?.caseId,
        mode: inputValue?.mode
    };
}
```

### Pattern 3: Distinguishing Initial vs Resumed Input

Initial inputs have a special `token` value:
```typescript
perception: (env: EnvironmentState) => {
    const userInput = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    
    const isInitialInput = userInput?.payload?.token === 'initial-input';
    
    return {
        input: userInput?.payload?.value,
        isInitial: isInitialInput
    };
}
```

### Pattern 4: Handling Multiple Observation Types
```typescript
perception: (env: EnvironmentState) => {
    // User input
    const userInput = env.inbox.current.find(o => 
        o.source === 'user' && o.kind === 'input.provided'
    );
    
    // Tool result
    const toolResult = env.inbox.current.find(o => 
        o.source === 'tool' && o.kind === 'tool.completed'
    );
    
    // Child completion
    const childResult = env.inbox.current.find(o => 
        o.source === 'child' && o.kind === 'child.completed'
    );
    
    return {
        userInput: userInput?.payload?.value,
        toolResult: toolResult?.payload?.result,
        childResult: childResult?.payload?.result
    };
}
```

## Observation Structure

All inputs now follow the same observation structure:

```typescript
{
    source: 'user',
    kind: 'input.provided',
    payload: {
        token: 'initial-input',  // or token from requestInput
        value: { /* your input data */ }
    },
    provenance: {
        ts: number,
        turn: number,
        id: string,
        toolId: string,
        correlationId: string
    }
}
```

### Initial CLI Input
```typescript
{
    source: 'user',
    kind: 'input.provided',
    payload: {
        token: 'initial-input',
        value: { caseId: 'case-1' }  // Your CLI input
    }
}
```

### Resumed Input (from requestInput)
```typescript
{
    source: 'user',
    kind: 'input.provided',
    payload: {
        token: 'abc-123-def',  // Token from requestInput
        value: 'user response'
    }
}
```

## Testing Your Migration

### 1. Check Initial Input Flow
```bash
# Run your agent with CLI input
yarn run run path/to/agent.ts '{"caseId":"test-1"}'

# Verify perception receives input from inbox
```

### 2. Check Resumed Input Flow
```typescript
// In your test
const result = await engine.startTask({ 
    task: { id: 'test', input: { caseId: 'test-1' } } 
});

// Verify the agent processes input correctly
expect(perceptionReceived).toBeDefined();
```

### 3. Verify Type Safety
```bash
# TypeScript should catch any remaining env.input references
yarn tsc --noEmit
```

## Troubleshooting

### Issue: Agent Not Receiving Initial Input

**Problem:** Perception returns empty/undefined

**Solution:** Ensure you're checking inbox for user observations:
```typescript
const userInput = env.inbox.current.find(o => 
    o.source === 'user' && o.kind === 'input.provided'
);
```

### Issue: Type Errors After Migration

**Problem:** TypeScript errors about `env.input` not existing

**Solution:** Remove all `env.input` references and use inbox pattern

### Issue: Input Payload Structure Mismatch

**Problem:** Input data not where expected

**Solution:** Remember input is nested in `payload.value`:
```typescript
// Before: env.input.caseId
// After:  userInput?.payload?.value.caseId
```

## Benefits After Migration

✅ **Architectural Consistency**: All inputs flow through observations  
✅ **Simplified Code**: Single pattern for all input types  
✅ **Better Debugging**: All inputs visible in inbox history  
✅ **Type Safety**: Unified observation types  
✅ **Future-Proof**: Easy to extend for new input sources  

## Need Help?

If you encounter issues during migration:

1. Check the examples in `apps/examples/` for reference implementations
2. Review the APLRET documentation for inbox patterns
3. Ensure all loop-first agents use `runMode: 'loop'` in manifest
4. Verify perception module extracts from inbox, not env.input

## Related Documentation

- [APLRET Dev Instructions](./aplret-dev-instructions.md) - Complete framework guide
- [Loop Overview](./overview.md) - Loop architecture explained
- [Durable Handlers](../durable-handlers-and-persistence.md) - Auto-resume flow

