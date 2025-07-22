# Multi-Tenant Memory System

## Overview

The CallAgent framework provides comprehensive multi-tenant memory isolation, allowing multiple customers, organizations, or applications to use the same agent instances while maintaining complete data separation. This document covers the implementation, configuration, and usage of the multi-tenant memory system.

> **Note:** Multi-tenant isolation applies to both long-term memory (semantic/episodic) and the new **Working Memory & Cognitive Context API**. See [Working Memory API](./working-memory-api.md) for details on tenant-aware cognitive state management.

## Benefits

### 🏢 Business Benefits
- **Cost Efficiency**: Single deployment serves multiple tenants
- **Operational Simplicity**: Centralized management with isolated data
- **Scalability**: Easy tenant onboarding without infrastructure changes
- **Compliance**: Built-in data isolation for regulatory requirements

### 🔧 Technical Benefits
- **Complete Data Isolation**: No cross-tenant data access possible
- **Transparent Operation**: Existing code works without modification
- **Flexible Configuration**: Multiple tenant resolution strategies
- **Performance**: Efficient database queries with tenant-scoped indexes

### 🛡️ Security Benefits
- **Zero Trust Architecture**: Tenant context embedded at every level
- **No Data Leakage**: Memory operations automatically scoped
- **Audit Trail**: All operations include tenant context for logging
- **Entity Isolation**: Entity alignment per tenant prevents cross-contamination
- **Agent-to-Agent Isolation**: Tenant context automatically propagated in agent invocations

## Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        CA[Customer A Agent]
        CB[Customer B Agent] 
        CC[Customer C Agent]
    end
    
    subgraph "Core Framework"
        TR[Tenant Resolver]
        PE[Plugin Engine]
        TE[Task Engine]
    end
    
    subgraph "Memory Layer"
        MA[Memory Adapter]
        SQL[(SQL Database)]
    end
    
    subgraph "Data Storage"
        TA[(Tenant A Data)]
        TB[(Tenant B Data)]
        TC[(Tenant C Data)]
    end
    
    CA -->|tenantId: customer-a| TR
    CB -->|tenantId: customer-b| TR
    CC -->|tenantId: customer-c| TR
    
    TR --> PE
    PE --> TE
    TE --> MA
    
    MA -->|WHERE tenant_id = 'customer-a'| TA
    MA -->|WHERE tenant_id = 'customer-b'| TB  
    MA -->|WHERE tenant_id = 'customer-c'| TC
    
    TA --> SQL
    TB --> SQL
    TC --> SQL
```

## Quick Start Guide

### 1. Basic Agent Creation

```typescript
import { createAgent } from '@a2arium/core';

// Agent with explicit tenant ID
const customerAgent = createAgent({
    name: 'customer-service',
    version: '1.0.0',
    tenantId: 'customer-123',  // Explicit tenant
    
    handler: async (ctx) => {
        // All memory operations are automatically scoped to 'customer-123'
        await ctx.memory.semantic.set('user-preference', { theme: 'dark' });
        const preferences = await ctx.memory.semantic.get('user-preference');
        
        await ctx.reply(`Loaded preferences for tenant: ${ctx.tenantId}`);
    }
});

// Agent that accepts runtime tenant specification
const multiTenantAgent = createAgent({
    name: 'universal-service',
    version: '1.0.0',
    // No tenantId specified - will be resolved at runtime
    
    handler: async (ctx) => {
        const tenantId = ctx.tenantId; // Resolved from context
        await ctx.reply(`Serving tenant: ${tenantId}`);
    }
});
```

### 2. Running with Different Tenants

```bash
# Using CLI with different tenants
yarn core:run agent.js '{}' --tenant=customer-123
yarn core:run agent.js '{}' --tenant=enterprise-456
yarn core:run agent.js '{}' --tenant=startup-789

# Using environment variable
CALLAGENT_TENANT_ID=customer-123 yarn core:run agent.js '{}'

# Default tenant (when no tenant specified)
yarn core:run agent.js '{}'  # Uses 'default' tenant
```

### 3. Programmatic Usage

```typescript
import { StreamingRunner } from '@a2arium/core';

const runner = new StreamingRunner();

// Run for specific tenant
await runner.run('./agent.js', {}, {
    tenantId: 'customer-123',
    streaming: false
});

