import { validateSemanticReadPageInput } from '../src/semanticPagination.js';

describe('validateSemanticReadPageInput', () => {
    test.each([
        {},
        { cursor: undefined },
        { cursor: 'v1.opaque-token' },
    ])('accepts a stable page input: %p', (input) => {
        expect(() => validateSemanticReadPageInput(input)).not.toThrow();
    });

    test.each([
        null,
        undefined,
        [],
        'page',
    ])('rejects a non-object page input: %p', (input) => {
        expect(() => validateSemanticReadPageInput(input))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' }));
    });

    test.each([
        { cursor: '' },
        { cursor: '   ' },
        { cursor: 1 },
        { cursor: null },
    ])('rejects an invalid supplied cursor: %p', (input) => {
        expect(() => validateSemanticReadPageInput(input))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_CURSOR_INVALID' }));
    });

    test.each([
        { id: undefined },
        { id: 'record:1' },
        { random: false },
        { random: true },
    ])('rejects an unsupported runtime selector: %p', (input) => {
        expect(() => validateSemanticReadPageInput(input))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' }));
    });
});
