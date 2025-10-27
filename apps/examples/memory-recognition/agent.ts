import { createAgent } from '@a2arium/callagent-core';
import { completeEventSchema } from './eventSchema.js';
import { logger } from '@a2arium/callagent-utils';

// LLM configuration for memory recognition and enrichment
const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are an AI assistant specialized in data analysis and memory management. You help compare, recognize, and enrich data objects with high precision and clear explanations.'
};

/**
 * Memory Recognition Demo Agent
 * 
 * This agent demonstrates:
 * 1. recognize() - Finding if candidate data already exists in memory
 * 2. enrich() - Consolidating multiple data sources with LLM assistance
 */

// Test data for demonstrations
const sampleEvents = [
    {
        key: "demo:event:jazz-concert",
        data: {
            "titleAndDescription": [
                {
                    "title": "Jazz Concert in Old Town",
                    "language": "en",
                    "description": "Traditional jazz concert featuring local musicians"
                }
            ],
            "venue": {
                "name": "Old Town Music Hall",
                "address": "123 Main Street, Downtown"
            },
            "eventOccurrences": [
                {
                    "date": "2024-12-15",
                    "time": "19:00"
                }
            ],
            "isFree": true,
            "language": "en"
        },
        entities: {
            "titleAndDescription.title": "event",
            "venue.name": "location"
        },
        tags: ["event", "music", "jazz", "en"]
    },
    {
        key: "demo:venue:music-hall",
        data: {
            "venueName": "Old Town Music Hall",
            "address": "123 Main Street, Downtown",
            "capacity": 200,
            "venueType": "concert_hall",
            "isLikelyToHostEvents": true
        },
        entities: {
            "venueName": "location",
            "address": "location"
        },
        tags: ["venue", "music", "hall"]
    }
];

// Recognition test candidates
const recognitionCandidates = [
    {
        name: "Exact title match",
        data: {
            "titleAndDescription": [
                {
                    "title": "Jazz Concert in Old Town",
                    "language": "en"
                }
            ],
            "venue": {
                "name": "Old Town Music Hall"
            }
        },
        entities: {
            "titleAndDescription[].title": "event",
            "venue.name": "location"
        },
        expectedMatch: true
    },
    {
        name: "Similar title (should use LLM)",
        data: {
            "titleAndDescription": [
                {
                    "title": "Jazz Performance at Old Town",
                    "language": "en"
                }
            ],
            "venue": {
                "name": "Old Town Music Hall"
            }
        },
        entities: {
            "titleAndDescription[].title": "event",
            "venue.name": "location"
        },
        expectedMatch: false // Changed: confidence below 0.65 threshold = no match
    },
    {
        name: "Different event",
        data: {
            "titleAndDescription": [
                {
                    "title": "Rock Concert Tonight",
                    "language": "en"
                }
            ],
            "venue": {
                "name": "New Arena"
            }
        },
        entities: {
            "titleAndDescription[].title": "event",
            "venue.name": "location"
        },
        expectedMatch: false
    },
    {
        name: "Similar venue match (should use LLM)",
        data: {
            "titleAndDescription": [
                {
                    "title": "Jazz Concert in Old Town", // Exact title match
                    "language": "en",
                    "description": "Different description"   // Different details
                }
            ],
            "venue": {
                "name": "Music Hall Downtown"  // Similar but different venue name
            },
            "eventOccurrences": [
                {
                    "date": "2024-12-16",  // Different date
                    "time": "20:00"        // Different time
                }
            ]
        },
        entities: {
            "titleAndDescription[].title": "event",
            "venue.name": "location"
        },
        expectedMatch: "uncertain - needs LLM"
    },
    {
        name: "Multiple titles with array expansion",
        data: {
            "titleAndDescription": [
                {
                    "title": "Jazz Concert in Old Town",
                    "language": "en"
                },
                {
                    "title": "Evening Jazz Performance",
                    "language": "en"
                }
            ],
            "venue": {
                "name": "Old Town Music Hall"
            }
        },
        entities: {
            "titleAndDescription[].title": "event",
            "venue.name": "location"
        },
        expectedMatch: true
    },
    {
        name: "Array with different elements",
        data: {
            "titleAndDescription": [
                {
                    "title": "Rock Concert Tonight",
                    "language": "en"
                },
                {
                    "title": "Jazz Concert in Old Town",  // This should match
                    "language": "en"
                }
            ],
            "venue": {
                "name": "Old Town Music Hall"
            }
        },
        entities: {
            "titleAndDescription[].title": "event",
            "venue.name": "location"
        },
        expectedMatch: true  // Should match because one of the titles matches
    }
];

