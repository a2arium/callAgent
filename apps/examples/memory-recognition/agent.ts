import { createAgent } from '@callagent/core';
import { completeEventSchema } from './eventSchema.js';

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
            "titleAndDescription.title": "event",
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
            "titleAndDescription.title": "event",
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
            "titleAndDescription.title": "event",
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
            "titleAndDescription.title": "event",
            "venue.name": "location"
        },
        expectedMatch: "uncertain - needs LLM"
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
    handleTask: handleMemoryRecognitionTask,
}, import.meta.url);

/**
 * Main task handler for memory recognition demonstration
 */
async function handleMemoryRecognitionTask(ctx: any) {
    const mode = (ctx.task.input as any)?.mode || 'both';

    ctx.logger.info(`🧠 Memory Recognition Demo Agent Started (mode: ${mode})`);
    ctx.logger.info(`📊 Goal: Test and demonstrate semantic memory recognition and enrichment capabilities`);

    try {
        // Setup: Store sample data
        await setupSampleData(ctx);

        if (mode === 'recognize' || mode === 'both') {
            await demonstrateRecognition(ctx);
        }

        if (mode === 'enrich' || mode === 'both') {
            await demonstrateEnrichment(ctx);
        }

        // Cleanup
        await cleanupDemoData(ctx);

        ctx.logger.info(`✅ Demo completed successfully!`);

    } catch (error) {
        ctx.logger.error('❌ Demo failed:', error);
        throw error;
    }
}

/**
 * Setup sample data for demonstration
 */
async function setupSampleData(ctx: any) {
    ctx.logger.info(`📋 Setting up sample data...`);

    for (const sample of sampleEvents) {
        await ctx.memory.semantic.set(sample.key, sample.data, {
            tags: sample.tags,
            entities: sample.entities
        });
        ctx.logger.info(`   ✓ Stored: ${sample.key}`);
    }

    ctx.logger.info(`📋 Sample data ready!\n`);
}

/**
 * Demonstrate recognition functionality
 */
async function demonstrateRecognition(ctx: any) {
    ctx.logger.info(`🔍 === RECOGNITION DEMONSTRATION ===\n`);

    for (const candidate of recognitionCandidates) {
        ctx.logger.info(`🧪 Testing: "${candidate.name}"`);
        ctx.logger.info(`📝 Candidate data:`);
        ctx.logger.info(`   Title: ${candidate.data.titleAndDescription[0].title}`);
        ctx.logger.info(`   Venue: ${candidate.data.venue.name}`);

        try {
            const result = await ctx.memory.semantic.recognize(candidate.data, {
                entities: candidate.entities,
                tags: ["event"],
                threshold: 0.75,
                llmLowerBound: 0.60,  // Lowered from 0.65 to capture more cases
                llmUpperBound: 0.85
            });

            ctx.logger.info(`📊 Recognition Result:`);
            ctx.logger.info(`   Is Match: ${result.isMatch}`);
            ctx.logger.info(`   Confidence: ${result.confidence.toFixed(3)}`);
            ctx.logger.info(`   Used LLM: ${result.usedLLM}`);

            if (result.matchingKey) {
                ctx.logger.info(`   Matching Key: ${result.matchingKey}`);
            }

            if (result.explanation) {
                ctx.logger.info(`   LLM Explanation: ${result.explanation}`);
            }

            // Validate against expected result
            const expected = candidate.expectedMatch;
            if (typeof expected === 'boolean') {
                const correct = result.isMatch === expected;
                ctx.logger.info(`   Expected: ${expected}, Got: ${result.isMatch} ${correct ? '✅' : '❌'}`);
            } else {
                ctx.logger.info(`   Expected: ${expected} ${result.usedLLM ? '✅' : '❌'}`);
            }

        } catch (error) {
            ctx.logger.error(`   ❌ Recognition failed:`, error);
        }

        ctx.logger.info(``); // Empty line for spacing
    }
}

/**
 * Demonstrate enrichment functionality
 */
async function demonstrateEnrichment(ctx: any) {
    ctx.logger.info(`🔧 === ENRICHMENT DEMONSTRATION ===\n`);

    for (const testCase of enrichmentTestData) {
        ctx.logger.info(`🧪 Testing: "${testCase.name}"`);

        // Show original data
        const originalData = await ctx.memory.semantic.get(testCase.baseKey);
        ctx.logger.info(`📝 Original data (${testCase.baseKey}):`);
        ctx.logger.info(`${JSON.stringify(originalData, null, 2)}\n`);

        // Show additional sources
        ctx.logger.info(`📚 Additional sources to merge:`);
        testCase.additionalSources.forEach((source, i) => {
            ctx.logger.info(`   Source ${i + 1}: ${JSON.stringify(source, null, 2)}`);
        });

        try {
            const result = await ctx.memory.semantic.enrich(testCase.baseKey, testCase.additionalSources, {
                schema: completeEventSchema
            });

            ctx.logger.info(`📊 Enrichment Result:`);
            ctx.logger.info(`   Used LLM: ${result.usedLLM}`);
            ctx.logger.info(`   Changes Made: ${result.changes.length}`);

            // Show changes
            if (result.changes.length > 0) {
                ctx.logger.info(`\n📋 Changes Applied:`);
                result.changes.forEach((change: any, i: number) => {
                    ctx.logger.info(`   ${i + 1}. Field: ${change.field}`);
                    ctx.logger.info(`      Action: ${change.action}`);
                    ctx.logger.info(`      Source: ${change.source}`);
                    if (change.oldValue !== undefined) {
                        ctx.logger.info(`      Old: ${JSON.stringify(change.oldValue)}`);
                    }
                    ctx.logger.info(`      New: ${JSON.stringify(change.newValue)}`);
                });
            }

            // Show final enriched data
            ctx.logger.info(`\n📦 Enriched Data:`);
            ctx.logger.info(`${JSON.stringify(result.enrichedData, null, 2)}`);

            if (result.explanation) {
                ctx.logger.info(`\n💡 LLM Explanation: ${result.explanation}`);
            }

        } catch (error) {
            ctx.logger.error(`   ❌ Enrichment failed:`, error);
        }

        ctx.logger.info(``); // Empty line for spacing
    }
}

/**
 * Clean up demo data
 */
async function cleanupDemoData(ctx: any) {
    ctx.logger.info(`🧹 Cleaning up demo data...`);

    for (const sample of sampleEvents) {
        try {
            await ctx.memory.semantic.delete(sample.key);
            ctx.logger.info(`   ✓ Deleted: ${sample.key}`);
        } catch (error) {
            ctx.logger.warn(`   ⚠️ Failed to delete ${sample.key}:`, error);
        }
    }

    ctx.logger.info(`🧹 Cleanup completed!`);
}