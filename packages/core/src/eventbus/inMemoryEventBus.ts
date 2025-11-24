/**
 * Interface for the event bus
 */
export interface IEventBus {
    publish<T>(channel: string, event: T): Promise<void>;
    subscribe<T>(channel: string, handler: (event: T) => Promise<void> | void): void;
    unsubscribe(channel: string, handler: Function): void;
}

import { logger } from '@a2arium/callagent-utils';

/**
 * In-memory implementation of the event bus
 */

const log = logger.createLogger({ prefix: 'EventBus' });

export class InMemoryEventBus implements IEventBus {
    private handlers = new Map<string, Set<Function>>();

    /**
     * Publish an event to a channel
     */
    async publish<T>(channel: string, event: T): Promise<void> {
        try {
            log.debug('Event published', {
                channel,
                eventKind: (event as any)?.status?.state ?? (event as any)?.kind ?? (event as any)?.type ?? typeof event,
                eventSummary: (() => {
                    try { return JSON.stringify(event); } catch { return '[unserializable]'; }
                })(),
                subscriberCount: this.handlers.get(channel)?.size ?? 0,
                caller: new Error().stack?.split('\n')[2]?.trim()
            });
        } catch { /* noop */ }
        const subs = this.handlers.get(channel);
        if (!subs) return;

        for (const handler of subs) {
            // call synchronously to preserve order
            handler(event);
        }
    }

    /**
     * Subscribe to events on a channel
     */
    subscribe<T>(channel: string, handler: (e: T) => void): void {
        try {
            log.debug('Event subscription added', {
                channel,
                handlerId: handler.name || '(anonymous)',
                caller: new Error().stack?.split('\n')[2]?.trim()
            });
        } catch { /* noop */ }
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
        }
        this.handlers.get(channel)!.add(handler);
    }

    /**
     * Unsubscribe from events on a channel
     */
    unsubscribe(channel: string, handler: Function): void {
        try {
            log.debug('Event subscription removed', {
                channel,
                handlerId: handler.name || '(anonymous)'
            });
        } catch { /* noop */ }
        this.handlers.get(channel)?.delete(handler);
    }

    /**
     * Get total count of active listeners across all channels
     * Useful for debugging and cleanup (Hypothesis 4)
     */
    listenerCount(): number {
        let total = 0;
        for (const handlers of this.handlers.values()) {
            total += handlers.size;
        }
        return total;
    }

    /**
     * Remove all listeners from all channels
     * Useful for test cleanup to prevent event loop from staying alive
     */
    removeAllListeners(): void {
        const count = this.listenerCount();
        if (count > 0) {
            log.debug(`Removing ${count} listeners from ${this.handlers.size} channels`);
        }
        this.handlers.clear();
    }
}

// Singleton instance
export const eventBus = new InMemoryEventBus(); 