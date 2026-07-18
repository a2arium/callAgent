import {
    normalizeRequiredTags,
    normalizeStoredTags,
    SEMANTIC_TAG_LIMITS,
    TagNormalizer,
} from '../src/tagNormalization.js';

describe('TagNormalizer', () => {
    describe('normalize', () => {
        test('converts to lowercase', () => {
            expect(TagNormalizer.normalize('RIGA')).toBe('riga');
            expect(TagNormalizer.normalize('RiGa')).toBe('riga');
        });

        test('trims whitespace', () => {
            expect(TagNormalizer.normalize('  riga  ')).toBe('riga');
            expect(TagNormalizer.normalize('\t\nriga\n\t')).toBe('riga');
        });

        test('handles mixed case and whitespace', () => {
            expect(TagNormalizer.normalize('  RIGA  ')).toBe('riga');
        });

        test('handles empty string after trimming', () => {
            expect(TagNormalizer.normalize('   ')).toBe('');
            expect(TagNormalizer.normalize('')).toBe('');
        });
    });

    describe('normalizeTags', () => {
        test('normalizes all tags in array', () => {
            const input = ['RIGA', '  latvia  ', 'TaLLinn'];
            const expected = ['riga', 'latvia', 'tallinn'];
            expect(TagNormalizer.normalizeTags(input)).toEqual(expected);
        });

        test('removes duplicate tags after normalization', () => {
            const input = ['riga', 'RIGA', '  riga  ', 'latvia'];
            const expected = ['riga', 'latvia'];
            expect(TagNormalizer.normalizeTags(input)).toEqual(expected);
        });

        test('filters out empty tags', () => {
            const result = TagNormalizer.normalizeTags(['riga', '', '  ', 'latvia', '\t\n']);
            expect(result).toEqual(['riga', 'latvia']);
        });

        test('filters out non-string values', () => {
            const mixedArray = ['riga', null, undefined, 123, 'latvia'];
            // @ts-ignore - Testing with mixed types intentionally
            const result = TagNormalizer.normalizeTags(mixedArray);
            expect(result).toEqual(['riga', 'latvia']);
        });

        test('handles empty array', () => {
            expect(TagNormalizer.normalizeTags([])).toEqual([]);
        });

        test('preserves order after removing duplicates', () => {
            const input = ['latvia', 'riga', 'LATVIA', 'tallinn'];
            const expected = ['latvia', 'riga', 'tallinn'];
            expect(TagNormalizer.normalizeTags(input)).toEqual(expected);
        });

        test('comprehensive test with various inputs', () => {
            const mixedArray = [
                'riga',
                'RIGA',
                'conference',
                'CONFERENCE',
                '  riga  ',
                null,
                'tech-meetup',
                'TECH-MEETUP'
            ];
            // @ts-ignore - Testing with mixed types intentionally
            const result = TagNormalizer.normalizeTags(mixedArray);
            expect(result).toEqual(['riga', 'conference', 'tech-meetup']);
        });
    });
});

describe('strict semantic tag normalization', () => {
    test('combines singular and plural inputs in first-occurrence order', () => {
        expect(normalizeRequiredTags({ tag: ' READY ', tags: ['ready', ' SITE:42 ', 'proposal'] }))
            .toEqual({ requiredTags: ['ready', 'site:42', 'proposal'], suppliedTagCount: 4 });
    });

    test('treats an empty plural array as unrestricted but rejects empty-only input', () => {
        expect(normalizeRequiredTags({ tags: [] }).requiredTags).toEqual([]);
        expect(normalizeRequiredTags({ tag: undefined, tags: undefined }).requiredTags).toEqual([]);
        expect(() => normalizeRequiredTags({ tag: '  ' })).toThrow(expect.objectContaining({ code: 'SEMANTIC_TAG_EMPTY' }));
        expect(() => normalizeRequiredTags({ tags: [' ', '\t'] })).toThrow(expect.objectContaining({ code: 'SEMANTIC_TAG_EMPTY' }));
    });

    test('rejects runtime non-strings and bounds raw input before normalization', () => {
        expect(() => normalizeRequiredTags({ tags: ['valid', 1] })).toThrow(expect.objectContaining({ code: 'SEMANTIC_TAG_INVALID_TYPE' }));
        expect(() => normalizeRequiredTags({ tags: Array(SEMANTIC_TAG_LIMITS.maxRawQueryTagInputs + 1).fill('x') }))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_TAG_COUNT_EXCEEDED' }));
    });

    test('enforces normalized UTF-8 byte length exactly', () => {
        const atBoundary = 'é'.repeat(SEMANTIC_TAG_LIMITS.maxNormalizedTagBytes / 2);
        expect(normalizeStoredTags([atBoundary])).toEqual([atBoundary]);
        expect(() => normalizeStoredTags([`${atBoundary}é`]))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_TAG_TOO_LONG' }));
    });

    test('is idempotent and does not leak tag values in error metadata', () => {
        const once = normalizeStoredTags([' Alpha ', 'BETA', 'alpha']);
        expect(normalizeStoredTags(once)).toEqual(once);
        try {
            normalizeStoredTags(['secret-tag'.repeat(40)]);
            throw new Error('expected validation to fail');
        } catch (error) {
            expect(JSON.stringify(error)).not.toContain('secret-tag');
        }
    });
});
