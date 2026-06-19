import { expect } from '@jest/globals';
import type { IEventBus } from '../../src/eventbus/inMemoryEventBus.js';
import type { BusEvent } from '../../src/public-types/eventbus/schemas.js';
import { taskChannel } from '../../src/eventbus/taskEventEmitter.js';

export type NormalizedRuntimeEvent = {
    type: string;
    final?: boolean;
    state?: string;
    taskId?: string;
    hasMessage: boolean;
};

type EventData = {
    final?: boolean;
    taskId?: string;
    id?: string;
    status?: {
        state?: string;
        message?: unknown;
    };
};

export async function captureTaskEvents(
    eventBus: IEventBus,
    taskId: string,
    run: () => Promise<void>
): Promise<NormalizedRuntimeEvent[]> {
    const events: NormalizedRuntimeEvent[] = [];
    const subscription = await eventBus.subscribe(taskChannel(taskId), (event) => {
        events.push(normalizeRuntimeEvent(event));
    });
    try {
        await run();
    } finally {
        await subscription.unsubscribe();
    }
    return events;
}

export function normalizeRuntimeEvent(event: BusEvent): NormalizedRuntimeEvent {
    const data = event.payload.data as EventData | undefined;
    return {
        type: event.payload.type,
        final: data?.final,
        state: data?.status?.state,
        taskId: data?.taskId ?? data?.id,
        hasMessage: data?.status?.message !== undefined,
    };
}

export function expectParityTrace(
    actual: NormalizedRuntimeEvent[],
    expected: NormalizedRuntimeEvent[]
): void {
    expect(actual).toEqual(expected);
}
