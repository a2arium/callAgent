import 'dotenv/config';
import { runAgentWithStreaming } from './streamingRunner.js';
import { logger } from '@callagent/utils';

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
    };
} {
    // Basic args (required)
    const agentFileArg = process.argv[2];
    const inputJsonArg = process.argv[3] || '{}';

    // Check for required agent file path
    if (!agentFileArg) {
        cliLogger.error(`Missing required argument: agent file path`);
        console.error("Usage: yarn run-agent <path-to-agent-module.ts> [json-input-string] [--stream] [--format=json|sse]");
        console.error(`Example: yarn run-agent examples/hello-agent/AgentModule.ts '{"name": "World"}' --stream --format=json`);
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
        outputFile: undefined as string | undefined
    };

    // Look for flags in remaining arguments
    for (let i = 4; i < process.argv.length; i++) {
        const arg = process.argv[i];

        if (arg === '--stream') {
            options.isStreaming = true;
        } else if (arg.startsWith('--format=')) {
            const format = arg.split('=')[1];
            if (format === 'json' || format === 'sse') {
                options.outputType = format;
            } else {
                cliLogger.warn(`Unknown format '${format}', using 'console'`);
            }
        } else if (arg.startsWith('--output=')) {
            options.outputFile = arg.split('=')[1];
        }
    }

    cliLogger.info(`Running with options`, {
        agentFilePath: agentFileArg,
        streaming: options.isStreaming,
        format: options.outputType,
        outputFile: options.outputFile
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
    const { agentFilePath, input, options } = parseArgs();

    try {
        await runAgentWithStreaming(agentFilePath, input, options);

        // For streaming mode, keep process alive
        if (options.isStreaming) {
            // Don't exit immediately - the event listeners need to stay alive
            cliLogger.info('Streaming started - press Ctrl+C to exit');
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