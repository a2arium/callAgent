import 'dotenv/config';
import { runAgentWithStreaming, telemetry, ConsoleProvider } from '@a2arium/callagent-core';
import path from 'path';

// Enable Console logging
if (process.env.CONSOLE_TELEMETRY !== 'false') {
    telemetry.addProvider(new ConsoleProvider());
}

async function main() {
    console.log('--- [DEBUG] STARTING TOOL-AGENT ---');

    // We must point to the .ts file for ts-node/esm
    const agentPath = path.resolve('AgentModule.ts');

    try {
        await runAgentWithStreaming(
            agentPath,
            { prompt: "What's the weather in London and the time in Tokyo?" },
            {
                isStreaming: false,
                outputType: 'console',
                resolveDeps: true
            }
        );
        console.log('--- [DEBUG] AGENT FINISHED ---');

        // Give telemetry some time to flush
        console.log('Waiting for telemetry flush...');
        await new Promise(r => setTimeout(r, 5000));
        console.log('Done.');

    } catch (err) {
        console.error('Error running agent:', err);
    }
}

main().catch(console.error);
