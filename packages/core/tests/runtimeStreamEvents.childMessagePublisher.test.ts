import { describe, expect, it, afterEach } from '@jest/globals';
import { A2AService } from '../src/orchestration/A2AService.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';
import { busEventData } from '../src/eventbus/busEventHelpers.js';
import { taskChannel } from '../src/eventbus/taskEventEmitter.js';
import type { RuntimeStreamEvent } from '../src/streaming/runtimeStreamEvents.js';

describe('A2A child message runtime publishing', () => {
    afterEach(() => {
        EngineLocator.setEngine(null);
    });

    it('publishes canonical child.message debug events without removing public artifact mirroring', async () => {
        const eventBus = createInMemoryEventBus();
        const events: unknown[] = [];
        const { unsubscribe } = await eventBus.subscribe(taskChannel('parent-task'), async (event) => {
            const data = busEventData<unknown>(event);
            if (data) events.push(data);
        });
        EngineLocator.setEngine({ eventBus });

        const service = new A2AService();
        const reply = (service as any).createTargetReply({
            resolved: {
                agentCard: {
                    name: 'child-agent',
                },
            },
        }, {
            tenantId: 'tenant-test',
            parentTaskId: 'parent-task',
            parentChildToken: 'child-token-1',
        });

        await reply('hello parent');
        await new Promise((resolve) => setTimeout(resolve, 0));
        await unsubscribe();

        expect(events).toEqual([
            expect.objectContaining({
                type: 'child.message',
                visibility: 'debug',
                channel: 'debug',
                taskId: 'parent-task',
                tenantId: 'tenant-test',
                data: {
                    token: 'child-token-1',
                    agentId: 'child-agent',
                    parts: [{ type: 'text', text: '[child-agent] hello parent' }],
                },
            } satisfies Partial<RuntimeStreamEvent>),
            expect.objectContaining({
                artifact: expect.objectContaining({
                    parts: [{ type: 'text', text: '[child-agent] hello parent' }],
                }),
            }),
        ]);
    });
});
