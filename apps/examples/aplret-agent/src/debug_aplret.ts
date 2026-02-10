
import path from 'path';

// Enable Console logging too
process.env.OPIK_ENABLED = 'false'; // prevent callllm auto-trace
if (process.env.CONSOLE_TELEMETRY !== 'false') {
    process.env.CALLAGENT_OPIK_ENABLED = 'true';
}

import { runAgentWithStreaming, ConsoleProvider, telemetry } from '../../../../packages/core/src/index.js';

// Ensure Opik is enabled for callagent
if (process.env.CALLAGENT_OPIK_ENABLED === 'true' && process.env.OPIK_API_KEY) {
    console.log('CALLAGENT_OPIK_ENABLED: true');
    console.log('OPIK_API_KEY: ' + process.env.OPIK_API_KEY.substring(0, 4) + '****');
} else {
    console.warn('OPIK IS NOT ENABLED or API KEY MISSING');
    process.env.CALLAGENT_OPIK_ENABLED = 'true'; // Force enable for this debug script if key exists
}

// Add console provider for visibility
telemetry.addProvider(new ConsoleProvider());

async function main() {
    console.log('--- [DEBUG] STARTING APLRET-AGENT WITH OPIK ---');

    try {
        const agentPath = path.join(process.cwd(), 'apps/examples/aplret-agent/src/agent.ts');
        await runAgentWithStreaming(
            agentPath,
            {
                input: 'Count from 1 to 3, one number per turn.',
                // pass session ID if runner supports extracting it from input, otherwise it will auto-generate
                sessionId: `aplret-task-${Date.now()}`
            },
            {
                isStreaming: false,
                tenantId: 'default'
            }
        );

        console.log('--- [DEBUG] AGENT FINISHED ---');

        // Give time for telemetry to flush
        console.log('Waiting for telemetry flush...');
        await new Promise(resolve => setTimeout(resolve, 5000));

    } catch (error) {
        console.error('Check failed:', error);
        process.exit(1);
    }
}

main();