// Environment-based tenant
process.env.CALLAGENT_TENANT_ID = 'enterprise-456';
await runner.run('./agent.js', {}, {
    streaming: false
});
```

## Configuration Options

### Tenant Resolution Hierarchy

The system resolves tenant IDs using the following priority order:

1. **CLI Argument**: `--tenant=<tenant-id>`
2. **Streaming Options**: `{ tenantId: 'tenant-id' }`
3. **Agent Configuration**: `createAgent({ tenantId: 'tenant-id' })`
4. **Environment Variable**: `CALLAGENT_TENANT_ID`
5. **Default**: `'default'`

### Environment Variables

```bash
# Primary tenant configuration
CALLAGENT_TENANT_ID=production-tenant-123

# Database configuration (shared across tenants)
DATABASE_URL=postgresql://user:pass@localhost:5432/callagent

# Memory configuration
MEMORY_BACKEND=sql
MEMORY_DEFAULT_LIMIT=1000

# Logging configuration
LOG_LEVEL=info
```

### Agent Configuration

```typescript
interface CreateAgentOptions {
    name: string;
    version: string;
    tenantId?: string;           // Optional explicit tenant
    description?: string;
    handler: (ctx: TaskContext) => Promise<void>;
}

interface TaskContext {
    tenantId: string;            // Always present, resolved tenant ID
    task: TaskInfo;
    memory: MemoryRegistry;      // All operations auto-scoped
    // ... other context properties
}
```

## Memory Operations

### Automatic Tenant Scoping

All memory operations are automatically scoped to the current tenant:

```typescript
async function demonstrateMemoryScoping(ctx: TaskContext) {
    const tenantId = ctx.tenantId; // e.g., 'customer-123'
    
    // Store data - automatically scoped to tenant
    await ctx.memory.semantic.set('user:alice', {
        name: 'Alice Johnson',
        role: 'admin'
    });
    
    // Retrieve data - only from current tenant
    const user = await ctx.memory.semantic.get('user:alice');
    
    // Pattern matching - scoped to tenant
    const allUsers = await ctx.memory.semantic.getMany('user:*');
    
    // Tag-based queries - scoped to tenant
    const admins = await ctx.memory.semantic.getMany({ tag: 'admin' });
    
    // Filtered queries - scoped to tenant
    const activeUsers = await ctx.memory.semantic.getMany({
        filters: [{ path: 'active', operator: '=', value: true }]
    });
    
    // All results are automatically limited to current tenant's data
}
```

### Pattern Matching

Pattern matching operations respect tenant boundaries:

```typescript
// These patterns only match data within the current tenant
await ctx.memory.semantic.getMany('user:*');        // All users in tenant
await ctx.memory.semantic.getMany('config:*');      // All config in tenant  
await ctx.memory.semantic.getMany('session:2023*'); // 2023 sessions in tenant
```

### Entity Alignment

Entity alignment operates within tenant scope:

```typescript
await ctx.memory.semantic.set('meeting:1', {
    organizer: 'Alice Johnson',
    location: 'Conference Room A'
}, {
    entities: {
        organizer: 'person',
        location: 'location'
    }
});

// Entity alignment happens within tenant context
// 'Alice Johnson' entities are separate across tenants
```

## Advanced Features

### Dynamic Tenant Switching

The framework provides advanced tenant context management for complex scenarios:

```typescript
import { withTenant, withSystemPrivileges, getCurrentTenant } from '@a2arium/core';

async function advancedTenantOperations(ctx: TaskContext) {
    const currentTenant = getCurrentTenant(); // Get current tenant
    console.log('Current tenant:', currentTenant);
    
    // Temporarily switch to another tenant for specific operations
    await withTenant('customer-456', async () => {
        // All memory operations in this block use 'customer-456'
        const otherTenantData = await ctx.memory.semantic.get('config');
        console.log('Data from customer-456:', otherTenantData);
    });
    
    // Back to original tenant context
    console.log('Back to tenant:', getCurrentTenant());
    
    // System-level operations (admin use only)
    await withSystemPrivileges(async () => {
        // Can access cross-tenant data with special syntax
        const systemData = await ctx.memory.semantic.get('customer-123:config');
        console.log('System access to customer-123 config:', systemData);
    });
}
```

### System Tenant Operations

For administrative operations, the system tenant (`__system__`) provides cross-tenant access:

```typescript
// System tenant can query across tenants using tenant:key syntax
async function systemOperations(ctx: TaskContext) {
    // Must be running with system tenant privileges
    if (ctx.tenantId === '__system__') {
        // Access any tenant's data
        const customerAConfig = await ctx.memory.semantic.get('customer-a:config');
        const customerBUsers = await ctx.memory.semantic.getMany('customer-b:user:*');
        
        // Cross-tenant pattern matching
        const allConfigs = await ctx.memory.semantic.getMany('*:config');
        
        console.log('System admin view of all tenants');
    }
}
```

### Tenant Metrics and Monitoring

Track tenant-specific usage and performance:

```typescript
import { tenantMetricsManager, trackTenantOperation } from '@a2arium/core';

