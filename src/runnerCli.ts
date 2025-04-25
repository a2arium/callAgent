import { runAgentWithStreaming } from './runner/streamingRunner.js';
import { logger } from './utils/logger.js';

// Log uncaught exceptions and unhandled rejections early
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
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

    // Determine log method based on output format
    const logInfoMethod = (options.outputType === 'json' || options.outputType === 'sse') ? cliLogger.warn : cliLogger.info;

    // Log startup options using the determined method
    logInfoMethod.call(cliLogger, `Running with options`, {
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
 * Main function to run the agent with streaming and handle options.
 */
async function main(): Promise<void> {
    const { agentFilePath, input, options } = parseArgs();

    // Determine log method based on output format
    const logInfoMethod = (options.outputType === 'json' || options.outputType === 'sse') ? cliLogger.warn : cliLogger.info;

    // Log startup options using the determined method
    logInfoMethod.call(cliLogger, `Running with options`, {
        agentFilePath: agentFilePath,
        streaming: options.isStreaming,
        format: options.outputType,
        outputFile: options.outputFile
    });

    try {
        await runAgentWithStreaming(agentFilePath, input, options);

        // For streaming mode, keep process alive
        if (options.isStreaming) {
            // Don't exit immediately - the event listeners need to stay alive
            // Log stream start using the determined method
            logInfoMethod.call(cliLogger, 'Streaming started - press Ctrl+C to exit');
        }
    } catch (error: unknown) {
        // Handle error
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});