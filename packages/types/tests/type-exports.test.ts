import { IMemory, MemoryQueryOptions, MemoryQueryResult, FilterOperator, MemoryFilter, BaseError, MemoryError } from '../src';

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
}); 