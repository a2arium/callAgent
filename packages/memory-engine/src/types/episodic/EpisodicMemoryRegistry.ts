import { EpisodicMemoryBackend, MemoryRegistry } from '@a2arium/callagent-types';

/**
 * Registry/facade for episodic memory backends.
 * Routes calls to the default or named backend as specified.
 */
export class EpisodicMemoryRegistry implements MemoryRegistry<EpisodicMemoryBackend> {
    /** Map of backend names to backend implementations */
    public backends: Record<string, EpisodicMemoryBackend>;
    /** Name of the default backend */
    private defaultBackend: string;

    /**
     * Create a new EpisodicMemoryRegistry
     * @param backends Map of backend names to implementations
     * @param defaultBackend Name of the default backend
     */
    constructor(backends: Record<string, EpisodicMemoryBackend>, defaultBackend: string) {
        this.backends = backends;
        this.defaultBackend = defaultBackend;
    }

    /**
     * Get the name of the default backend
     */
    getDefaultBackend(): string {
        return this.defaultBackend;
    }

    /**
     * Set the default backend by name
     * @param name Name of the backend to set as default
     * @throws If the backend does not exist
     */
    setDefaultBackend(name: string): void {
        if (!this.backends[name]) throw new Error(`No such backend: ${name}`);
        this.defaultBackend = name;
    }

    /**
     * Append an event to the episodic memory in the selected backend
     * @param event The event to append
     * @param opts Optional backend override and tags
     */
    async append<T>(event: T, opts?: { backend?: string, tags?: string[] }): Promise<void> {
        const backend = this.backends[opts?.backend ?? this.defaultBackend];
        return backend.append<T>(event, opts);
    }

    /**
     * Retrieve events from the episodic memory in the selected backend
     * @param filter Query options, may include backend override
     */
    async getEvents<T>(filter?: any): Promise<Array<{ key: string; value: T }>> {
        const backendName = filter?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName];
        return backend.getEvents<T>(filter);
    }

    /**
     * Delete an event by id in the selected backend
     * @param id The unique identifier of the event to delete
     * @param opts Optional backend override
     */
    async deleteEvent(id: string, opts?: { backend?: string }): Promise<void> {
        const backend = this.backends[opts?.backend ?? this.defaultBackend];
        return backend.deleteEvent(id, opts);
    }
} 