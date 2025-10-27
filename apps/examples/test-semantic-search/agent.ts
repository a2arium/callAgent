import { createAgent } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';

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
            logger.info("🚀 Starting semantic search test with entity alignment");

            // Step 1: Store test events with entity alignment (exactly like your code)
            logger.info("📝 Storing test events...");
            for (const testEvent of testEvents) {
                await ctx.semantic?.add({ id: testEvent.key, value: testEvent.data, tags: ['event', 'Riga', testEvent.data.titleAndDescription[0].language || 'unknown'], entities: { "titleAndDescription.title": "event", "venue.name": "location" } });
                logger.info(`✅ Stored event: ${testEvent.key}`);
            }

            // Step 2: Store test venues with entity alignment (exactly like your code)  
            logger.info("🏢 Storing test venues...");
            for (const testVenue of testVenues) {
                await ctx.semantic?.add({ id: testVenue.key, value: testVenue.data, tags: ['venue', 'Riga', 'Latvia'], entities: { venueName: 'location', address: 'location' } });
                logger.info(`✅ Stored venue: ${testVenue.key}`);
            }

            // Step 3: Test semantic search with various combinations
            logger.info("🔍 Testing semantic search combinations...");

            const results = [];

            for (const test of searchTests) {
                logger.info(`\n🧪 Testing: ${test.description}`);
                logger.info(`   Query: "${test.query}" in field "${test.field}"`);
                logger.info(`   Type: ${test.type}`);

                try {
                    // Use entity-aware search with ~ operator
                    if (!ctx.semantic?.read) {
                        throw new Error('Semantic memory is not available (ctx.semantic.read is undefined)');
                    }
                    const searchResults = await ctx.semantic.read({
                        filters: [`${test.field} ~ "${test.query}"`],
                        tag: test.type,
                        limit: 10
                    } as any);

                    logger.info(`   📊 Found ${searchResults.length} matches`);

                    if (searchResults.length > 0) {
                        for (let i = 0; i < searchResults.length; i++) {
                            const result = searchResults[i];
                            const value = result.value as any;
                            const title = value.titleAndDescription?.[0]?.title ||
                                value.venueName ||
                                'Unknown';
                            logger.info(`   ${i + 1}. ${result.id} - "${title}"`);
                        }
                    } else {
                        logger.info(`   ❌ No matches found`);
                    }

                    results.push({
                        test: test.description,
                        query: test.query,
                        field: test.field,
                        type: test.type,
                        matches: searchResults.length,
                        keys: searchResults.map((r: any) => r.id)
                    });

                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    logger.error(`   💥 Error: ${errorMessage}`);
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
            logger.info("\n📊 SUMMARY OF RESULTS:");
            for (const result of results) {
                if (result.error) {
                    logger.info(`❌ ${result.test}: ERROR - ${result.error}`);
                } else {
                    const matches = result.matches ?? 0;
                    logger.info(`${matches > 0 ? '✅' : '❌'} ${result.test}: ${matches} matches`);
                }
            }

            // Step 5: Clean up test data
            logger.info("\n🧹 Cleaning up test data...");

            // Delete test events
            for (const testEvent of testEvents) {
                await ctx.semantic?.remove?.(testEvent.key);
                logger.info(`🗑️ Deleted event: ${testEvent.key}`);
            }

            // Delete test venues
            for (const testVenue of testVenues) {
                await ctx.semantic?.remove?.(testVenue.key);
                logger.info(`🗑️ Deleted venue: ${testVenue.key}`);
            }

            logger.info("✅ Test completed and cleaned up!");

            await ctx.complete(100, 'Semantic search test completed');

            return {
                totalTests: searchTests.length,
                successfulMatches: results.filter(r => (r.matches ?? 0) > 0).length,
                errors: results.filter(r => r.error).length,
                results: results
            };

        } catch (error) {
            logger.error('Failed to perform semantic search test:', error as any);
            throw error;
        }
    }
}, import.meta.url); 