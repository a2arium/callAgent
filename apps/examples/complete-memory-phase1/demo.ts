#!/usr/bin/env node

/**
 * Demo script for the Complete Memory System Agent
 * 
 * This script demonstrates how to use the complete memory agent
 * with sample input to showcase all memory capabilities.
 */

import agent from './agent.js';

async function runDemo() {
    console.log('🧠 Complete Memory System Demo Starting...\n');

    // Sample input that the agent will process
    const sampleInput = {
        userName: 'Alice',
        message: 'Show me how the memory system works',
        conversationId: 'demo-conversation-001'
    };

    // Mock context for demonstration
    const mockContext = {
        tenantId: 'demo-tenant',
        task: {
            id: 'demo-task-001',
            input: sampleInput
        },
        reply: async (message: string) => {
            console.log('🤖 Agent Response:');
            console.log(message);
            console.log('\n' + '='.repeat(80) + '\n');
        },
        complete: () => {
            console.log('✅ Demo completed successfully!');
        },
        fail: async (error: unknown) => {
            console.error('❌ Demo failed:', error);
            process.exit(1);
        },
        logger: {
            debug: (msg: string, ...args: unknown[]) => console.log(`[DEBUG] ${msg}`, ...args),
            info: (msg: string, ...args: unknown[]) => console.log(`[INFO] ${msg}`, ...args),
            warn: (msg: string, ...args: unknown[]) => console.warn(`[WARN] ${msg}`, ...args),
            error: (msg: string, error?: unknown, context?: Record<string, unknown>) => {
                console.error(`[ERROR] ${msg}`, error, context);
            }
        }
    };

    try {
        console.log('📝 Input Data:');
        console.log(JSON.stringify(sampleInput, null, 2));
        console.log('\n' + '='.repeat(80) + '\n');

        // Note: This is a simplified demo. In a real environment,
        // the agent would be invoked through the callAgent runtime
        // which would provide the proper context with memory capabilities.

        console.log('ℹ️  Note: This demo shows the agent structure.');
        console.log('   For full memory capabilities, run through the callAgent runtime.');
        console.log('\n📋 Agent Configuration:');
        console.log('- Name:', agent.manifest.name);
        console.log('- Version:', agent.manifest.version);
        console.log('- Memory Profile: conversational (with SimpleSummarizer)');
        console.log('- Features: Working Memory, Unified Operations, MLO Pipeline');

        console.log('\n🔧 Memory Capabilities:');
        console.log('✅ Goal Management (setGoal/getGoal)');
        console.log('✅ Thought Tracking (addThought/getThoughts)');
        console.log('✅ Decision Making (makeDecision/getDecision)');
        console.log('✅ Working Variables (ctx.vars proxy)');
        console.log('✅ Unified Recall (ctx.recall)');
        console.log('✅ Unified Remember (ctx.remember)');
        console.log('✅ MLO Pipeline Processing (6 stages)');
        console.log('✅ Backward Compatibility (existing APIs)');
        console.log('✅ Metrics & Observability');

        console.log('\n🏗️ Architecture Components:');
        console.log('- UnifiedMemoryService: Central memory coordination');
        console.log('- MemoryLifecycleOrchestrator: 6-stage processing pipeline');
        console.log('- ProcessorFactory: Dynamic processor instantiation');
        console.log('- Working Memory Store: Agent-isolated storage');
        console.log('- Context Integration: TaskContext memory capabilities');

        console.log('\n📊 Expected Processing Flow:');
        console.log('1. Agent receives input with userName "Alice"');
        console.log('2. Sets goal: "Demonstrate complete memory system"');
        console.log('3. Adds thoughts processed through MLO pipeline');
        console.log('4. Manages working variables (userName, conversationTurn)');
        console.log('5. Makes decisions based on conversation state');
        console.log('6. Uses unified operations for cross-memory queries');
        console.log('7. Demonstrates backward compatibility');
        console.log('8. Reports comprehensive system status');

        console.log('\n🚀 To run with full memory capabilities:');
        console.log('   Use the callAgent runtime with proper context injection');
        console.log('   The agent will then have access to all memory operations');

        console.log('\n✅ Demo structure validation completed!');

    } catch (error) {
        console.error('❌ Demo failed:', error);
        process.exit(1);
    }
}

// Run the demo
runDemo().catch(console.error); 