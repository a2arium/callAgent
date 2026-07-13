import {
    IMemory,
    MemoryQueryOptions,
    MemoryQueryResult,
    FilterOperator,
    MemoryFilter,
    BaseError,
    MemoryError,
    SemanticAtomicError,
} from '../src/index.js';
import type {
    SemanticAddInput,
    SemanticItem,
    SemanticReadFilter,
    SemanticRemoveFilter,
    SemanticPredicateFilter,
    SemanticAtomicCapability,
    SemanticCompareAndSetInput,
    SemanticCompareAndSetOptions,
    SemanticCompareAndSetResult,
    SemanticMemoryBackend,
    SemanticVersionedValue,
} from '../src/index.js';

describe('Type exports', () => {
    it('should export all public classes', () => {
        expect(BaseError).toBeDefined();
        expect(MemoryError).toBeDefined();
        expect(SemanticAtomicError).toBeDefined();
    });

    it('should allow importing all public types', () => {
        type _IMemory = IMemory;
        type _MemoryQueryOptions = MemoryQueryOptions;
        type _MemoryQueryResult = MemoryQueryResult<unknown>;
        type _FilterOperator = FilterOperator;
        type _MemoryFilter = MemoryFilter;
        expect(true).toBe(true);
    });

    it('should allow importing semantic memory types', () => {
        type _SemanticAddInput = SemanticAddInput;
        type _SemanticItem = SemanticItem;
        type _SemanticReadFilter = SemanticReadFilter;
        type _SemanticRemoveFilter = SemanticRemoveFilter;
        type _SemanticPredicateFilter = SemanticPredicateFilter;
        type _SemanticAtomicCapability = SemanticAtomicCapability;
        type _SemanticCompareAndSetInput = SemanticCompareAndSetInput<unknown>;
        type _SemanticCompareAndSetOptions = SemanticCompareAndSetOptions;
        type _SemanticCompareAndSetResult = SemanticCompareAndSetResult;
        type _SemanticVersionedValue = SemanticVersionedValue<unknown>;
        expect(true).toBe(true);
    });

    it('keeps pre-CAS semantic backends source-compatible', () => {
        const backend = {
            get: async () => null,
            read: async () => [],
            set: async () => undefined,
            delete: async () => undefined,
            remove: async () => 0,
            recognize: async () => ({ recognized: false }),
            enrich: async () => ({ enriched: false }),
        } satisfies SemanticMemoryBackend;

        expect('atomic' in backend).toBe(false);
    });

    it('keeps pre-CAS memory facades source-compatible', () => {
        const legacySemantic = null as unknown as Omit<IMemory['semantic'], 'getAtomic'>;
        const memory = {
            semantic: legacySemantic,
            episodic: null as unknown as IMemory['episodic'],
            embed: null as unknown as IMemory['embed'],
        } satisfies IMemory;

        expect(memory.semantic).toBe(legacySemantic);
    });
});
