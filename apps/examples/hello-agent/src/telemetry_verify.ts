import 'dotenv/config';
import {
    telemetry,
    ConsoleProvider,
    TaskEngine,
    createAgent,
    EngineLocator
} from '@a2arium/callagent-core';

async function main() {
    console.log('--- [VERIFY] SETUP ---');

    // 1. Setup Telemetry
    const provider = new ConsoleProvider();
    telemetry.addProvider(provider);
    console.log('Telemetry setup complete. ConsoleProvider active.');

    // 2. Register a test agent
    const agentId = 'telemetry-verify-agent';
    console.log(`Registering agent: ${agentId}`);
    createAgent({
        manifest: {
            name: agentId,
            version: '1.0.0',
            description: 'Verify Telemetry',
        },
        handleTask: async (ctx) => {
            console.log('--- [AGENT] Handler executing ---');
            // Explicitly mark task as complete so the engine knows we are done
            (ctx as any).complete({ message: 'Hello ' + (ctx.task.input as any).name });
            return { result: { message: 'Hello ' + (ctx.task.input as any).name } };
        }
    }, import.meta.url);

    // 3. Initialize Engine (defaults to In-Memory)
    console.log('--- [VERIFY] ENGINE INIT ---');
    const engine = new TaskEngine();
    EngineLocator.setEngine(engine);

    // 4. Run Task
    console.log('--- [VERIFY] START TASK ---');
    try {
        const task = await engine.startTask({
            task: {
                id: 'test-session-' + Date.now(),
                input: { name: 'Antigravity' }
            },
            isStreaming: false,
            agentId: agentId,
            parentTelemetryNodeId: 'root-test-span',
            tenantId: 'default'
        });

        console.log('--- [VERIFY] TASK COMPLETED ---');
        console.log('Final Status:', task?.status?.state);

        // Wait a bit for pending logs
        await new Promise(r => setTimeout(r, 500));

    } catch (e) {
        console.error('--- [VERIFY] ERROR ---', e);
    }
}

main().catch(console.error);
