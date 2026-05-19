import { describe, expect, it } from '@jest/globals';
import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';
import { busEventData } from '../src/eventbus/busEventHelpers.js';
import { taskChannel } from '../src/eventbus/taskEventEmitter.js';
import { bindRuntimeCognitionStream } from '../src/streaming/cognitionRuntimePublisher.js';
import type { RuntimeStreamEvent } from '../src/streaming/runtimeStreamEvents.js';
import type { TaskContext } from '../src/shared/types/index.js';

describe('bindRuntimeCognitionStream', () => {
    it('publishes goal, thought, and decision runtime events after successful mutations', async () => {
        const eventBus = createInMemoryEventBus();
        const events: RuntimeStreamEvent[] = [];
        const { unsubscribe } = await eventBus.subscribe(taskChannel('task-cognition'), async (event) => {
            const data = busEventData<RuntimeStreamEvent>(event);
            if (data) events.push(data);
        });

        const goals = new Map<string, { id: string; title: string; status: 'active' | 'done' | 'failed' }>();
        const ctx = {
            goals: {
                add: async (g: { title: string }) => {
                    goals.set('goal-1', { id: 'goal-1', title: g.title, status: 'active' });
                    return 'goal-1';
                },
                update: async (id: string, patch: { title?: string; status?: 'active' | 'done' | 'failed' }) => {
                    const current = goals.get(id);
                    if (current) goals.set(id, { ...current, ...patch });
                },
                remove: async (id: string) => {
                    goals.delete(id);
                },
                clear: async () => {
                    goals.clear();
                },
                read: async () => Array.from(goals.values()),
            },
            thoughts: {
                add: async () => {},
            },
            decisions: {
                add: async () => {},
                get: async () => null,
                read: async () => [],
            },
        } as unknown as TaskContext;

        bindRuntimeCognitionStream({
            ctx,
            eventBus,
            tenantId: 'tenant-test',
            sessionId: 'task-cognition',
            agentId: 'agent-test',
        });

        const goalId = await ctx.goals!.add({ title: 'Find answer' });
        await ctx.goals!.update(goalId, { status: 'done' });
        await ctx.thoughts!.add({ text: 'Need current evidence.' });
        await ctx.decisions!.add('route', { tool: 'search' }, 'Search first');

        await unsubscribe();

        expect(events.map((event) => event.type)).toEqual([
            'goal.changed',
            'goal.changed',
            'thought.added',
            'decision.added',
        ]);
        expect(events[0]).toEqual(expect.objectContaining({
            taskId: 'task-cognition',
            tenantId: 'tenant-test',
            agentId: 'agent-test',
            visibility: 'debug',
            data: { op: 'added', goalId: 'goal-1', titlePreview: 'Find answer' },
        }));
        expect(events[1]).toEqual(expect.objectContaining({
            type: 'goal.changed',
            visibility: 'debug',
            data: { op: 'completed', goalId: 'goal-1' },
        }));
        expect(events[2]).toEqual(expect.objectContaining({
            type: 'thought.added',
            visibility: 'private',
            channel: 'telemetry',
            data: { preview: 'Need current evidence.' },
        }));
        expect(events[3]).toEqual(expect.objectContaining({
            type: 'decision.added',
            visibility: 'debug',
            data: {
                key: 'route',
                valuePreview: { tool: 'search' },
                reasoningPreview: 'Search first',
            },
        }));
    });
});
