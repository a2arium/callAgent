import { TagNormalizer } from '../src/utils/tagNormalization.js';

describe('TagNormalizer', () => {
    describe('normalize', () => {
        test('converts to lowercase', () => {
            expect(TagNormalizer.normalize('RIGA')).toBe('riga');
            expect(TagNormalizer.normalize('Riga')).toBe('riga');
            expect(TagNormalizer.normalize('rIgA')).toBe('riga');
        });

        test('trims whitespace', () => {
            expect(TagNormalizer.normalize('  riga  ')).toBe('riga');
            expect(TagNormalizer.normalize('\tlatvia\n')).toBe('latvia');
            expect(TagNormalizer.normalize(' EVENTS ')).toBe('events');
        });

        test('handles empty and whitespace-only strings', () => {
            expect(TagNormalizer.normalize('')).toBe('');
            expect(TagNormalizer.normalize('   ')).toBe('');
            expect(TagNormalizer.normalize('\t\n')).toBe('');
        });

        test('handles mixed case with special characters', () => {
            expect(TagNormalizer.normalize('New-York')).toBe('new-york');
            expect(TagNormalizer.normalize('  Test_Tag  ')).toBe('test_tag');
            expect(TagNormalizer.normalize('TAG123')).toBe('tag123');
        });
    });

    describe('normalizeTags', () => {
        test('normalizes array of tags', () => {
            const result = TagNormalizer.normalizeTags(['RIGA', '  Latvia  ', 'Events']);
            expect(result).toEqual(['riga', 'latvia', 'events']);
        });

        test('removes duplicates after normalization', () => {
            const result = TagNormalizer.normalizeTags(['RIGA', 'riga', '  Riga  ']);
            expect(result).toEqual(['riga']);
        });

        test('filters out empty tags', () => {
            const result = TagNormalizer.normalizeTags(['riga', '', '  ', 'latvia', '\t\n']);
            expect(result).toEqual(['riga', 'latvia']);
        });

        test('filters out non-string values', () => {
            const result = TagNormalizer.normalizeTags(['riga', null as any, undefined as any, 123 as any, 'latvia']);
            expect(result).toEqual(['riga', 'latvia']);
        });

        test('handles empty array', () => {
            expect(TagNormalizer.normalizeTags([])).toEqual([]);
        });

        test('preserves order after removing duplicates', () => {
            const result = TagNormalizer.normalizeTags(['RIGA', 'latvia', 'events', 'RIGA', 'Events']);
            expect(result).toEqual(['riga', 'latvia', 'events']);
        });

        test('handles complex real-world scenario', () => {
            const result = TagNormalizer.normalizeTags([
                '  RIGA  ',
                'Latvia',
                'events',
                '',
                'CONFERENCE',
                '  riga  ',
                null as any,
                'tech-meetup',
                'TECH-MEETUP'
            ]);
            expect(result).toEqual(['riga', 'latvia', 'events', 'conference', 'tech-meetup']);
        });
    });
}); 