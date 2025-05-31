import { EntityFieldParser } from '../src/EntityFieldParser.js';

describe('EntityFieldParser', () => {
    describe('parseEntityFields', () => {
        it('parses simple entity types without thresholds', () => {
            const value = {
                name: 'John Smith',
                location: 'New York'
            };

            const entitySpec = {
                name: 'person',
                location: 'location'
            };

            const result = EntityFieldParser.parseEntityFields(value, entitySpec);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                fieldName: 'name',
                entityType: 'person',
                value: 'John Smith',
                threshold: undefined
            });
            expect(result[1]).toEqual({
                fieldName: 'location',
                entityType: 'location',
                value: 'New York',
                threshold: undefined
            });
        });

        it('parses entity types with thresholds', () => {
            const value = {
                speaker: 'Dr. Jane Smith',
                venue: 'Main Auditorium',
                organizer: 'Tech Corp'
            };

            const entitySpec = {
                speaker: 'person:0.8',
                venue: 'location:0.65',
                organizer: 'organization:0.75'
            };

            const result = EntityFieldParser.parseEntityFields(value, entitySpec);

            expect(result).toHaveLength(3);
            expect(result[0]).toEqual({
                fieldName: 'speaker',
                entityType: 'person',
                value: 'Dr. Jane Smith',
                threshold: 0.8
            });
            expect(result[1]).toEqual({
                fieldName: 'venue',
                entityType: 'location',
                value: 'Main Auditorium',
                threshold: 0.65
            });
            expect(result[2]).toEqual({
                fieldName: 'organizer',
                entityType: 'organization',
                value: 'Tech Corp',
                threshold: 0.75
            });
        });

        it('handles mixed entity specs with and without thresholds', () => {
            const value = {
                name: 'John Doe',
                company: 'ACME Corp',
                city: 'San Francisco'
            };

            const entitySpec = {
                name: 'person:0.9',      // With threshold
                company: 'organization', // Without threshold
                city: 'location:0.6'     // With threshold
            };

            const result = EntityFieldParser.parseEntityFields(value, entitySpec);

            expect(result).toHaveLength(3);
            expect(result[0].threshold).toBe(0.9);
            expect(result[1].threshold).toBeUndefined();
            expect(result[2].threshold).toBe(0.6);
        });

        it('handles nested field paths', () => {
            const value = {
                session: {
                    presenter: {
                        name: 'Dr. Smith',
                        affiliation: 'MIT'
                    },
                    location: {
                        building: 'Science Center'
                    }
                }
            };

            const entitySpec = {
                'session.presenter.name': 'person:0.75',
                'session.presenter.affiliation': 'organization:0.8',
                'session.location.building': 'location:0.65'
            };

            const result = EntityFieldParser.parseEntityFields(value, entitySpec);

            expect(result).toHaveLength(3);
            expect(result[0]).toEqual({
                fieldName: 'session.presenter.name',
                entityType: 'person',
                value: 'Dr. Smith',
                threshold: 0.75
            });
            expect(result[1]).toEqual({
                fieldName: 'session.presenter.affiliation',
                entityType: 'organization',
                value: 'MIT',
                threshold: 0.8
            });
            expect(result[2]).toEqual({
                fieldName: 'session.location.building',
                entityType: 'location',
                value: 'Science Center',
                threshold: 0.65
            });
        });

        it('throws error for invalid threshold values', () => {
            const value = { name: 'John Smith' };

            expect(() => {
                EntityFieldParser.parseEntityFields(value, { name: 'person:invalid' });
            }).toThrow('Invalid threshold \'invalid\' in entity spec \'person:invalid\'');

            expect(() => {
                EntityFieldParser.parseEntityFields(value, { name: 'person:-0.1' });
            }).toThrow('Invalid threshold \'-0.1\' in entity spec \'person:-0.1\'');

            expect(() => {
                EntityFieldParser.parseEntityFields(value, { name: 'person:1.5' });
            }).toThrow('Invalid threshold \'1.5\' in entity spec \'person:1.5\'');
        });

        it('throws error for malformed entity specs', () => {
            const value = { name: 'John Smith' };

            expect(() => {
                EntityFieldParser.parseEntityFields(value, { name: 'person:0.7:extra' });
            }).toThrow('Invalid entity type specification \'person:0.7:extra\'');
        });

        it('accepts threshold values at boundaries', () => {
            const value = {
                name1: 'John',
                name2: 'Jane'
            };

            const entitySpec = {
                name1: 'person:0.0',  // Minimum threshold
                name2: 'person:1.0'   // Maximum threshold
            };

            const result = EntityFieldParser.parseEntityFields(value, entitySpec);

            expect(result[0].threshold).toBe(0.0);
            expect(result[1].threshold).toBe(1.0);
        });

        it('skips non-string field values', () => {
            const value = {
                name: 'John Smith',
                age: 30,                    // number - should be skipped
                active: true,               // boolean - should be skipped
                metadata: { key: 'value' }  // object - should be skipped
            };

            const entitySpec = {
                name: 'person',
                age: 'number',
                active: 'boolean',
                metadata: 'object'
            };

            const result = EntityFieldParser.parseEntityFields(value, entitySpec);

            expect(result).toHaveLength(1);
            expect(result[0].fieldName).toBe('name');
        });
    });
}); 