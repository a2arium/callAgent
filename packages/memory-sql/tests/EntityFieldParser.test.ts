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

        // Natural Array Support Tests
        describe('Natural Array Support', () => {
            it('handles titleAndDescription array naturally', () => {
                const value = {
                    titleAndDescription: [
                        { title: "Event Title", description: "Event Description", language: "en" }
                    ],
                    venue: { name: "Main Hall" }
                };

                const entitySpec = {
                    "titleAndDescription.title": "event",       // Should find "Event Title"
                    "titleAndDescription.description": "text",  // Should find "Event Description"  
                    "venue.name": "location"                    // Should still work
                };

                const result = EntityFieldParser.parseEntityFields(value, entitySpec);
                expect(result).toHaveLength(3);
                expect(result[0].value).toBe("Event Title");
                expect(result[1].value).toBe("Event Description");
                expect(result[2].value).toBe("Main Hall");
            });

            it('handles multiple array elements (returns first match)', () => {
                const value = {
                    speakers: [
                        { name: "Dr. John Smith", affiliation: "MIT" },
                        { name: "Prof. Jane Doe", affiliation: "Stanford" }
                    ]
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "speakers.name": "person",
                    "speakers.affiliation": "organization"
                });

                expect(result).toHaveLength(2);
                expect(result[0].value).toBe("Dr. John Smith");  // First match
                expect(result[1].value).toBe("MIT");              // First match
            });

            it('handles eventOccurences array naturally', () => {
                const value = {
                    eventOccurences: [
                        { date: "2024-01-15", time: "19:00", isSoldOut: false },
                        { date: "2024-01-16", time: "20:00", isSoldOut: true }
                    ]
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "eventOccurences.date": "date",
                    "eventOccurences.time": "time"
                });

                expect(result).toHaveLength(2);
                expect(result[0].value).toBe("2024-01-15");  // First occurrence
                expect(result[1].value).toBe("19:00");        // First occurrence
            });

            it('handles deeply nested arrays', () => {
                const value = {
                    sessions: [
                        {
                            presenters: [
                                { name: "Speaker 1", company: "Corp A" },
                                { name: "Speaker 2", company: "Corp B" }
                            ]
                        }
                    ]
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "sessions.presenters.name": "person"  // Double array traversal
                });

                expect(result).toHaveLength(1);
                expect(result[0].value).toBe("Speaker 1");
            });

            it('handles mixed objects and arrays', () => {
                const value = {
                    event: {
                        details: {
                            speakers: [{ name: "John" }],
                            venue: { name: "Hall A" }
                        }
                    }
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "event.details.speakers.name": "person",  // object.object.array.field
                    "event.details.venue.name": "location"    // object.object.object.field
                });

                expect(result).toHaveLength(2);
                expect(result[0].value).toBe("John");
                expect(result[1].value).toBe("Hall A");
            });

            it('handles arrays at different levels', () => {
                const value = {
                    conferences: [
                        {
                            name: "AI Summit",
                            sessions: [
                                { title: "Machine Learning", speaker: "Dr. A" },
                                { title: "Deep Learning", speaker: "Dr. B" }
                            ]
                        },
                        {
                            name: "Tech Conference",
                            sessions: [
                                { title: "Web Development", speaker: "Prof. C" }
                            ]
                        }
                    ]
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "conferences.name": "event",                    // Array -> object field
                    "conferences.sessions.title": "topic",         // Array -> array -> object field
                    "conferences.sessions.speaker": "person"       // Array -> array -> object field
                });

                expect(result).toHaveLength(3);
                expect(result[0].value).toBe("AI Summit");        // First conference
                expect(result[1].value).toBe("Machine Learning"); // First session of first conference
                expect(result[2].value).toBe("Dr. A");            // First session of first conference
            });

            it('handles edge cases gracefully', () => {
                const value = {
                    emptyArray: [],
                    nullArray: null,
                    mixedArray: [{ name: "John" }, "string", 123, null],
                    undefinedArray: undefined
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "emptyArray.name": "person",      // Should return empty
                    "nullArray.name": "person",       // Should return empty  
                    "mixedArray.name": "person",      // Should find "John"
                    "undefinedArray.name": "person"   // Should return empty
                });

                expect(result).toHaveLength(1);  // Only mixedArray.name should match
                expect(result[0].value).toBe("John");
                expect(result[0].fieldName).toBe("mixedArray.name");
            });

            it('handles arrays with non-object elements', () => {
                const value = {
                    items: ["string1", "string2"],
                    mixed: [{ name: "John" }, "plain string", { name: "Jane" }]
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "items.name": "person",    // Should not match (strings don't have .name)
                    "mixed.name": "person"     // Should find "John" (first object with .name)
                });

                expect(result).toHaveLength(1);
                expect(result[0].value).toBe("John");
                expect(result[0].fieldName).toBe("mixed.name");
            });

            it('maintains backward compatibility with existing object notation', () => {
                const value = {
                    user: {
                        profile: {
                            name: "John Smith",
                            contact: {
                                email: "john@example.com"
                            }
                        }
                    }
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "user.profile.name": "person",
                    "user.profile.contact.email": "email"
                });

                expect(result).toHaveLength(2);
                expect(result[0].value).toBe("John Smith");
                expect(result[1].value).toBe("john@example.com");
            });

            it('works with entity specs that have thresholds', () => {
                const value = {
                    titleAndDescription: [
                        { title: "AI Conference", description: "Annual conference" }
                    ]
                };

                const result = EntityFieldParser.parseEntityFields(value, {
                    "titleAndDescription.title": "event:0.8",         // Array access with threshold
                    "titleAndDescription.description": "text:0.6"     // Array access with threshold
                });

                expect(result).toHaveLength(2);
                expect(result[0].value).toBe("AI Conference");
                expect(result[0].threshold).toBe(0.8);
                expect(result[1].value).toBe("Annual conference");
                expect(result[1].threshold).toBe(0.6);
            });
        });
    });
}); 