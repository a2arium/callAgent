import 'dotenv/config';
import { runAgentWithStreaming } from './streamingRunner.js';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { TaskEngine } from '../orchestration/taskEngine.js';
import { registerHandler } from '../orchestration/HandlerRegistry.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { EngineLocator } from '../orchestration/EngineLocator.js';
import { eventBus } from '../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import type { A2AEvent } from '../shared/types/StreamingEvents.js';
import { outboxPublisher } from '../eventbus/outboxPublisher.js';
import path from 'node:path';
import { logger } from '@a2arium/callagent-utils';

// Log uncaught exceptions and unhandled rejections early
process.on('uncaughtException', (err) => {
    console.error('--- Uncaught Exception Diagnostic ---');
    console.error('Raw Error Object:', err);
    console.error('Type of Error Object:', typeof err);
    console.error('Prototype of Error Object:', Object.getPrototypeOf(err));

    if (err instanceof Error) {
        console.error('Uncaught Exception (Error):', err.stack || err.message);
    } else {
        // Attempt to stringify non-Error objects for more details
        try {
            console.error('Uncaught Exception (non-Error):', JSON.stringify(err, null, 2));
        } catch (stringifyErr) {
            console.error('Could not stringify non-Error object.', stringifyErr);
        }
    }
    console.error('--- End Diagnostic ---');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('--- Unhandled Rejection Diagnostic ---');
    console.error('Raw Rejection Reason:', reason);
    console.error('Type of Rejection Reason:', typeof reason);
    console.error('Prototype of Rejection Reason:', Object.getPrototypeOf(reason));

    if (reason instanceof Error) {
        console.error('Unhandled Rejection (Error):', reason.stack || reason.message);
    } else {
        // Attempt to stringify non-Error objects for more details
        try {
            console.error('Unhandled Rejection (non-Error):', JSON.stringify(reason, null, 2));
        } catch (stringifyErr) {
            console.error('Could not stringify non-Error object.', stringifyErr);
        }
    }
    console.error('--- End Diagnostic ---');
    process.exit(1);
});

// Create runner-specific logger
const cliLogger = logger.createLogger({ prefix: 'RunnerCLI' });

/**
 * Parse command-line arguments for the runner
 * This CLI supports both streaming and non-streaming modes with various output formats
 */
function parseArgs(): {
    agentFilePath: string;
    input: Record<string, unknown>;
    options: {
        isStreaming: boolean;
        outputType: 'json' | 'sse' | 'console';
        outputFile?: string;
        tenantId?: string;
        resolveDeps?: boolean;
    };
} {
    // Basic args (required)
    const agentFileArg = process.argv[2];
    const inputJsonArg = process.argv[3] || '{}';

    // Check for required agent file path
    if (!agentFileArg) {
        cliLogger.error(`Missing required argument: agent file path`);
        console.error("Usage: yarn run-agent <path-to-agent-module.ts> [json-input-string] [--stream] [--format=json|sse] [--tenant=tenant-id] [--resolve-deps|--no-resolve-deps]");
        console.error(`Example: yarn run-agent examples/hello-agent/AgentModule.ts '{"name": "World"}' --stream --format=json --tenant=customer-123 --resolve-deps`);
        process.exit(1);
    }

    // Parse input JSON
    let input: Record<string, unknown>;
    try {
        input = JSON.parse(inputJsonArg);
        cliLogger.debug('Parsed input', { input });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        cliLogger.error(`Invalid JSON input`, e, { input: inputJsonArg });
        console.error(`Invalid JSON input provided: ${inputJsonArg}`);
        process.exit(1);
    }

    // Parse options
    const options = {
        isStreaming: false,
        outputType: 'console' as 'json' | 'sse' | 'console',
        outputFile: undefined as string | undefined,
        tenantId: undefined as string | undefined,
        resolveDeps: true  // Default to true for dependency resolution
    };

    // Look for flags in remaining arguments
    for (let i = 4; i < process.argv.length; i++) {
        const arg = process.argv[i];

        if (arg === '--stream') {
            options.isStreaming = true;
        } else if (arg.startsWith('--format=')) {
            const format = arg.split('=')[1];
            if (format === 'json' || format === 'sse' || format === 'console') {
                options.outputType = format as any;
            } else {
                cliLogger.warn(`Unknown format '${format}', using 'console'`);
            }
        } else if (arg.startsWith('--output=')) {
            options.outputFile = arg.split('=')[1];
        } else if (arg.startsWith('--tenant=')) {
            options.tenantId = arg.split('=')[1];
            if (!options.tenantId || options.tenantId.trim() === '') {
                cliLogger.error(`Invalid tenant ID provided`);
                console.error(`Tenant ID cannot be empty`);
                process.exit(1);
            }
        } else if (arg === '--resolve-deps') {
            options.resolveDeps = true;
        } else if (arg === '--no-resolve-deps') {
            options.resolveDeps = false;
        }
    }

    cliLogger.debug(`Running with options`, {
        agentFilePath: agentFileArg,
        streaming: options.isStreaming,
        format: options.outputType,
        outputFile: options.outputFile,
        tenantId: options.tenantId || 'default (from agent/env)',
        resolveDeps: options.resolveDeps
    });

    return {
        agentFilePath: agentFileArg,
        input,
        options
    };
}

/**
 * Main entry point for the runner CLI
 * Supports both streaming and non-streaming modes with various output formats
 */
