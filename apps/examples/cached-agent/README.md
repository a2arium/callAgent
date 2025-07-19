# Cached Agent Example

This example demonstrates the **agent result caching** functionality of the CallAgent framework. The agent simulates expensive operations with artificial processing delays to showcase the performance benefits of caching.

## Features Demonstrated

- ✅ **TTL-based caching** (60-second cache expiration)
- ✅ **Path exclusions** (certain fields don't affect cache keys)
- ✅ **Tenant isolation** (cache entries are scoped by tenant)
- ✅ **Automatic cache cleanup** (expired entries are removed)
- ✅ **Performance monitoring** (execution time and cost tracking)

## Agent Configuration

```json
{
    "cache": {
        "enabled": true,
        "ttlSeconds": 60,
        "excludePaths": ["timestamp", "requestId", "user.sessionId"]
    }
}
```

### Cache Settings Explained

- **`enabled: true`** - Activates result caching for this agent
- **`ttlSeconds: 60`** - Cache entries expire after 60 seconds
- **`excludePaths`** - These fields are ignored when generating cache keys:
  - `timestamp` - Current timestamp won't affect caching
  - `requestId` - Unique request IDs won't affect caching
  - `user.sessionId` - User session changes won't affect caching

## Running the Example

### Basic Operations

```bash
# Build the example
yarn build

# Run with complex calculation (3-second processing time)
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "complex-calculation",
    "data": "sample data"
}'

# Run the SAME operation again - should return instantly from cache!
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "complex-calculation", 
    "data": "sample data"
}'
```

### Testing Path Exclusions

These commands will produce the same cache key (and hit the cache) because excluded fields are ignored:

```bash
# First execution - will be slow
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "data-analysis",
    "timestamp": "2024-01-01T10:00:00Z",
    "requestId": "req-123"
}'

# Second execution - will be FAST (cache hit) despite different timestamp/requestId
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "data-analysis",
    "timestamp": "2024-01-01T11:00:00Z",
    "requestId": "req-456"
}'
```

### Different Operations

Try these different operations to see various processing times:

```bash
# Image processing (8 seconds, $22.75)
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "image-processing"
}'

# Text generation (4 seconds, $12.00)  
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "text-generation"
}'

# Data analysis (5 seconds, $15.25)
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "data-analysis"
}'
```

### Multi-tenant Testing

Test tenant isolation by running with different tenant IDs:

```bash
# Tenant A - first execution (slow)
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "complex-calculation"
}' --tenant=customer-a

# Tenant B - first execution (slow, separate cache)  
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "complex-calculation"
}' --tenant=customer-b

# Tenant A - second execution (fast, cache hit)
yarn run-agent apps/examples/cached-agent/dist/AgentModule.js '{
    "operation": "complex-calculation"  
}' --tenant=customer-a
```

## Cache Management

Use the built-in cache management CLI:

```bash
# View cache statistics
yarn cache stats

# Clean up expired entries
yarn cache cleanup

# Clear cache for this agent
yarn cache clear --agent=cached-agent

# Clear cache for specific tenant
yarn cache clear --tenant=customer-a

# Clear cache for agent in specific tenant
yarn cache clear --agent=cached-agent --tenant=customer-a
```

## Understanding Cache Behavior

### Cache Key Generation

The cache key is generated from the input data using SHA-256 hashing. Here's how it works:

1. **Object Key Sorting**: Object keys are recursively sorted for consistent hashing
2. **Path Exclusion**: Specified paths are removed before hashing
3. **SHA-256 Hash**: Final cache key is a SHA-256 hash of the processed input

```typescript
// These inputs produce the SAME cache key:
const input1 = {
    operation: "test",
    data: "sample",
    timestamp: "2024-01-01T10:00:00Z"  // excluded
};

const input2 = {
    data: "sample",
    operation: "test", 
    timestamp: "2024-01-01T11:00:00Z"  // excluded, different value
};
```

### Cache Hit vs Miss

- **Cache Hit**: Input matches existing cache entry, returns instantly
- **Cache Miss**: No matching cache entry, executes agent logic
- **Cache Expiry**: Entry exists but expired, executes agent logic and updates cache

### Performance Benefits

| Operation | Processing Time | Cost | Cache Benefit |
|-----------|----------------|------|---------------|
| complex-calculation | 3 seconds | $10.50 | 3000ms saved |
| data-analysis | 5 seconds | $15.25 | 5000ms saved |
| image-processing | 8 seconds | $22.75 | 8000ms saved |
| text-generation | 4 seconds | $12.00 | 4000ms saved |

## Architecture Notes

### Cache Storage

- **Backend**: PostgreSQL via Prisma
- **Table**: `agent_result_cache`
- **Indexes**: Optimized for tenant, agent, and expiration queries
- **Isolation**: Complete tenant separation

### Cache Lifecycle

1. **Check**: Before agent execution, check for valid cache entry
2. **Execute**: If no cache hit, execute agent logic
3. **Store**: Store result in cache with TTL
4. **Cleanup**: Background service removes expired entries
5. **Evict**: Manual cache management via CLI

### Error Handling

- Database errors don't prevent agent execution
- Cache failures are logged but don't interrupt workflow
- Graceful degradation when cache is unavailable

## Best Practices

### When to Use Caching

✅ **Good candidates for caching:**
- Expensive LLM operations
- Complex calculations
- Data processing tasks
- API calls to external services
- Database queries with stable results

❌ **Avoid caching for:**
- Operations with side effects
- Real-time data requirements
- User-specific personalized results
- Operations with large result sizes

### Cache Configuration Tips

1. **TTL Selection**: Balance between performance and freshness
   - Short TTL (30-60s): Fast-changing data
   - Medium TTL (5-15 minutes): Semi-stable data  
   - Long TTL (1+ hours): Stable computations

2. **Path Exclusions**: Exclude fields that don't affect results
   - Timestamps
   - Request IDs
   - Session identifiers
   - Tracking metadata

3. **Monitoring**: Use cache statistics to optimize configuration
   - High miss rate: Consider longer TTL
   - Large cache size: Consider shorter TTL or exclusions

## Related Examples

- [Memory Usage Example](../memory-usage/README.md) - Memory operations
- [LLM Agent Example](../llm-agent/README.md) - LLM integration
- [A2A Demo](../a2a-local-demo/README.md) - Agent-to-agent communication 