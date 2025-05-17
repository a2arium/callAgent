# Memory Usage Example

This example demonstrates how to use the memory adapter in the CallAgent framework. The agent sets a value, retrieves it, and performs queries by tag and by filter.

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
- Setting a value in memory with tags
- Getting a value by key
- Querying by tag
- Querying by JSON field filter

The agent replies with the results of each operation. 