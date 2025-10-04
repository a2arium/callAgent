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
export declare class InMemoryEventBus implements IEventBus {
    private handlers;
    /**
     * Publish an event to a channel
     */
    publish<T>(channel: string, event: T): Promise<void>;
    /**
     * Subscribe to events on a channel
     */
    subscribe<T>(channel: string, handler: (e: T) => void): void;
    /**
     * Unsubscribe from events on a channel
     */
    unsubscribe(channel: string, handler: Function): void;
}
export declare const eventBus: InMemoryEventBus;
