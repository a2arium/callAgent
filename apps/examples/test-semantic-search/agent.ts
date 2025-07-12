import { createAgent } from '@callagent/core';

// Test data - variations of the same event/venue
const testEvents = [
    {
        key: "test:event:1",
        data: {
            "titleAndDescription": [
                {
                    "title": "19. koncertcikls DŽEZS VECRĪGĀ – MAZĀS ĢILDES DĀRZĀ. Toma Rudzinska kvartets",
                    "language": "lv"
                }
            ],
            "venue": {
                "name": "Kultūras un tautas mākslas centrs Mazā Ģilde",
                "address": "Amatu iela 5, Rīga"
            },
            "eventOccurences": [{ "date": "2025-07-03", "time": "17:00" }]
        }
    },
    {
        key: "test:event:2",
        data: {
            "titleAndDescription": [
                {
                    "title": "Jazz Concert - Toma Rudzinska Quartet",
                    "language": "en"
                }
            ],
            "venue": {
                "name": "Small Guild Cultural Center",
                "address": "Amatu street 5, Riga"
            },
            "eventOccurences": [{ "date": "2025-07-10", "time": "19:00" }]
        }
    },
    {
        key: "test:event:3",
        data: {
            "titleAndDescription": [
                {
                    "title": "Džeza koncerts - Toma Rudzinska kvartets",
                    "language": "lv"
                }
            ],
            "venue": {
                "name": "Mazā Ģilde",
                "address": "Amatu 5"
            },
            "eventOccurences": [{ "date": "2025-07-15", "time": "18:00" }]
        }
    }
];

const testVenues = [
    {
        key: "test:venue:1",
        data: {
            "venueName": "Kultūras un tautas mākslas centrs Mazā Ģilde",
            "address": "Amatu iela 5, Rīga. LV-1050",
            "city": "Riga",
            "country": "Latvia"
        }
    },
    {
        key: "test:venue:2",
        data: {
            "venueName": "Small Guild Cultural Center",
            "address": "Amatu street 5, Riga",
            "city": "Riga",
            "country": "Latvia"
        }
    },
    {
        key: "test:venue:3",
        data: {
            "venueName": "Mazā Ģilde",
            "address": "Amatu 5, Rīga",
            "city": "Riga",
            "country": "Latvia"
        }
    }
];

// Search test cases
const searchTests = [
    // Event title variations
    { type: 'event', query: 'DŽEZS VECRĪGĀ', field: 'titleAndDescription.title', description: 'Original Latvian title fragment' },
    { type: 'event', query: 'Jazz Concert', field: 'titleAndDescription.title', description: 'English title fragment' },
    { type: 'event', query: 'Toma Rudzinska', field: 'titleAndDescription.title', description: 'Artist name in title' },
    { type: 'event', query: 'koncertcikls', field: 'titleAndDescription.title', description: 'Latvian word variation' },
    { type: 'event', query: 'Džeza koncerts', field: 'titleAndDescription.title', description: 'Alternative Latvian phrasing' },

    // Venue name variations  
    { type: 'venue', query: 'Mazā Ģilde', field: 'venueName', description: 'Short venue name' },
    { type: 'venue', query: 'Small Guild', field: 'venueName', description: 'English translation' },
    { type: 'venue', query: 'Cultural Center', field: 'venueName', description: 'Venue type' },
    { type: 'venue', query: 'Kultūras centrs', field: 'venueName', description: 'Latvian venue type' },

    // Cross-type searches (venue names in events)
    { type: 'event', query: 'Mazā Ģilde', field: 'venue.name', description: 'Venue name in event data' },
    { type: 'event', query: 'Small Guild', field: 'venue.name', description: 'English venue name in event data' },

    // Address variations
    { type: 'venue', query: 'Amatu iela 5', field: 'address', description: 'Full Latvian address' },
    { type: 'venue', query: 'Amatu street 5', field: 'address', description: 'English address' },
    { type: 'venue', query: 'Amatu 5', field: 'address', description: 'Short address' }
];

