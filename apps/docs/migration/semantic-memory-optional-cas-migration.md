# Migration Guide: Optional Semantic-Memory Compare-and-Set

Semantic-memory compare-and-set (CAS) is additive and optional. Existing agents, ordinary semantic-memory calls, and custom backends continue to work without changes.

## Operator action

Run the `@a2arium/callagent-memory-sql` migrations before enabling callers that use CAS. The migration adds an internal `version` column, a PostgreSQL sequence, and an update trigger to `agent_memory_store`.

- Existing rows receive distinct opaque generations.
- Inserts receive a sequence-backed generation.
- Every row update receives a fresh generation through the trigger.
- Delete and recreate cannot make an old token valid again.
- Sequence gaps are normal, including after rolled-back statements.
- Stored semantic JSON values and all existing API return shapes are unchanged.

## Custom semantic backends

No change is required. Backends that provide real atomic single-key writes may expose `atomic: SemanticAtomicCapability`; other backends omit it. CallAgent never synthesizes atomicity from `get` plus `set`.

Callers detect support for the selected backend:

```ts
const atomic = ctx.memory.semantic.getAtomic?.({ backend: 'sql' });
if (!atomic) {
    // Disable the dependent feature or fail configuration explicitly.
}
```

CAS v1 supports exact JSON-domain values and tags. Lossy JavaScript values, blob-backed values, and entity-alignment options are rejected with public `SemanticAtomicError` codes.

## Deployment order

Publish and deploy compatible package versions in this order:

1. `@a2arium/callagent-types`
2. `@a2arium/callagent-memory-sql` and `@a2arium/callagent-memory-engine`
3. `@a2arium/callagent-core`
4. Dependent applications such as SiteConfig activation

Do not enable downstream CAS callers until the migration is applied and every linked CallAgent package exposes the released contract.