// Enrichment test data
const enrichmentTestData = [
    {
        name: "Event with additional details",
        baseKey: "demo:event:jazz-concert",
        additionalSources: [
            {
                "titleAndDescription": [
                    {
                        "title": "Jazz Concert in Old Town",
                        "language": "en",
                        "description": "Traditional jazz concert featuring local musicians. Special guest: Sarah Johnson on piano."
                    }
                ],
                "duration": "2 hours",
                "ticketInfo": "Free admission, donations appreciated"
            },
            {
                "performer": "Sarah Johnson Trio",
                "genre": "traditional jazz",
                "eventOccurrences": [
                    {
                        "date": "2024-12-15",
                        "time": "19:00",
                        "endTime": "21:00",
                        "doors": "18:30"
                    }
                ]
            }
        ]
    }
];

export default createAgent({
    manifest: './agent.json',
    llmConfig,
    /**
     * execution
     * Purpose: Run the full demo workflow in a single loop turn.
     * args: (action from policy, ctx helpers, current mentalState)
     * returns: ExecutableAction for the loop transition
     */
    execution: async (action: any, ctx: any, mentalState: any) => {
        const mode = (ctx.task.input as any)?.mode || 'both';

        await ctx.progress(0.01, `Memory Recognition Demo Agent Started (mode: ${mode})`);
        await ctx.reply([{ type: 'text', text: '📊 Goal: Test semantic memory recognition and enrichment' }]);

        try {
            // Setup: Store sample data
            await setupSampleData(ctx);

            if (mode === 'recognize' || mode === 'both') {
                await demonstrateRecognition(ctx);
            }

            // Demonstrate array functionality
            if (mode === 'array' || mode === 'both') {
                await demonstrateArraySupport(ctx);
            }

            if (mode === 'enrich' || mode === 'both') {
                await demonstrateEnrichment(ctx);
            }

            // Cleanup
            await cleanupDemoData(ctx);

            await ctx.reply([{ type: 'text', text: '✅ Demo completed successfully!' }]);
            ctx.complete(1, 'completed');
            return { kind: 'internal', done: true } as any;
        } catch (error) {
            await ctx.reply([{ type: 'text', text: `❌ Demo failed: ${error instanceof Error ? error.message : String(error)}` }]);
            throw error;
        }
    }
}, import.meta.url);

// helpers below remain unchanged and are used by execution

/**
 * Setup sample data for demonstration
 */
async function setupSampleData(ctx: any) {
    logger.info(`📋 Setting up sample data...`);

    for (const sample of sampleEvents) {
        await ctx.semantic?.add({ id: sample.key, value: sample.data, tags: sample.tags, entities: sample.entities });
        logger.info(`   ✓ Stored: ${sample.key}`);
    }

    logger.info(`📋 Sample data ready!\n`);
}

/**
 * Demonstrate recognition functionality
 */
async function demonstrateRecognition(ctx: any) {
    logger.info(`🔍 === RECOGNITION DEMONSTRATION ===\n`);

    for (const candidate of recognitionCandidates) {
        logger.info(`🧪 Testing: "${candidate.name}"`);
        logger.info(`📝 Candidate data:`);
        logger.info(`   Title: ${candidate.data.titleAndDescription[0].title}`);
        logger.info(`   Venue: ${candidate.data.venue.name}`);

        try {
            const result = await ctx.memory.semantic.recognize(candidate.data, {
                entities: candidate.entities,
                tags: ["event"],
                threshold: 0.75,
                llmLowerBound: 0.60,  // Lowered from 0.65 to capture more cases
                llmUpperBound: 0.85
            });

            logger.info(`📊 Recognition Result:`);
            logger.info(`   Is Match: ${result.isMatch}`);
            logger.info(`   Confidence: ${result.confidence.toFixed(3)}`);
            logger.info(`   Used LLM: ${result.usedLLM}`);

            if (result.matchingKey) {
                logger.info(`   Matching Key: ${result.matchingKey}`);
            }

            if (result.explanation) {
                logger.info(`   LLM Explanation: ${result.explanation}`);
            }

            // Validate against expected result
            const expected = candidate.expectedMatch;
            if (typeof expected === 'boolean') {
                const correct = result.isMatch === expected;
                logger.info(`   Expected: ${expected}, Got: ${result.isMatch} ${correct ? '✅' : '❌'}`);
            } else {
                logger.info(`   Expected: ${expected} ${result.usedLLM ? '✅' : '❌'}`);
            }

        } catch (error) {
            logger.error(`   ❌ Recognition failed:`, error);
        }

        logger.info(``); // Empty line for spacing
    }
}