async function main(): Promise<void> {
    // Subcommand: input --session <id> --token <t> --value <v> [--tenant <tenant>]
    if (process.argv[2] === 'input') {
        const args = process.argv.slice(3);
        let sessionId = '';
        let token = '';
        let value: unknown = '';
        let tenantId = 'default';
        let handlersFile: string | undefined;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a.startsWith('--session=')) sessionId = a.split('=')[1];
            else if (a === '--session' && args[i + 1]) { sessionId = args[++i]; }
            else if (a.startsWith('--token=')) token = a.split('=')[1];
            else if (a === '--token' && args[i + 1]) { token = args[++i]; }
            else if (a.startsWith('--value=')) {
                const raw = a.split('=')[1];
                try { value = JSON.parse(raw); } catch { value = raw; }
            } else if (a === '--value' && args[i + 1]) {
                const raw = args[++i];
                try { value = JSON.parse(raw); } catch { value = raw; }
            } else if (a.startsWith('--tenant=')) tenantId = a.split('=')[1];
            else if (a === '--tenant' && args[i + 1]) { tenantId = args[++i]; }
            else if (a.startsWith('--handlers=')) handlersFile = a.split('=')[1];
            else if (a === '--handlers' && args[i + 1]) { handlersFile = args[++i]; }
        }
        if (!sessionId || !token) {
            console.error('Usage: runner input --session <SESSION_ID> --token <TOKEN> --value <VALUE> [--tenant <TENANT>] [--handlers <path-to-agent-module.js>]');
            process.exit(1);
        }
        // Optionally auto-register durable handlers from an agent module file
        if (handlersFile) {
            try {
                const { pathToFileURL } = await import('node:url');
                const modUrl = pathToFileURL(handlersFile).href;
                const mod: Record<string, unknown> = await import(modUrl);
                for (const [name, fn] of Object.entries(mod)) {
                    if (name === 'default') continue;
                    if (typeof fn === 'function') {
                        registerHandler(name, async (ctx: any, ev: any) => (fn as any)(ctx, ev));
                    }
                }
            } catch (e) {
                console.error('Failed to load handlers from file', handlersFile, e);
            }
        }
        const store = new WorkingMemorySessionStore();
        await store.connect();
        const engine = new TaskEngine({ sessionStore: store });
        try { EngineLocator.setEngine(engine as any); } catch { }
        // If handlersFile provided, also load agent and its dependencies so ctx.sendTaskToAgent can find children
        if (handlersFile) {
            try {
                await PluginManager.loadAgentWithDependencies(handlersFile);
                // Best-effort: load common sibling agents (Extractor/Analyzer) if present
                const dir = path.dirname(handlersFile);
                try {
                    const ex = path.join(dir, 'ExtractorAgent.js');
                    const { pathToFileURL } = await import('node:url');
                    await import(pathToFileURL(ex).href);
                } catch { }
                try {
                    const an = path.join(dir, 'AnalyzerAgent.js');
                    const { pathToFileURL } = await import('node:url');
                    await import(pathToFileURL(an).href);
                } catch { }
            } catch (e) {
                console.error('Failed to load agent dependencies for handlers file', handlersFile, e);
            }
        }
        // Subscribe to this session's events so we can show output and detect completion
        const channel = taskChannel(sessionId);
        let completed = false;
        const onEvent = (ev: A2AEvent) => {
            if ('artifact' in ev) {
                const text = ev.artifact.parts?.filter(p => (p as any).type === 'text')
                    .map(p => (p as any).text)
                    .filter(Boolean)
                    .join('');
                if (text) console.log(text);
            } else if ('status' in ev) {
                const s = ev.status;
                if (s.state === 'working' && s.message?.parts) {
                    const text = s.message.parts.filter(p => (p as any).type === 'text').map(p => (p as any).text).filter(Boolean).join(' ');
                    if (text) console.log(text);
                }
                if (ev.final && (s.state === 'completed' || s.state === 'failed' || s.state === 'canceled')) {
                    completed = true;
                }
            }
        };
        eventBus.subscribe(channel, onEvent);

        try {
            console.log(`Submitting input... sessionId=${sessionId} token=${token}`);
            await engine.resumeInput({ tenantId, taskId: sessionId, token, input: value });
            console.log(`Input provided. sessionId=${sessionId} token=${token}`);
        } catch (e) {
            console.error('Resume failed:', (e as Error).message);
            await store.close?.();
            process.exit(1);
        }

        // Wait briefly for downstream handlers/children to complete, or until terminal status
        const waitUntil = Date.now() + 15000; // 15s max
        while (!completed && Date.now() < waitUntil) {
            await new Promise(r => setTimeout(r, 100));
        }

        // Cleanup
        eventBus.unsubscribe(channel, onEvent as any);
        try { outboxPublisher.stop(); } catch { }
        await store.close?.();
        return;
    }

    const { agentFilePath, input, options } = parseArgs();

    try {
        await runAgentWithStreaming(agentFilePath, input, options);

        // For streaming mode, keep process alive
        if (options.isStreaming) {
            // Don't exit immediately - the event listeners need to stay alive
            cliLogger.info('Streaming started - press Ctrl+C to exit');
        } else {
            // ✅ FIX: Non-streaming mode — force clean exit.
            // Without this, dangling resources (keepAlive intervals, event bus
            // subscriptions, Prisma pools, outbox publisher) keep the event loop
            // alive indefinitely, causing the CLI process to hang.
            process.exit(0);
        }
    } catch (error: unknown) {
        if (error instanceof Error) {
            cliLogger.error(`Error running agent`, error);
            console.error(`Error: ${error.message}`);
        } else {
            cliLogger.error(`Unknown error`, error);
            console.error(`Unknown error occurred`);
        }
        process.exit(1);
    }
}

// Run the main function
main().catch(err => {
    cliLogger.error(`Unhandled error in runner CLI`, err);
    process.exit(1);
}); 
