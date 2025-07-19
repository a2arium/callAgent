#!/usr/bin/env node
import 'dotenv/config';
import { logger } from '@callagent/utils';
import { AgentResultCache, CacheCleanupService } from '../core/cache/index.js';

// Create CLI logger
const cliLogger = logger.createLogger({ prefix: 'CacheCLI' });

/**
 * Cache CLI Operations
 * 
 * Provides command-line interface for cache management:
 * - cleanup: Remove expired cache entries
 * - clear: Clear cache by agent or tenant
 * - stats: Show cache statistics
 */

type CacheCommand = 'cleanup' | 'clear' | 'stats' | 'help';

interface CacheOptions {
    agent?: string;
    tenant?: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): { command: CacheCommand; options: CacheOptions } {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
        return { command: 'help', options: {} };
    }

    const command = args[0] as CacheCommand;
    const options: CacheOptions = {};

    // Parse options
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--agent=')) {
            options.agent = arg.split('=')[1];
        } else if (arg.startsWith('--tenant=')) {
            options.tenant = arg.split('=')[1];
        }
    }

    return { command, options };
}

/**
 * Show help information
 */
function showHelp(): void {
    console.log(`
Cache Management CLI

Usage:
  yarn cache <command> [options]

Commands:
  cleanup                   Remove all expired cache entries
  clear --agent=<name>      Clear all cache entries for specific agent
  clear --tenant=<id>       Clear all cache entries for specific tenant  
  clear --agent=<name> --tenant=<id>  Clear cache for agent in specific tenant
  stats                     Show cache statistics
  help                      Show this help message

Options:
  --agent=<name>           Target specific agent
  --tenant=<id>            Target specific tenant

Examples:
  yarn cache cleanup
  yarn cache clear --agent=llm-agent
  yarn cache clear --tenant=customer-123
  yarn cache clear --agent=llm-agent --tenant=customer-123
  yarn cache stats
`);
}

/**
 * Initialize cache services
 */
async function initializeCacheServices(): Promise<{
    cache: AgentResultCache;
    cleanup: CacheCleanupService;
    prisma: any;
}> {
    try {
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        const cache = new AgentResultCache(prisma);
        const cleanup = new CacheCleanupService(prisma);

        return { cache, cleanup, prisma };
    } catch (error) {
        cliLogger.error('Failed to initialize cache services', error);
        throw new Error('Cache services initialization failed');
    }
}

/**
 * Execute cleanup command
 */
async function executeCleanup(): Promise<void> {
    console.log('🧹 Cleaning up expired cache entries...');

    const { cleanup, prisma } = await initializeCacheServices();

    try {
        const removedCount = await cleanup.cleanup();
        console.log(`✅ Cleanup completed: removed ${removedCount} expired entries`);
    } finally {
        await prisma.$disconnect();
    }
}

/**
 * Execute clear command
 */
async function executeClear(options: CacheOptions): Promise<void> {
    const { cache, cleanup, prisma } = await initializeCacheServices();

    try {
        let removedCount = 0;

        if (options.agent && options.tenant) {
            console.log(`🗑️  Clearing cache for agent "${options.agent}" in tenant "${options.tenant}"...`);
            removedCount = await cache.clearAgentCache(options.agent, options.tenant);
        } else if (options.agent) {
            console.log(`🗑️  Clearing cache for agent "${options.agent}" (all tenants)...`);
            removedCount = await cleanup.clearAgentCache(options.agent);
        } else if (options.tenant) {
            console.log(`🗑️  Clearing cache for tenant "${options.tenant}"...`);
            removedCount = await cleanup.clearTenantCache(options.tenant);
        } else {
            console.error('❌ Clear command requires --agent or --tenant option');
            process.exit(1);
        }

        console.log(`✅ Clear completed: removed ${removedCount} entries`);
    } finally {
        await prisma.$disconnect();
    }
}

/**
 * Execute stats command
 */
async function executeStats(): Promise<void> {
    console.log('📊 Getting cache statistics...');

    const { cleanup, prisma } = await initializeCacheServices();

    try {
        const stats = await cleanup.getStats();

        console.log('\n📈 Cache Statistics:');
        console.log(`  Total entries: ${stats.totalEntries}`);
        console.log(`  Active entries: ${stats.activeEntries}`);
        console.log(`  Expired entries: ${stats.expiredEntries}`);

        if (stats.oldestEntry) {
            console.log(`  Oldest entry: ${stats.oldestEntry.toISOString()}`);
        }

        if (stats.newestEntry) {
            console.log(`  Newest entry: ${stats.newestEntry.toISOString()}`);
        }

        if (Object.keys(stats.agentBreakdown).length > 0) {
            console.log('\n🤖 By Agent:');
            Object.entries(stats.agentBreakdown)
                .sort(([, a], [, b]) => b - a)
                .forEach(([agentName, count]) => {
                    console.log(`  ${agentName}: ${count} entries`);
                });
        }

        console.log('');
    } finally {
        await prisma.$disconnect();
    }
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
    const { command, options } = parseArgs();

    cliLogger.info('Cache CLI started', { command, options });

    try {
        switch (command) {
            case 'cleanup':
                await executeCleanup();
                break;

            case 'clear':
                await executeClear(options);
                break;

            case 'stats':
                await executeStats();
                break;

            case 'help':
                showHelp();
                break;

            default:
                console.error(`❌ Unknown command: ${command}`);
                console.error('Run "yarn cache help" for usage information');
                process.exit(1);
        }

        cliLogger.info('Cache CLI completed successfully');
    } catch (error: unknown) {
        if (error instanceof Error) {
            cliLogger.error('Cache CLI error', error);
            console.error(`❌ Error: ${error.message}`);
        } else {
            cliLogger.error('Unknown error', error);
            console.error('❌ Unknown error occurred');
        }
        process.exit(1);
    }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    cliLogger.error('Uncaught exception', error);
    console.error('❌ Fatal error occurred');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    cliLogger.error('Unhandled rejection', reason);
    console.error('❌ Fatal error occurred');
    process.exit(1);
});

// Run CLI
main(); 