import { describe, test, expect } from '@jest/globals';
import { FilterParser } from '../src/FilterParser.js';

describe('FilterParser', () => {
    describe('parseFilter', () => {
        test('parses numeric comparison operators', () => {
            expect(FilterParser.parseFilter('priority >= 8')).toEqual({
                path: 'priority',
                operator: '>=',
                value: 8
            });

            expect(FilterParser.parseFilter('count > 5')).toEqual({
                path: 'count',
                operator: '>',
                value: 5
            });

            expect(FilterParser.parseFilter('score <= 100')).toEqual({
                path: 'score',
                operator: '<=',
                value: 100
            });

            expect(FilterParser.parseFilter('age < 18')).toEqual({
                path: 'age',
                operator: '<',
                value: 18
            });

            expect(FilterParser.parseFilter('id = 123')).toEqual({
                path: 'id',
                operator: '=',
                value: 123
            });

            expect(FilterParser.parseFilter('status != 0')).toEqual({
                path: 'status',
                operator: '!=',
                value: 0
            });
        });

        test('parses string operators', () => {
            expect(FilterParser.parseFilter('name contains "John"')).toEqual({
                path: 'name',
                operator: 'CONTAINS',
                value: 'John'
            });

            expect(FilterParser.parseFilter('email starts_with "admin"')).toEqual({
                path: 'email',
                operator: 'STARTS_WITH',
                value: 'admin'
            });

            expect(FilterParser.parseFilter('domain ends_with ".com"')).toEqual({
                path: 'domain',
                operator: 'ENDS_WITH',
                value: '.com'
            });
        });

        test('parses nested paths', () => {
            expect(FilterParser.parseFilter('profile.email contains "@example.com"')).toEqual({
                path: 'profile.email',
                operator: 'CONTAINS',
                value: '@example.com'
            });

            expect(FilterParser.parseFilter('settings.preferences.darkMode = true')).toEqual({
                path: 'settings.preferences.darkMode',
                operator: '=',
                value: true
            });
        });

        test('parses different value types', () => {
            // Numbers
            expect(FilterParser.parseFilter('count = 42')).toEqual({
                path: 'count',
                operator: '=',
                value: 42
            });

            expect(FilterParser.parseFilter('price = 19.99')).toEqual({
                path: 'price',
                operator: '=',
                value: 19.99
            });

            // Booleans
            expect(FilterParser.parseFilter('active = true')).toEqual({
                path: 'active',
                operator: '=',
                value: true
            });

            expect(FilterParser.parseFilter('disabled = false')).toEqual({
                path: 'disabled',
                operator: '=',
                value: false
            });

            // Null
            expect(FilterParser.parseFilter('deletedAt = null')).toEqual({
                path: 'deletedAt',
                operator: '=',
                value: null
            });

            // Quoted strings
            expect(FilterParser.parseFilter('status = "active"')).toEqual({
                path: 'status',
                operator: '=',
                value: 'active'
            });

            expect(FilterParser.parseFilter("name = 'John Doe'")).toEqual({
                path: 'name',
                operator: '=',
                value: 'John Doe'
            });

            // Unquoted strings
            expect(FilterParser.parseFilter('type = user')).toEqual({
                path: 'type',
                operator: '=',
                value: 'user'
            });
        });

        test('handles whitespace correctly', () => {
            expect(FilterParser.parseFilter('  priority   >=   8  ')).toEqual({
                path: 'priority',
                operator: '>=',
                value: 8
            });

            expect(FilterParser.parseFilter('name    contains    "John"')).toEqual({
                path: 'name',
                operator: 'CONTAINS',
                value: 'John'
            });
        });

        test('handles case insensitive operators', () => {
            expect(FilterParser.parseFilter('name CONTAINS "John"')).toEqual({
                path: 'name',
                operator: 'CONTAINS',
                value: 'John'
            });

            expect(FilterParser.parseFilter('email Starts_With "admin"')).toEqual({
                path: 'email',
                operator: 'STARTS_WITH',
                value: 'admin'
            });
        });

        test('throws error for invalid syntax', () => {
            expect(() => FilterParser.parseFilter('priority')).toThrow('no valid operator found');
            expect(() => FilterParser.parseFilter('priority >=')).toThrow('missing value');
            expect(() => FilterParser.parseFilter('>= 8')).toThrow('missing path');
            expect(() => FilterParser.parseFilter('')).toThrow('no valid operator found');
        });

        it('should parse entity fuzzy operator (~)', () => {
            expect(FilterParser.parseFilter('speaker ~ "John"')).toEqual({
                path: 'speaker',
                operator: 'ENTITY_FUZZY',
                value: 'John'
            });
        });

        it('should parse entity exact operator (entity_is)', () => {
            expect(FilterParser.parseFilter('speaker entity_is "John Smith"')).toEqual({
                path: 'speaker',
                operator: 'ENTITY_EXACT',
                value: 'John Smith'
            });
        });

        it('should parse entity alias operator (entity_like)', () => {
            expect(FilterParser.parseFilter('speaker entity_like "Johnny"')).toEqual({
                path: 'speaker',
                operator: 'ENTITY_ALIAS',
                value: 'Johnny'
            });
        });

        it('should handle entity operators with nested paths', () => {
            expect(FilterParser.parseFilter('profile.speaker ~ "John"')).toEqual({
                path: 'profile.speaker',
                operator: 'ENTITY_FUZZY',
                value: 'John'
            });
        });

        it('should handle entity operators case insensitively', () => {
            expect(FilterParser.parseFilter('speaker ENTITY_IS "John"')).toEqual({
                path: 'speaker',
                operator: 'ENTITY_EXACT',
                value: 'John'
            });

            expect(FilterParser.parseFilter('speaker Entity_Like "John"')).toEqual({
                path: 'speaker',
                operator: 'ENTITY_ALIAS',
                value: 'John'
            });
        });

        it('should parse mixed entity and regular filters', () => {
            const filters = [
                'speaker ~ "John"',
                'priority >= 8',
                'location entity_like "NYC"'
            ];

            const result = FilterParser.parseFilters(filters);

            expect(result).toEqual([
                { path: 'speaker', operator: 'ENTITY_FUZZY', value: 'John' },
                { path: 'priority', operator: '>=', value: 8 },
                { path: 'location', operator: 'ENTITY_ALIAS', value: 'NYC' }
            ]);
        });
    });

    describe('parseFilters', () => {
        test('parses mixed array of string and object filters', () => {
            const filters: import('@a2arium/types').MemoryFilter[] = [
                'priority >= 8',
                { path: 'status', operator: '=' as const, value: 'active' },
                'name contains "John"'
            ];

            const result = FilterParser.parseFilters(filters);

            expect(result).toEqual([
                { path: 'priority', operator: '>=', value: 8 },
                { path: 'status', operator: '=', value: 'active' },
                { path: 'name', operator: 'CONTAINS', value: 'John' }
            ]);
        });

        test('handles empty array', () => {
            expect(FilterParser.parseFilters([])).toEqual([]);
        });

        test('handles array with only object filters', () => {
            const filters = [
                { path: 'status', operator: '=' as const, value: 'active' },
                { path: 'priority', operator: '>=' as const, value: 5 }
            ];

            const result = FilterParser.parseFilters(filters);
            expect(result).toEqual(filters);
        });

        test('handles array with only string filters', () => {
            const filters = [
                'priority >= 8',
                'status = "active"',
                'name contains "John"'
            ];

            const result = FilterParser.parseFilters(filters);

            expect(result).toEqual([
                { path: 'priority', operator: '>=', value: 8 },
                { path: 'status', operator: '=', value: 'active' },
                { path: 'name', operator: 'CONTAINS', value: 'John' }
            ]);
        });
    });
}); 