async function monitoredOperations(ctx: TaskContext) {
    // Automatic operation tracking
    await trackTenantOperation(ctx.tenantId, 'memory.set', {
        key: 'user:123',
        dataSize: 1024
    });
    
    // Get tenant metrics
    const metrics = await tenantMetricsManager.getTenantMetrics(ctx.tenantId);
    console.log('Tenant metrics:', {
        operationCounts: metrics.operationCounts,
        memoryUsage: metrics.memoryUsage,
        performance: metrics.performance
    });
    
    // Get all tenant statistics (system admin only)
    const allStats = await tenantMetricsManager.getAllTenantStats();
    console.log('System-wide tenant usage:', allStats);
}
```

### Tenant Validation and Security

Built-in validation ensures tenant ID integrity:

```typescript
import { validateTenantId, isSystemTenant } from '@a2arium/core';

async function secureOperations(tenantId: string) {
    // Validate tenant ID format and permissions
    validateTenantId(tenantId); // Throws if invalid
    
    // Check for system tenant
    if (isSystemTenant(tenantId)) {
        console.log('System tenant detected - enhanced privileges available');
    }
    
    // Tenant IDs are automatically validated at:
    // - Agent creation time
    // - CLI parsing
    // - Memory operations
    // - Context switching
}
```


## Best Practices

### 🎯 Tenant Strategy

**Choose the Right Approach:**
- **Explicit Tenant IDs**: For SaaS applications with clear tenant boundaries
- **Environment Variables**: For deployment-based tenant separation
- **Runtime Resolution**: For dynamic multi-tenant scenarios
- **Default Tenant**: For single-tenant applications

**Naming Conventions:**
```typescript
// Good tenant ID patterns
'customer-123'          // Customer-based
'org-acme-corp'        // Organization-based  
'env-production'       // Environment-based
'region-us-east-1'     // Region-based
'default'              // Default tenant

// Avoid special characters that might cause issues
'customer_123'         // Underscores OK
'customer.123'         // Avoid dots
'customer@123'         // Avoid special chars
```

### 🔧 Development Workflow

**Local Development:**
```bash
# Use consistent tenant for development
export CALLAGENT_TENANT_ID=dev-local

# Or use CLI override for testing
yarn dev --tenant=test-scenario-1
```

**Testing:**
```typescript
// Test with multiple tenants
describe('Multi-tenant scenarios', () => {
    test('tenant isolation', async () => {
        // Test tenant A
        await runner.run(agent, {}, { tenantId: 'test-tenant-a' });
        
        // Test tenant B 
        await runner.run(agent, {}, { tenantId: 'test-tenant-b' });
        
        // Verify no data leakage between tenants
    });
});
```

**Production Deployment:**
```bash
# Set tenant via environment in production
CALLAGENT_TENANT_ID=prod-customer-123 node dist/agent.js

# Or use container-level configuration
docker run -e CALLAGENT_TENANT_ID=customer-123 callagent/app
```

### 📊 Monitoring and Logging

**Log Tenant Context:**
```typescript
// Tenant information is automatically included in logs
await ctx.logger.info('Processing user request', {
    tenantId: ctx.tenantId,
    userId: 'user-123'
});

