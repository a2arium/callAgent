/**
 * Interface for the event bus
 */
export interface IEventBus {
    publish<T>(channel: string, event: T): Promise<void>;
    subscribe<T>(channel: string, handler: (event: T) => Promise<void> | void): void;
    unsubscribe(channel: string, handler: Function): void;
}

/**
 * In-memory implementation of the event bus
 */
export class InMemoryEventBus implements IEventBus {
    private handlers = new Map<string, Set<Function>>();

    /**
     * Publish an event to a channel
     */
    async publish<T>(channel: string, event: T): Promise<void> {
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
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
        }
        this.handlers.get(channel)!.add(handler);
    }

    /**
     * Unsubscribe from events on a channel
     */
    unsubscribe(channel: string, handler: Function): void {
        this.handlers.get(channel)?.delete(handler);
    }
}

// Singleton instance
export const eventBus = new InMemoryEventBus(); 