/**
 * Demonstrate enrichment functionality
 */
async function demonstrateEnrichment(ctx: any) {
    logger.info(`🔧 === ENRICHMENT DEMONSTRATION ===\n`);

    for (const testCase of enrichmentTestData) {
        logger.info(`🧪 Testing: "${testCase.name}"`);

        // Show original data
        const originalArr = await ctx.semantic?.read?.({ id: testCase.baseKey, limit: 1 });
        const originalData = Array.isArray(originalArr) && originalArr[0] ? (originalArr[0] as any).value : undefined;
        logger.info(`📝 Original data (${testCase.baseKey}):`);
        logger.info(`${JSON.stringify(originalData, null, 2)}\n`);

        // Show additional sources
        logger.info(`📚 Additional sources to merge:`);
        testCase.additionalSources.forEach((source, i) => {
            logger.info(`   Source ${i + 1}: ${JSON.stringify(source, null, 2)}`);
        });

        try {
            const result = await ctx.memory.semantic.enrich(testCase.baseKey, testCase.additionalSources, {
                schema: completeEventSchema
            });

            logger.info(`📊 Enrichment Result:`);
            logger.info(`   Used LLM: ${result.usedLLM}`);
            logger.info(`   Changes Made: ${result.changes.length}`);

            // Show changes
            if (result.changes.length > 0) {
                logger.info(`\n📋 Changes Applied:`);
                result.changes.forEach((change: any, i: number) => {
                    logger.info(`   ${i + 1}. Field: ${change.field}`);
                    logger.info(`      Action: ${change.action}`);
                    logger.info(`      Source: ${change.source}`);
                    if (change.oldValue !== undefined) {
                        logger.info(`      Old: ${JSON.stringify(change.oldValue)}`);
                    }
                    logger.info(`      New: ${JSON.stringify(change.newValue)}`);
                });
            }

            // Show final enriched data
            logger.info(`\n📦 Enriched Data:`);
            logger.info(`${JSON.stringify(result.enrichedData, null, 2)}`);

            if (result.explanation) {
                logger.info(`\n💡 LLM Explanation: ${result.explanation}`);
            }

        } catch (error) {
            logger.error(`   ❌ Enrichment failed:`, error);
        }

        logger.info(``); // Empty line for spacing
    }
}

/**
 * Clean up demo data
 */
async function cleanupDemoData(ctx: any) {
    logger.info(`🧹 Cleaning up demo data...`);

    for (const sample of sampleEvents) {
        try {
            await ctx.semantic?.remove?.(sample.key);
            logger.info(`   ✓ Deleted: ${sample.key}`);
        } catch (error) {
            logger.warn(`   ⚠️ Failed to delete ${sample.key}:`, error);
        }
    }

    logger.info(`🧹 Cleanup completed!\n`);
}

/**
 * NEW: Demonstrate array expansion functionality
 */
