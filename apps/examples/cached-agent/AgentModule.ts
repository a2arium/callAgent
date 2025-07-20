import { createAgent } from '@a2arium/callagent-core';
import type { TaskContext } from '@a2arium/callagent-core';

interface CacheExampleInput {
    operation: string;
    data?: string;
    timestamp?: string;
    requestId?: string;
    user?: {
        id: string;
        name: string;
        sessionId?: string;
    };
}

interface CacheExampleOutput {
    result: string;
    processedAt: string;
    executionTime: number;
    processingCost: number;
    cacheStatus: 'miss' | 'potential_hit';
}

/**
 * Cached Agent Example
 * 
 * This agent demonstrates result caching functionality including:
 * - TTL-based cache expiration (60 seconds)
 * - Path exclusions (timestamp, requestId, user.sessionId won't affect cache keys)
 * - Artificial processing delay to show cache benefits
 * - Different operations with different processing costs
 */

// Simulate processing delay to demonstrate cache benefits
async function simulateProcessing(operation: string): Promise<{ result: string; cost: number }> {
    const operations = {
        'complex-calculation': { delay: 3000, cost: 10.50, result: 'Complex mathematical computation completed' },
        'data-analysis': { delay: 5000, cost: 15.25, result: 'Data analysis and statistical modeling finished' },
        'image-processing': { delay: 8000, cost: 22.75, result: 'Image processing and enhancement completed' },
        'text-generation': { delay: 4000, cost: 12.00, result: 'Natural language text generation completed' },
        'default': { delay: 2000, cost: 5.00, result: 'Basic processing completed' }
    };

    const config = operations[operation as keyof typeof operations] || operations.default;

    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, config.delay));

    return {
        result: config.result,
        cost: config.cost
    };
}

async function handleTask(ctx: TaskContext): Promise<CacheExampleOutput> {
    const input = ctx.task.input as unknown as CacheExampleInput;
    const startTime = Date.now();

    ctx.logger.info('🔄 Starting cached agent execution', {
        operation: input.operation,
        hasTimestamp: !!input.timestamp,
        hasRequestId: !!input.requestId,
        hasSessionId: !!input.user?.sessionId
    });

    // Log cache-relevant information
    ctx.logger.info('📊 Cache configuration active', {
        ttl: '60 seconds',
        excludedPaths: ['timestamp', 'requestId', 'user.sessionId'],
        note: 'Identical operations will be cached regardless of excluded fields'
    });

    // Update status
    ctx.updateStatus('processing');
    await ctx.reply([{
        type: 'text',
        text: `🚀 Processing ${input.operation || 'default'} operation...`
    }]);

    // Simulate expensive processing
    const processing = await simulateProcessing(input.operation || 'default');
    const executionTime = Date.now() - startTime;

    // Create result
    const result: CacheExampleOutput = {
        result: processing.result,
        processedAt: new Date().toISOString(),
        executionTime,
        processingCost: processing.cost,
        cacheStatus: 'miss' // This execution was not from cache
    };

    // Log completion
    ctx.logger.info('✅ Processing completed', {
        operation: input.operation,
        executionTime: `${executionTime}ms`,
        cost: `$${processing.cost}`,
        cacheNote: 'Result will be cached for 60 seconds'
    });

    await ctx.reply([{
        type: 'text',
        text: `✅ Operation completed in ${executionTime}ms (Cost: $${processing.cost})\n` +
            `Result: ${processing.result}\n\n` +
            `💡 This result is now cached for 60 seconds. ` +
            `Identical operations (ignoring timestamp, requestId, user.sessionId) ` +
            `will return instantly from cache.`
    }]);

    return result;
}

// Create and export the agent
export default createAgent({
    handleTask
}, import.meta.url); 