// Use structured logging for better observability
await ctx.logger.info('Memory operation', {
    operation: 'set',
    key: 'user:123',
    tenantId: ctx.tenantId,
    dataSize: JSON.stringify(data).length
});
```

**Metrics Collection:**
```typescript
// Track tenant-specific metrics
await ctx.recordUsage('memory.set', {
    tenantId: ctx.tenantId,
    backend: 'sql',
    keyPattern: key.split(':')[0] // e.g., 'user', 'config'
});
```

### 🗄️ Data Management

**Key Naming Strategy:**
```typescript
// Use hierarchical keys for better organization
`config:${tenantId}:app-settings`
`user:${userId}:preferences`
`session:${sessionId}:state`
`cache:${feature}:${key}`

// Avoid tenant ID in keys (it's handled automatically)
// Good: 'user:123'
// Bad:  'tenant-123:user:123' (redundant)
```

**Tag Strategy:**
```typescript
// Use consistent tagging for queries
await ctx.memory.semantic.set(key, data, {
    tags: [
        'user',                    // Entity type
        'active',                  // Status
        department.toLowerCase(),   // Department
        'v2'                       // Schema version
    ]
});
```

## Security Considerations

### 🔒 Data Isolation

**Automatic Protection:**
- All SQL queries include `WHERE tenant_id = ?` clauses
- Memory operations cannot access other tenants' data
- Pattern matching is scoped to tenant context
- Entity alignment operates within tenant boundaries

**Validation:**
```typescript
// Tenant IDs are validated at multiple levels
function validateTenantId(tenantId: string): void {
    if (!tenantId || tenantId.trim() === '') {
        throw new Error('Tenant ID must be a non-empty string');
    }
    // Additional validation as needed
}
```

### 🛡️ Access Control

**Runtime Checks:**
```typescript
// The framework automatically ensures tenant context
async function secureOperation(ctx: TaskContext, key: string) {
    // No need for manual tenant checks - automatically scoped
    const data = await ctx.memory.semantic.get(key);
    
    // This will only return data from ctx.tenantId
    return data;
}
```

**Audit Logging:**
```typescript
// All operations include tenant context for auditing
await ctx.logger.info('Data access', {
    operation: 'get',
    key: key,
    tenantId: ctx.tenantId,
    userId: ctx.task.input.userId,
    timestamp: new Date().toISOString()
});
```

### 🔐 Configuration Security

**Environment Variables:**
```bash
# Secure tenant configuration
CALLAGENT_TENANT_ID=production-tenant-123

# Avoid sensitive data in tenant IDs
# Good: 'customer-123'
# Bad:  'customer-secret-api-key-123'
```

**Database Security:**
```sql
-- Ensure proper indexing for tenant queries
CREATE INDEX idx_memory_tenant_key ON agent_memory_store(tenant_id, key);
CREATE INDEX idx_entities_tenant ON entity_store(tenant_id);
CREATE INDEX idx_alignment_tenant ON entity_alignment(tenant_id);

-- Consider row-level security policies
ALTER TABLE agent_memory_store ENABLE ROW LEVEL SECURITY;
```

## Troubleshooting

### Common Issues

#### 1. Data Not Found

**Problem:** Data stored in one session not found in another
```bash
# Session 1
yarn run agent --tenant=customer-123  # Data stored

# Session 2  
yarn run agent --tenant=customer-456  # Data not found
```

**Solution:** Verify tenant consistency
```typescript
// Check current tenant in handler
async handler(ctx: TaskContext) {
    console.log('Current tenant:', ctx.tenantId);
    
    // Verify data with explicit tenant check
    const data = await ctx.memory.semantic.get(key);
    console.log('Found data:', !!data);
}
```

#### 2. Environment Variable Issues

**Problem:** `CALLAGENT_TENANT_ID` not being recognized

**Solution:** Check environment variable loading
```bash
# Verify environment variable is set
echo $CALLAGENT_TENANT_ID

# Check if it's loaded in the application
node -e "console.log('Tenant:', process.env.CALLAGENT_TENANT_ID)"
```

#### 3. CLI Argument Not Working

**Problem:** `--tenant` flag not being parsed

**Solution:** Verify CLI usage
```bash
# Correct format
yarn core:run agent.js '{}' --tenant=customer-123

# Common mistakes
yarn core:run agent.js --tenant=customer-123 '{}'  # Wrong order
yarn core:run agent.js '{}' --tenant customer-123  # Missing =
```

#### 4. Mixed Tenant Data

**Problem:** Seeing data from multiple tenants

**Solution:** Check for shared state or caching
```typescript
// Ensure no global state between runs
beforeEach(() => {
    // Clear any caches or global state
    clearGlobalCache();
});

