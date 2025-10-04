import { EpisodicMemoryBackend, MemoryRegistry } from '@a2arium/callagent-types';
/**
 * Registry/facade for episodic memory backends.
 * Routes calls to the default or named backend as specified.
 */
export declare class EpisodicMemoryRegistry implements MemoryRegistry<EpisodicMemoryBackend> {
    /** Map of backend names to backend implementations */
    backends: Record<string, EpisodicMemoryBackend>;
    /** Name of the default backend */
    private defaultBackend;
    /**
     * Create a new EpisodicMemoryRegistry
     * @param backends Map of backend names to implementations
     * @param defaultBackend Name of the default backend
     */
    constructor(backends: Record<string, EpisodicMemoryBackend>, defaultBackend: string);
    /**
     * Get the name of the default backend
     */
    getDefaultBackend(): string;
    /**
     * Set the default backend by name
     * @param name Name of the backend to set as default
     * @throws If the backend does not exist
     */
    setDefaultBackend(name: string): void;
    /**
     * Append an event to the episodic memory in the selected backend
     * @param event The event to append
     * @param opts Optional backend override and tags
     */
    append<T>(event: T, opts?: {
        backend?: string;
        tags?: string[];
    }): Promise<void>;
    /**
     * Retrieve events from the episodic memory in the selected backend
     * @param filter Query options, may include backend override
     */
    getEvents<T>(filter?: any): Promise<Array<{
        key: string;
        value: T;
    }>>;
    /**
     * Delete an event by id in the selected backend
     * @param id The unique identifier of the event to delete
     * @param opts Optional backend override
     */
    deleteEvent(id: string, opts?: {
        backend?: string;
    }): Promise<void>;
}
