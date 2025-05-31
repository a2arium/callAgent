# Memory System Demo

A simple demonstration of the CallAgent memory system features.

## What This Demo Shows

The `AgentModule.ts` demonstrates:

1. **Entity Alignment** - Automatic alignment of similar entities (names, departments)
2. **Pattern Matching** - Using wildcards (`*`) to find records by key patterns  
3. **String-Based Filters** - Intuitive filter syntax like `'salary > 70000'`

## Key Features Demonstrated

### Entity Alignment
```typescript
// These will be automatically aligned:
name: 'John Smith' ← 'J. Smith'
department: 'Engineering' ← 'Engineering Dept'
```

### Pattern Matching
```typescript
// Find all users with wildcard
await ctx.memory.semantic.getMany('user:*');
```

### String-Based Filters
```typescript
// Much cleaner than object syntax
filters: [
  'salary > 70000',
  'active = true', 
  'department contains "Engineering"',
  'email ends_with "@example.com"'
]
```

## Running the Demo

1. Ensure you have the memory system set up with PostgreSQL and pgvector
2. Configure embedding function for entity alignment
3. Run the agent to see the demo in action

The demo stores 3 user records, demonstrates pattern matching and filtering, and shows entity alignment results. 