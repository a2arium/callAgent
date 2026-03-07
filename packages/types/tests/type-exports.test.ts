import { IMemory, MemoryQueryOptions, MemoryQueryResult, FilterOperator, MemoryFilter, BaseError, MemoryError } from '../src/index.js';
import type { SemanticAddInput, SemanticItem, SemanticReadFilter, SemanticRemoveFilter, SemanticPredicateFilter } from '../src/index.js';

describe('Type exports', () => {
    it('should export all public classes', () => {
        expect(BaseError).toBeDefined();
        expect(MemoryError).toBeDefined();
    });

    it('should allow importing all public types', () => {
        type _IMemory = IMemory;
        type _MemoryQueryOptions = MemoryQueryOptions;
        type _MemoryQueryResult = MemoryQueryResult<unknown>;
        type _FilterOperator = FilterOperator;
        type _MemoryFilter = MemoryFilter;
        // If this compiles, the types are exported correctly
        expect(true).toBe(true);
    });

    it('should allow importing semantic memory types', () => {
        type _SemanticAddInput = SemanticAddInput;
        type _SemanticItem = SemanticItem;
        type _SemanticReadFilter = SemanticReadFilter;
        type _SemanticRemoveFilter = SemanticRemoveFilter;
        type _SemanticPredicateFilter = SemanticPredicateFilter;
        // If this compiles, the semantic types are exported correctly
        expect(true).toBe(true);
    });
}); 