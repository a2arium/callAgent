import { TagNormalizer } from '../src/tagNormalization.js';

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