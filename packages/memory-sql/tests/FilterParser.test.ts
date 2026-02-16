import { FilterParser, ParsedFilter, AtomicParsedFilter, ArrayPathInfo } from '../src/FilterParser.js';

describe('FilterParser', () => {
    describe('Regular Filter Parsing (existing functionality)', () => {
        test('parses simple equality filter', () => {
            const result = FilterParser.parseFilter('priority = 8') as AtomicParsedFilter;

            expect(result.type).toBe('atomic');
            expect(result.path).toBe('priority');
            expect(result.operator).toBe('=');
            expect(result.value).toBe(8);
            expect(result.isArrayPath).toBe(false);
            expect(result.arrayPathInfo).toBeUndefined();
        });

        test('parses string filter with quotes', () => {
            const result = FilterParser.parseFilter('name = "John Doe"') as AtomicParsedFilter;

            expect(result.path).toBe('name');
            expect(result.operator).toBe('=');
            expect(result.value).toBe('John Doe');
            expect(result.isArrayPath).toBe(false);
        });

        test('parses comparison operators', () => {
            const tests = [
                { filter: 'age >= 18', operator: '>=', value: 18 },
                { filter: 'score <= 100', operator: '<=', value: 100 },
                { filter: 'count != 0', operator: '!=', value: 0 },
                { filter: 'rating > 4.5', operator: '>', value: 4.5 },
                { filter: 'price < 50', operator: '<', value: 50 }
            ];

            tests.forEach(({ filter, operator, value }) => {
                const result = FilterParser.parseFilter(filter) as AtomicParsedFilter;
                expect(result.operator).toBe(operator);
                expect(result.value).toBe(value);
                expect(result.isArrayPath).toBe(false);
            });
        });

        test('parses string operators', () => {
            const tests = [
                { filter: 'title contains "conference"', operator: 'CONTAINS', value: 'conference' },
                { filter: 'name starts_with "Dr"', operator: 'STARTS_WITH', value: 'Dr' },
                { filter: 'email ends_with ".com"', operator: 'ENDS_WITH', value: '.com' }
            ];

            tests.forEach(({ filter, operator, value }) => {
                const result = FilterParser.parseFilter(filter) as AtomicParsedFilter;
                expect(result.operator).toBe(operator);
                expect(result.value).toBe(value);
                expect(result.isArrayPath).toBe(false);
            });
        });

        test('parses entity operators', () => {
            const tests = [
                { filter: 'venue entity_is "Conference Hall"', operator: 'ENTITY_EXACT' },
                { filter: 'location entity_like "Riga"', operator: 'ENTITY_ALIAS' },
                { filter: 'speaker ~ "John Smith"', operator: 'ENTITY_FUZZY' }
            ];

            tests.forEach(({ filter, operator }) => {
                const result = FilterParser.parseFilter(filter) as AtomicParsedFilter;
                expect(result.operator).toBe(operator);
                expect(result.isArrayPath).toBe(false);
            });
        });

        test('parses nested object paths', () => {
            const result = FilterParser.parseFilter('venue.address.city = "Riga"') as AtomicParsedFilter;

            expect(result.path).toBe('venue.address.city');
            expect(result.operator).toBe('=');
            expect(result.value).toBe('Riga');
            expect(result.isArrayPath).toBe(false);
        });
    });

    describe('Array Filter Parsing (new functionality)', () => {
        test('parses simple array path with equality', () => {
            const result = FilterParser.parseFilter('eventOccurences[].date = "2025-07-24"') as AtomicParsedFilter;

            expect(result.path).toBe('eventOccurences[].date');
            expect(result.operator).toBe('=');
            expect(result.value).toBe('2025-07-24');
            expect(result.isArrayPath).toBe(true);
            expect(result.arrayPathInfo?.arrayField).toBe('eventOccurences');
            expect(result.arrayPathInfo?.nestedPath).toBe('date');
            expect(result.arrayPathInfo?.hasNestedArrays).toBe(false);
        });

        test('parses array path with comparison operators', () => {
            const tests = [
                { filter: 'events[].priority >= 8', operator: '>=', value: 8 },
                { filter: 'sessions[].duration <= 60', operator: '<=', value: 60 },
                { filter: 'items[].count != 0', operator: '!=', value: 0 },
                { filter: 'scores[].value > 95', operator: '>', value: 95 },
                { filter: 'prices[].amount < 100', operator: '<', value: 100 }
            ];

            tests.forEach(({ filter, operator, value }) => {
                const result = FilterParser.parseFilter(filter) as AtomicParsedFilter;
                expect(result.operator).toBe(operator);
                expect(result.value).toBe(value);
                expect(result.isArrayPath).toBe(true);
                expect(result.arrayPathInfo).toBeDefined();
            });
        });

        test('parses array path with string operators', () => {
            const tests = [
                { filter: 'events[].title contains "conference"', operator: 'CONTAINS', value: 'conference' },
                { filter: 'attendees[].name starts_with "Dr"', operator: 'STARTS_WITH', value: 'Dr' },
                { filter: 'emails[].address ends_with ".edu"', operator: 'ENDS_WITH', value: '.edu' }
            ];

            tests.forEach(({ filter, operator, value }) => {
                const result = FilterParser.parseFilter(filter) as AtomicParsedFilter;
                expect(result.operator).toBe(operator);
                expect(result.value).toBe(value);
                expect(result.isArrayPath).toBe(true);
                expect(result.arrayPathInfo).toBeDefined();
            });
        });

        test('parses nested object paths within arrays', () => {
            const result = FilterParser.parseFilter('events[].venue.name = "Conference Hall"') as AtomicParsedFilter;

            expect(result.path).toBe('events[].venue.name');
            expect(result.isArrayPath).toBe(true);
            expect(result.arrayPathInfo?.arrayField).toBe('events');
            expect(result.arrayPathInfo?.nestedPath).toBe('venue.name');
            expect(result.arrayPathInfo?.hasNestedArrays).toBe(false);
        });

        test('detects future nested arrays in paths', () => {
            const result = FilterParser.parseFilter('events[].sessions[].speaker = "John"') as AtomicParsedFilter;

            expect(result.isArrayPath).toBe(true);
            expect(result.arrayPathInfo?.arrayField).toBe('events');
            expect(result.arrayPathInfo?.nestedPath).toBe('sessions[].speaker');
            expect(result.arrayPathInfo?.hasNestedArrays).toBe(true);
        });

        test('handles complex nested paths', () => {
            const result = FilterParser.parseFilter('conference[].days.sessions.speakers[].expertise contains "AI"') as AtomicParsedFilter;

            expect(result.isArrayPath).toBe(true);
            expect(result.arrayPathInfo?.arrayField).toBe('conference');
            expect(result.arrayPathInfo?.nestedPath).toBe('days.sessions.speakers[].expertise');
            expect(result.arrayPathInfo?.hasNestedArrays).toBe(true);
        });
    });

    describe('Error Handling', () => {
        test('throws error for invalid array syntax - missing nested field', () => {
            expect(() => FilterParser.parseFilter('events[] = "value"')).toThrow(
                'Array path "events[]" must specify a field within the array elements. Expected format: "arrayField[].nestedField"'
            );
        });



        test('throws error for missing path', () => {
            expect(() => FilterParser.parseFilter(' = "value"')).toThrow(
                'Invalid filter: missing path'
            );
        });

        test('throws error for missing value', () => {
            expect(() => FilterParser.parseFilter('path = ')).toThrow(
                'Invalid filter: missing value'
            );
        });

        test('throws error for no valid operator', () => {
            expect(() => FilterParser.parseFilter('path value')).toThrow(
                'Invalid filter: no valid operator found'
            );
        });
    });

    describe('Value Parsing', () => {
        test('parses different value types correctly', () => {
            const tests = [
                { filter: 'field = "string"', expected: 'string' },
                { filter: "field = 'string'", expected: 'string' },
                { filter: 'field = 42', expected: 42 },
                { filter: 'field = 3.14', expected: 3.14 },
                { filter: 'field = true', expected: true },
                { filter: 'field = false', expected: false },
                { filter: 'field = null', expected: null },
                { filter: 'field = unquoted', expected: 'unquoted' }
            ];

            tests.forEach(({ filter, expected }) => {
                const result = FilterParser.parseFilter(filter) as AtomicParsedFilter;
                expect(result.value).toBe(expected);
            });
        });
    });

    describe('parseFilters Method', () => {
        test('parses mixed array of string and object filters', () => {
            const filters = [
                'eventOccurences[].date = "2025-07-24"',
                { path: 'city', operator: '=' as const, value: 'Riga' },
                'attendees[].age >= 18'
            ];

            const results = FilterParser.parseFilters(filters);

            expect(results).toHaveLength(3);

            // First filter (array)
            expect(results[0].type).toBe('atomic');
            const r0 = results[0] as AtomicParsedFilter;
            expect(r0.isArrayPath).toBe(true);
            expect(r0.arrayPathInfo?.arrayField).toBe('eventOccurences');
            expect(r0.arrayPathInfo?.nestedPath).toBe('date');

            // Second filter (regular object)
            expect(results[1].type).toBe('atomic');
            const r1 = results[1] as AtomicParsedFilter;
            expect(r1.isArrayPath).toBe(false);
            expect(r1.path).toBe('city');
            expect(r1.value).toBe('Riga');

            // Third filter (array)
            expect(results[2].type).toBe('atomic');
            const r2 = results[2] as AtomicParsedFilter;
            expect(r2.isArrayPath).toBe(true);
            expect(r2.arrayPathInfo?.arrayField).toBe('attendees');
            expect(r2.arrayPathInfo?.nestedPath).toBe('age');
        });

        test('converts object filters with array paths', () => {
            const filters = [
                { path: 'events[].priority', operator: '>=' as const, value: 8 }
            ];

            const results = FilterParser.parseFilters(filters);

            expect(results).toHaveLength(1);
            expect(results[0].type).toBe('atomic');
            const r = results[0] as AtomicParsedFilter;
            expect(r.isArrayPath).toBe(true);
            expect(r.arrayPathInfo?.arrayField).toBe('events');
            expect(r.arrayPathInfo?.nestedPath).toBe('priority');
        });
    });

    describe('Logical Operator Splitting', () => {
        test('parses OR operator', () => {
            const result = FilterParser.parseFilter('priority = 8 OR status = "active"');

            expect(result.type).toBe('group');
            if (result.type === 'group') {
                expect(result.logic).toBe('OR');
                expect(result.filters).toHaveLength(2);
                expect((result.filters[0] as any).path).toBe('priority');
                expect((result.filters[1] as any).path).toBe('status');
            }
        });

        test('parses multiple OR operators', () => {
            const result = FilterParser.parseFilter('a = 1 OR b = 2 OR c = 3');

            expect(result.type).toBe('group');
            if (result.type === 'group') {
                expect(result.logic).toBe('OR');
                expect(result.filters).toHaveLength(3);
                expect((result.filters[0] as any).path).toBe('a');
                expect((result.filters[1] as any).path).toBe('b');
                expect((result.filters[2] as any).path).toBe('c');
            }
        });

        test('parses AND operator', () => {
            const result = FilterParser.parseFilter('priority = 8 AND status = "active"');

            expect(result.type).toBe('group');
            if (result.type === 'group') {
                expect(result.logic).toBe('AND');
                expect(result.filters).toHaveLength(2);
            }
        });

        test('handles mixed OR and AND (simple precedence)', () => {
            // OR has lower precedence than AND in our implementation
            // a = 1 OR b = 2 AND c = 3  =>  (a = 1) OR (b = 2 AND c = 3)
            const result = FilterParser.parseFilter('a = 1 OR b = 2 AND c = 3');

            expect(result.type).toBe('group');
            if (result.type === 'group') {
                expect(result.logic).toBe('OR');
                expect(result.filters).toHaveLength(2);
                expect(result.filters[0].type).toBe('atomic');
                expect(result.filters[1].type).toBe('group');
                if (result.filters[1].type === 'group') {
                    expect(result.filters[1].logic).toBe('AND');
                }
            }
        });

        test('respects quotes when splitting', () => {
            const result = FilterParser.parseFilter('name = "John OR Jane" OR priority = 1');
            expect(result.type).toBe('group');
            if (result.type === 'group') {
                expect(result.filters).toHaveLength(2);
                const atomicFilter = result.filters[0] as any;
                expect(atomicFilter.value).toBe('John OR Jane');
            }
        });
    });

    describe('Legacy Compatibility', () => {
        test('parseFiltersLegacy returns old format', () => {
            const filters = [
                'eventOccurences[].date = "2025-07-24"',
                { path: 'city', operator: '=' as const, value: 'Riga' }
            ];

            const results = FilterParser.parseFiltersLegacy(filters);

            expect(results).toHaveLength(2);

            // Should have old format (no isArrayPath or arrayPathInfo)
            expect(results[0]).toEqual({
                path: 'eventOccurences[].date',
                operator: '=',
                value: '2025-07-24'
            });

            expect(results[1]).toEqual({
                path: 'city',
                operator: '=',
                value: 'Riga'
            });

            // Ensure new properties are not present
            expect('isArrayPath' in results[0]).toBe(false);
            expect('arrayPathInfo' in results[0]).toBe(false);
        });
    });
}); 