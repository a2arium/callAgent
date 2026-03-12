import 'dotenv/config';
import { TaskEngine, EngineLocator, ConsoleProvider, telemetry, eventBus } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import './agent.js'; // Importing registers the agent

async function main() {
    logger.info('Starting Hello Agent example using TaskEngine...');

    telemetry.addProvider(new ConsoleProvider());

    const engine = new TaskEngine();
    EngineLocator.setEngine(engine);

    try {
        const task = await engine.startTask({
            task: {
                id: 'hello-session-' + Date.now(),
                input: { name: 'Antigravity' }
            },
            isStreaming: false,
            agentId: 'hello-agent', // Explicitly start this agent
            tenantId: 'default'
        });

        if (!task) {
            throw new Error('TaskEngine failed to return a valid task entity.');
        }

        logger.info('Agent run started...', { taskId: task.id });

        // Wait for completion via event bus
        const finalStatus = await new Promise((resolve, reject) => {
            const handler = (event: any) => {
                if (event.id === task.id) {
                    const state = event.status.state;
                    if (state === 'completed' || state === 'canceled' || state === 'failed') {
                        eventBus.unsubscribe('task.status.updated', handler);
                        if (state === 'failed') reject(event.status.message || 'Task failed');
                        else resolve(event.status);
                    }
                }
            };
            eventBus.subscribe('task.status.updated', handler);
        });

        logger.info('Agent run completed!', { finalStatus });
    } catch (error) {
        logger.error('Agent run failed', { error });
    }
}

main().catch(console.error);