export default createAgent({
    handleTask: async (ctx) => {
        try {
            ctx.logger.info("🚀 Starting semantic search test with entity alignment");

            // Step 1: Store test events with entity alignment (exactly like your code)
            ctx.logger.info("📝 Storing test events...");
            for (const testEvent of testEvents) {
                await ctx.memory.semantic.set(testEvent.key, testEvent.data, {
                    tags: ['event', 'Riga', testEvent.data.titleAndDescription[0].language || 'unknown'],
                    entities: {
                        "titleAndDescription.title": "event",
                        "venue.name": "location"
                    }
                });
                ctx.logger.info(`✅ Stored event: ${testEvent.key}`);
            }

            // Step 2: Store test venues with entity alignment (exactly like your code)  
            ctx.logger.info("🏢 Storing test venues...");
            for (const testVenue of testVenues) {
                await ctx.memory.semantic.set(testVenue.key, testVenue.data, {
                    tags: ['venue', 'Riga', 'Latvia'],
                    entities: {
                        venueName: 'location',
                        address: 'location'
                    }
                });
                ctx.logger.info(`✅ Stored venue: ${testVenue.key}`);
            }

            // Step 3: Test semantic search with various combinations
            ctx.logger.info("🔍 Testing semantic search combinations...");

            const results = [];

            for (const test of searchTests) {
                ctx.logger.info(`\n🧪 Testing: ${test.description}`);
                ctx.logger.info(`   Query: "${test.query}" in field "${test.field}"`);
                ctx.logger.info(`   Type: ${test.type}`);

                try {
                    // Use entity-aware search with ~ operator
                    const searchResults = await ctx.memory.semantic.getMany({
                        filters: [`${test.field} ~ "${test.query}"`],
                        tag: test.type,
                        limit: 10
                    });

                    ctx.logger.info(`   📊 Found ${searchResults.length} matches`);

                    if (searchResults.length > 0) {
                        for (let i = 0; i < searchResults.length; i++) {
                            const result = searchResults[i];
                            const value = result.value as any;
                            const title = value.titleAndDescription?.[0]?.title ||
                                value.venueName ||
                                'Unknown';
                            ctx.logger.info(`   ${i + 1}. ${result.key} - "${title}"`);
                        }
                    } else {
                        ctx.logger.info(`   ❌ No matches found`);
                    }

                    results.push({
                        test: test.description,
                        query: test.query,
                        field: test.field,
                        type: test.type,
                        matches: searchResults.length,
                        keys: searchResults.map(r => r.key)
                    });

                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    ctx.logger.error(`   💥 Error: ${errorMessage}`);
                    results.push({
                        test: test.description,
                        query: test.query,
                        field: test.field,
                        type: test.type,
                        error: errorMessage
                    });
                }
            }

            // Step 4: Summary of results
            ctx.logger.info("\n📊 SUMMARY OF RESULTS:");
            for (const result of results) {
                if (result.error) {
                    ctx.logger.info(`❌ ${result.test}: ERROR - ${result.error}`);
                } else {
                    const matches = result.matches ?? 0;
                    ctx.logger.info(`${matches > 0 ? '✅' : '❌'} ${result.test}: ${matches} matches`);
                }
            }

            // Step 5: Clean up test data
            ctx.logger.info("\n🧹 Cleaning up test data...");

            // Delete test events
            for (const testEvent of testEvents) {
                await ctx.memory.semantic.delete(testEvent.key);
                ctx.logger.info(`🗑️ Deleted event: ${testEvent.key}`);
            }

            // Delete test venues
            for (const testVenue of testVenues) {
                await ctx.memory.semantic.delete(testVenue.key);
                ctx.logger.info(`🗑️ Deleted venue: ${testVenue.key}`);
            }

            ctx.logger.info("✅ Test completed and cleaned up!");

            await ctx.complete(100, 'Semantic search test completed');

            return {
                totalTests: searchTests.length,
                successfulMatches: results.filter(r => (r.matches ?? 0) > 0).length,
                errors: results.filter(r => r.error).length,
                results: results
            };

        } catch (error) {
            ctx.logger.error('Failed to perform semantic search test:', error);
            throw error;
        }
    }
}, import.meta.url); 