#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { buildAgentIndex, DEFAULT_AGENT_INDEX_PATH } from '../plugin/AgentIndexBuilder.js';
import { loadAgentIndex } from '../plugin/AgentIndexLoader.js';
import { logger } from '@a2arium/callagent-utils';

const cliLogger = logger.createLogger({ prefix: 'AgentsCLI' });

type AgentCommand = 'index' | 'load' | 'help';

interface ParsedArgs {
    command: AgentCommand;
    options: Record<string, string | boolean>;
}

function parseArgs(): ParsedArgs {
    const [, , ...rest] = process.argv;
    const command = (rest.shift() as AgentCommand | undefined) ?? 'help';
    const options: Record<string, string | boolean> = {};

    for (const arg of rest) {
        if (!arg.startsWith('--')) continue;
        const [key, rawValue] = arg.slice(2).split('=');
        options[key] = rawValue ?? true;
    }

    if (!['index', 'load', 'help'].includes(command)) {
        return { command: 'help', options };
    }

    return { command, options };
}

function printHelp(): void {
    console.log(`
Agent Utilities CLI

Usage:
  node packages/core/dist/runner/agentsCli.js <command> [options]

Commands:
  index            Scan project and write agent index (default: ${DEFAULT_AGENT_INDEX_PATH})
  load             Load an index file immediately (useful for scripts/tests)
  help             Show this message

Options:
  --out=<path>     Output path for index (index command)
  --cwd=<path>     Working directory (defaults to process.cwd())
  --allowSourceFallback  Include .ts/.mts/.cts in index when .js is missing (index only; runtime still needs .js or TS loader)
  --index=<path>   Index path for load command (defaults to ${DEFAULT_AGENT_INDEX_PATH})

Examples:
  node packages/core/dist/runner/agentsCli.js index
  node packages/core/dist/runner/agentsCli.js index --out=.callagent/agent-paths.json
  node packages/core/dist/runner/agentsCli.js load --index=.callagent/agent-paths.json
`);
}

async function run(): Promise<void> {
    const { command, options } = parseArgs();

    switch (command) {
        case 'help':
            printHelp();
            return;
        case 'index': {
            const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
            const allowSourceFallback = options.allowSourceFallback === true || options.allowSourceFallback === 'true';
            const outputPath = typeof options.out === 'string' ? options.out : DEFAULT_AGENT_INDEX_PATH;

            cliLogger.info('Building agent index', {
                cwd,
                outputPath,
                allowSourceFallback
            });

            const { index, warnings } = await buildAgentIndex({ cwd, outputPath, allowSourceFallback });
            const agentCount = Object.keys(index).length;

            cliLogger.info('Agent index build complete', {
                agents: agentCount,
                warnings: warnings.length
            });

            if (warnings.length) {
                console.log('\nWarnings:');
                for (const warning of warnings) {
                    console.log(` - ${warning}`);
                }
            }
            return;
        }
        case 'load': {
            const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
            const indexPath = typeof options.index === 'string' ? options.index : DEFAULT_AGENT_INDEX_PATH;

            cliLogger.info('Loading agent index', {
                indexPath: path.resolve(cwd, indexPath)
            });

            const { loaded, skipped } = await loadAgentIndex({ cwd, indexPath, silent: false });
            cliLogger.info('Agent index load finished', { loaded: loaded.length, skipped: skipped.length });
            return;
        }
        default:
            printHelp();
            return;
    }
}

run().catch(error => {
    cliLogger.error('Agent CLI failed', error as Error);
    process.exit(1);
});

