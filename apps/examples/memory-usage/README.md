# Memory Usage Example

This example demonstrates comprehensive memory usage in the CallAgent framework, including basic operations, advanced querying, and pattern matching capabilities.

## Running the Example

From the repository root:

```bash
yarn turbo run dev --filter=apps/examples/memory-usage
```

Or, from this directory:

```bash
yarn dev
```

## What It Demonstrates

### Basic Memory Operations
- Setting values in memory with structured keys and tags
- Getting values by key
- Querying by tag
- Querying by JSON field filters

### Pattern Matching (SQL Backend Only)
- **Key wildcards**: Find all keys matching a pattern like `user:*:profile`
- **Advanced patterns**: Use both `*` (multiple characters) and `?` (single character) wildcards
- **Structured key queries**: Efficiently find related data using key hierarchies

### Pattern Matching Examples
- `user:*:profile` - Find all user profiles
- `user:123:*` - Find all data for a specific user
- `config:*` - Find all configuration entries
- `user:???:*` - Find users with 3-character IDs (advanced pattern)

### Alternative Approaches
The example also demonstrates tag-based querying as a more portable alternative to pattern matching, which works across all memory backend types.

## Key Features Highlighted

1. **Structured Keys**: Using hierarchical keys like `user:123:profile` for logical organization
2. **Pattern Matching**: Leveraging wildcards for bulk operations and related data discovery
3. **Tag-Based Organization**: Using tags for cross-cutting concerns and categorization
4. **Filter Queries**: Advanced JSON field filtering with various operators
5. **Backend Compatibility**: Graceful handling when pattern matching isn't available

The agent demonstrates both the power of structured memory access and the importance of choosing the right approach for your use case. 