// Verify tenant resolution
const resolvedTenant = resolveTenantId(explicitTenant);
console.log('Resolved tenant:', resolvedTenant);
```

### Debugging

#### Enable Debug Logging

```bash
# Enable detailed logging
LOG_LEVEL=debug yarn core:run agent.js '{}' --tenant=customer-123
```

#### Verify Database Queries

```typescript
// Check what SQL queries are being generated
// (Available in debug logs)
await ctx.memory.semantic.get('test-key');

// Look for queries like:
// SELECT * FROM agent_memory_store WHERE tenant_id = $1 AND key = $2
```

#### Check Tenant Resolution

```typescript
import { resolveTenantId } from '@a2arium/core';

// Test tenant resolution manually
console.log('Explicit:', resolveTenantId('explicit-tenant'));
console.log('Environment:', resolveTenantId()); // Uses CALLAGENT_TENANT_ID
console.log('Default:', resolveTenantId('')); // Should be 'default'
```

### Performance Optimization

#### Database Indexes

The framework includes optimized database indexes for tenant-scoped queries. Run the optimization script:

```bash
# Apply performance optimizations
psql -d your_database -f packages/memory-sql/scripts/optimize-tenant-queries.sql
```

Key indexes created:

```sql
-- Critical indexes for performance
CREATE INDEX CONCURRENTLY idx_memory_tenant_key 
    ON agent_memory_store(tenant_id, key);

CREATE INDEX CONCURRENTLY idx_memory_tenant_updated_at
    ON agent_memory_store(tenant_id, updated_at DESC);

CREATE INDEX CONCURRENTLY idx_memory_tenant_tags 
    ON agent_memory_store USING GIN (tenant_id, tags);

-- System tenant optimizations
CREATE INDEX CONCURRENTLY idx_memory_system_tenant 
    ON agent_memory_store (key) 
    WHERE tenant_id = '__system__';

-- Entity alignment indexes
CREATE INDEX CONCURRENTLY idx_entities_tenant_type 
    ON entity_store(tenant_id, entity_type);

CREATE INDEX CONCURRENTLY idx_alignment_tenant_memory 
    ON entity_alignment(tenant_id, memory_key);
```

#### Memory Configuration

```bash
# Adjust limits per tenant needs
MEMORY_DEFAULT_LIMIT=1000        # Default query limit
MEMORY_MAX_KEY_SIZE=1024         # Max key size in bytes
MEMORY_MAX_VALUE_SIZE=1048576    # Max value size in bytes (1MB)
```

## Examples

Complete working examples are available:

### Multi-Tenant Memory Example (`apps/examples/multi-tenant-memory/`)

A comprehensive demonstration showing:
- Tenant-specific data storage and retrieval
- Pattern matching within tenant boundaries  
- Entity alignment per tenant
- Cross-tenant isolation verification
- Different tenant configurations (standard vs premium)

**Run the examples:**
```bash
cd apps/examples/multi-tenant-memory

# Test different tenants
yarn test:tenant-a      # customer-123 (standard features)
yarn test:tenant-b      # premium-enterprise-456 (premium features)  
yarn test:default       # default tenant

# Run interactive demo
yarn demo               # Multi-tenant comparison demo
```

### Key Demonstrations

**Tenant Isolation:**
- Customer-123 gets standard theme and basic features
- Premium-enterprise-456 gets premium theme and advanced features
- Complete data separation verified

**Pattern Matching:**
- `user:*` patterns only return users from current tenant
- Tag-based queries (`{ tag: 'engineering' }`) scoped to tenant
- Entity alignment separate per tenant

**Configuration Examples:**
```typescript
// Standard tenant (customer-123)
{
  theme: 'standard-light',
  features: ['basic'],
  maxUsers: 50
}

// Premium tenant (premium-enterprise-456)  
{
  theme: 'premium-dark',
  features: ['analytics', 'api', 'support'],
  maxUsers: 1000
}
```

## Related Documentation

- [Memory System](./memory-system.md) - Core memory concepts
- [Memory SQL Adapter](./memory-sql-adapter.md) - Database implementation details  
- [Runner Documentation](./runner.md) - Task execution and CLI usage 