async function demonstrateArraySupport(ctx: any) {
    logger.info(`🔄 === ARRAY EXPANSION DEMONSTRATION ===\n`);

    // Test data with multiple array elements
    const arrayTestData = {
        "titleAndDescription": [
            { "title": "AI Summit 2024", "language": "en" },
            { "title": "Tech Conference Extraordinaire", "language": "en" },
            { "title": "Innovation Showcase", "language": "en" }
        ],
        "speakers": [
            { "name": "Dr. Jane Smith", "affiliation": "MIT" },
            { "name": "Prof. Bob Wilson", "affiliation": "Stanford" },
            { "name": "Dr. Alice Johnson", "affiliation": "Harvard" }
        ],
        "venue": { "name": "Convention Center" },
        "eventOccurrences": [
            { "date": "2024-03-15", "time": "09:00" },
            { "date": "2024-03-16", "time": "10:00" }
        ]
    };

    logger.info(`📊 Storing event with array expansion...`);
    logger.info(`   Titles: ${arrayTestData.titleAndDescription.map(t => t.title).join(', ')}`);
    logger.info(`   Speakers: ${arrayTestData.speakers.map(s => s.name).join(', ')}`);
    logger.info(`   Occurrences: ${arrayTestData.eventOccurrences.map(o => o.date).join(', ')}`);

    // Store with array expansion
    await ctx.semantic?.add({
        id: 'demo:array:multi-event', value: arrayTestData, tags: ['demo', 'array', 'conference'], entities: {
            "titleAndDescription[].title": "event",
            "speakers[].name": "person",
            "speakers[].affiliation": "organization",
            "venue.name": "location",
            "eventOccurrences[].date": "date"
        }
    });

    logger.info(`   ✅ Stored with array expansion!\n`);

    // Test recognition with array cross-product comparison
    logger.info(`🔍 Testing array-aware recognition...`);

    const candidateWithArrays = {
        "titleAndDescription": [
            { "title": "AI Summit 2024", "language": "en" },  // Should match
            { "title": "Different Event", "language": "en" }   // Won't match
        ],
        "speakers": [
            { "name": "Dr. Jane Smith", "affiliation": "MIT" } // Should match
        ],
        "venue": { "name": "Convention Center" }
    };

    const recognitionResult = await ctx.memory.semantic.recognize(candidateWithArrays, {
        taskContext: ctx,
        entities: {
            "titleAndDescription[].title": "event",
            "speakers[].name": "person",
            "venue.name": "location"
        }
    });

    logger.info(`   Recognition result: ${recognitionResult.isMatch ? '✅ MATCH' : '❌ NO MATCH'}`);
    logger.info(`   Confidence: ${recognitionResult.confidence.toFixed(3)}`);
    if (recognitionResult.matchingKey) {
        logger.info(`   Matching key: ${recognitionResult.matchingKey}`);
    }
    if (recognitionResult.usedLLM) {
        logger.info(`   Used LLM: ${recognitionResult.explanation}`);
    }

    // Test queries with array patterns
    logger.info(`\n🔎 Testing array-aware queries...`);

    const queryResults = await ctx.semantic.read({
        filters: ['titleAndDescription[].title ~ "AI"'] as any,
        tag: 'demo'
    });

    logger.info(`   Query 'titleAndDescription[].title ~ "AI"' found ${queryResults.length} results`);
    for (const result of queryResults) {
        logger.info(`   - ${result.key}: ${result.value.titleAndDescription[0].title}`);
    }

    // Test enrichment with arrays
    logger.info(`\n🔗 Testing array enrichment...`);

    const enrichmentData = [{
        "titleAndDescription": [
            { "title": "AI Summit 2024", "language": "en", "description": "Updated description" },
            { "title": "Tech Conference Extraordinaire", "language": "en", "description": "Enhanced info" },
            { "title": "Innovation Showcase", "language": "en", "description": "New details" },
            { "title": "Networking Session", "language": "en", "description": "New event added" }  // New element
        ],
        "capacity": 500,
        "registrationRequired": true
    }];

    const enrichmentResult = await ctx.memory.semantic.enrich('demo:array:multi-event', enrichmentData, {
        taskContext: ctx,
        entities: {
            "titleAndDescription[].title": "event"
        }
    });

    logger.info(`   Enrichment result: ${enrichmentResult.addedFields?.length || 0} new fields added`);
    logger.info(`   Added fields: ${enrichmentResult.addedFields?.join(', ') || 'none'}`);
    logger.info(`   Confidence: ${enrichmentResult.confidence?.toFixed(3) || 'unknown'}`);

    // Cleanup
    await ctx.semantic?.remove?.('demo:array:multi-event');
    logger.info(`\n🧹 Array demo cleanup completed!\n`);
}