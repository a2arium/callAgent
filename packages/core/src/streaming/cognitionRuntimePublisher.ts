import { v7 as uuidv7 } from 'uuid';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import type {
    GoalId,
    GoalNode,
    TaskContextGoalAddInput,
    TaskContextGoalUpdatePatch,
} from '../loop/types.js';
import type { TaskContext } from '../shared/types/index.js';
import {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    type RuntimeStreamEvent,
} from './runtimeStreamEvents.js';

type BindRuntimeCognitionStreamParams = {
    ctx: TaskContext;
    eventBus: IEventBus;
    tenantId: string;
    sessionId: string;
    agentId?: string;
};

const WRAPPED = Symbol.for('@a2arium/callagent/runtime-cognition-stream-wrapped');

function previewText(value: unknown): string | undefined {
    if (typeof value === 'string') return value.slice(0, 240);
    if (value && typeof value === 'object' && 'title' in value && typeof (value as { title?: unknown }).title === 'string') {
        return (value as { title: string }).title.slice(0, 240);
    }
    if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') {
        return (value as { text: string }).text.slice(0, 240);
    }
    return undefined;
}

async function publish(params: BindRuntimeCognitionStreamParams, event: RuntimeStreamEvent): Promise<void> {
    await params.eventBus.publish(createBusEvent({
        channel: taskChannel(params.sessionId),
        partitionKey: params.sessionId,
        cloud: {
            id: event.id,
            type: event.type,
            source: `/tasks/${params.sessionId}`,
            time: event.ts,
            datacontenttype: 'application/json',
            data: event,
        },
    }));
}

function base(params: BindRuntimeCognitionStreamParams) {
    const ts = new Date().toISOString();
    return {
        version: RUNTIME_STREAM_EVENT_VERSION,
        id: uuidv7(),
        seq: Date.now(),
        taskId: params.sessionId,
        tenantId: params.tenantId,
        agentId: params.agentId,
        ts,
        channel: 'debug' as const,
    };
}

async function publishGoal(params: BindRuntimeCognitionStreamParams, data: {
    op: 'added' | 'updated' | 'completed' | 'failed' | 'removed';
    goalId: string;
    titlePreview?: string;
}): Promise<void> {
    const event = RuntimeStreamEventSchema.parse({
        ...base(params),
        type: 'goal.changed',
        visibility: 'debug',
        data,
    });
    await publish(params, event);
}

async function publishThought(params: BindRuntimeCognitionStreamParams, text: unknown): Promise<void> {
    const event = RuntimeStreamEventSchema.parse({
        ...base(params),
        type: 'thought.added',
        visibility: 'private',
        channel: 'telemetry',
        data: {
            preview: previewText(text),
        },
    });
    await publish(params, event);
}

async function publishDecision(params: BindRuntimeCognitionStreamParams, key: string, value: unknown, reasoning?: string): Promise<void> {
    const event = RuntimeStreamEventSchema.parse({
        ...base(params),
        type: 'decision.added',
        visibility: 'debug',
        data: {
            key,
            valuePreview: value,
            ...(reasoning ? { reasoningPreview: reasoning.slice(0, 240) } : {}),
        },
    });
    await publish(params, event);
}

function statusToGoalOp(status: unknown): 'completed' | 'failed' | 'updated' {
    if (status === 'done') return 'completed';
    if (status === 'failed' || status === 'dropped') return 'failed';
    return 'updated';
}

async function readGoalsByPredicate(
    ctx: TaskContext,
    predicate?: (g: GoalNode) => boolean
): Promise<GoalNode[]> {
    try {
        const all = await Promise.resolve(ctx.goals?.read?.({}));
        const goals = Array.isArray(all) ? all : [];
        return predicate ? goals.filter(predicate) : goals;
    } catch {
        return [];
    }
}

