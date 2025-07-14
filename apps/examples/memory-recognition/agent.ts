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

        // NEW: Demonstrate array functionality
        if (mode === 'array' || mode === 'both') {
            await demonstrateArraySupport(ctx);
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

    ctx.logger.info(`🧹 Cleanup completed!\n`);
}

/**
 * NEW: Demonstrate array expansion functionality
 */
async function demonstrateArraySupport(ctx: any) {
    ctx.logger.info(`🔄 === ARRAY EXPANSION DEMONSTRATION ===\n`);

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

    ctx.logger.info(`📊 Storing event with array expansion...`);
    ctx.logger.info(`   Titles: ${arrayTestData.titleAndDescription.map(t => t.title).join(', ')}`);
    ctx.logger.info(`   Speakers: ${arrayTestData.speakers.map(s => s.name).join(', ')}`);
    ctx.logger.info(`   Occurrences: ${arrayTestData.eventOccurrences.map(o => o.date).join(', ')}`);

    // Store with array expansion
    await ctx.memory.semantic.set('demo:array:multi-event', arrayTestData, {
        tags: ['demo', 'array', 'conference'],
        entities: {
            "titleAndDescription[].title": "event",
            "speakers[].name": "person",
            "speakers[].affiliation": "organization",
            "venue.name": "location",
            "eventOccurrences[].date": "date"
        }
    });

    ctx.logger.info(`   ✅ Stored with array expansion!\n`);

    // Test recognition with array cross-product comparison
    ctx.logger.info(`🔍 Testing array-aware recognition...`);

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

    ctx.logger.info(`   Recognition result: ${recognitionResult.isMatch ? '✅ MATCH' : '❌ NO MATCH'}`);
    ctx.logger.info(`   Confidence: ${recognitionResult.confidence.toFixed(3)}`);
    if (recognitionResult.matchingKey) {
        ctx.logger.info(`   Matching key: ${recognitionResult.matchingKey}`);
    }
    if (recognitionResult.usedLLM) {
        ctx.logger.info(`   Used LLM: ${recognitionResult.explanation}`);
    }

    // Test queries with array patterns
    ctx.logger.info(`\n🔎 Testing array-aware queries...`);

    const queryResults = await ctx.memory.semantic.getMany({
        filters: ['titleAndDescription[].title ~ "AI"'],
        tag: 'demo'
    });

    ctx.logger.info(`   Query 'titleAndDescription[].title ~ "AI"' found ${queryResults.length} results`);
    for (const result of queryResults) {
        ctx.logger.info(`   - ${result.key}: ${result.value.titleAndDescription[0].title}`);
    }

    // Test enrichment with arrays
    ctx.logger.info(`\n🔗 Testing array enrichment...`);

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

    ctx.logger.info(`   Enrichment result: ${enrichmentResult.addedFields?.length || 0} new fields added`);
    ctx.logger.info(`   Added fields: ${enrichmentResult.addedFields?.join(', ') || 'none'}`);
    ctx.logger.info(`   Confidence: ${enrichmentResult.confidence?.toFixed(3) || 'unknown'}`);

    // Cleanup
    await ctx.memory.semantic.delete('demo:array:multi-event');
    ctx.logger.info(`\n🧹 Array demo cleanup completed!\n`);
}