export function bindRuntimeCognitionStream(params: BindRuntimeCognitionStreamParams): void {
    const goals = params.ctx.goals;
    if (goals) {
        const originalAdd = goals.add?.bind(goals);
        if (originalAdd && !(goals.add as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
            const wrapped = async (g: TaskContextGoalAddInput) => {
                const id = await Promise.resolve(originalAdd(g));
                await publishGoal(params, { op: 'added', goalId: id, titlePreview: previewText(g) });
                return id;
            };
            (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
            goals.add = wrapped;
        }

        const originalUpdate = goals.update?.bind(goals);
        if (originalUpdate && !(goals.update as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
            const wrapped = async (id: GoalId, patch: TaskContextGoalUpdatePatch) => {
                await Promise.resolve(originalUpdate(id, patch));
                await publishGoal(params, {
                    op: statusToGoalOp((patch as { status?: unknown }).status),
                    goalId: id,
                    titlePreview: previewText(patch),
                });
            };
            (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
            goals.update = wrapped;
        }

        const originalRemove = goals.remove?.bind(goals);
        if (originalRemove && !(goals.remove as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
            const wrapped = async (id: GoalId) => {
                await Promise.resolve(originalRemove(id));
                await publishGoal(params, { op: 'removed', goalId: id });
            };
            (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
            goals.remove = wrapped;
        }

        const originalClear = goals.clear?.bind(goals);
        if (originalClear && !(goals.clear as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
            const wrapped = async (predicate?: (g: GoalNode) => boolean) => {
                const removed = await readGoalsByPredicate(params.ctx, predicate);
                await Promise.resolve(originalClear(predicate));
                for (const goal of removed) {
                    await publishGoal(params, { op: 'removed', goalId: goal.id, titlePreview: previewText(goal.title) });
                }
            };
            (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
            goals.clear = wrapped;
        }
    }

    const addThought = params.ctx.thoughts?.add?.bind(params.ctx.thoughts);
    if (params.ctx.thoughts && addThought && !(params.ctx.thoughts.add as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
        const wrapped = async (thought: { text: string } | string) => {
            await Promise.resolve(addThought(thought));
            await publishThought(params, thought);
        };
        (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
        params.ctx.thoughts.add = wrapped;
    }

    const decisions = params.ctx.decisions;
    const addDecision = decisions?.add?.bind(decisions);
    if (decisions && addDecision && !(decisions.add as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
        const wrapped = async (key: string, value: unknown, reasoning?: string) => {
            await addDecision(key, value, reasoning);
            await publishDecision(params, key, value, reasoning);
        };
        (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
        decisions.add = wrapped;
    }

    const legacy = params.ctx as TaskContext & {
        addGoal?: (node: TaskContextGoalAddInput) => Promise<GoalId>;
        updateGoal?: (id: GoalId, patch: TaskContextGoalUpdatePatch) => Promise<void>;
        completeGoal?: (id: GoalId, opts?: { cascadeChildren?: boolean; requireNoActiveChildren?: boolean }) => Promise<void>;
        failGoal?: (id: GoalId) => Promise<void>;
    };

    if (legacy.addGoal && !(legacy.addGoal as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
        const original = legacy.addGoal.bind(legacy);
        const wrapped = async (node: TaskContextGoalAddInput) => {
            const id = await original(node);
            await publishGoal(params, { op: 'added', goalId: id, titlePreview: previewText(node) });
            return id;
        };
        (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
        legacy.addGoal = wrapped;
    }
    if (legacy.updateGoal && !(legacy.updateGoal as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
        const original = legacy.updateGoal.bind(legacy);
        const wrapped = async (id: GoalId, patch: TaskContextGoalUpdatePatch) => {
            await original(id, patch);
            await publishGoal(params, { op: statusToGoalOp((patch as { status?: unknown }).status), goalId: id, titlePreview: previewText(patch) });
        };
        (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
        legacy.updateGoal = wrapped;
    }
    if (legacy.completeGoal && !(legacy.completeGoal as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
        const original = legacy.completeGoal.bind(legacy);
        const wrapped = async (id: GoalId, opts?: { cascadeChildren?: boolean; requireNoActiveChildren?: boolean }) => {
            await original(id, opts);
            await publishGoal(params, { op: 'completed', goalId: id });
        };
        (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
        legacy.completeGoal = wrapped;
    }
    if (legacy.failGoal && !(legacy.failGoal as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
        const original = legacy.failGoal.bind(legacy);
        const wrapped = async (id: GoalId) => {
            await original(id);
            await publishGoal(params, { op: 'failed', goalId: id });
        };
        (wrapped as unknown as Record<PropertyKey, unknown>)[WRAPPED] = true;
        legacy.failGoal = wrapped;
    }
}
