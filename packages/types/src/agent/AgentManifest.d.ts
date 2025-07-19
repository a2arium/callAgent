/**
 * Enhanced Agent Manifest Format for A2A Dependencies
 *
 * Defines the structure of agent metadata and configuration including
 * dependencies on other agents for A2A communication.
 */
/**
 * Agent manifest defines the metadata and capabilities of an agent
 * Used for A2A communication to identify and configure target agents
 */
export interface AgentManifest {
    /** Agent name identifier */
    name: string;
    /** Agent version */
    version: string;
    /** Optional agent description */
    description?: string;
    /** Agent dependencies for A2A communication */
    dependencies?: {
        /** Array of agent names that this agent depends on (no versions for now) */
        agents?: string[];
    };
    /** Memory configuration for A2A context inheritance */
    memory?: {
        /** Memory profile (e.g., 'basic', 'advanced', 'custom') */
        profile?: string;
        /** Additional memory configuration */
        [key: string]: unknown;
    };
    /** A2A specific configuration (future expansion) */
    a2a?: {
        /** Maximum concurrent A2A calls */
        maxConcurrentCalls?: number;
        /** Default timeout for A2A calls */
        defaultTimeout?: number;
        /** List of allowed target agents (* for all) */
        allowedTargets?: string[];
        /** Default memory inheritance options */
        memoryInheritance?: {
            working?: boolean;
            semantic?: boolean;
            episodic?: boolean;
        };
    };
    /** Agent result caching configuration */
    cache?: {
        /** Enable/disable caching for this agent (default: false) */
        enabled?: boolean;
        /** Cache TTL in seconds (default: 300 = 5 minutes) */
        ttlSeconds?: number;
        /** Paths to exclude from cache key (dot notation for nested objects) */
        excludePaths?: string[];
    };
    [key: string]: unknown;
}
/**
 * Type guard to check if an object is a valid AgentManifest
 */
export declare function isAgentManifest(obj: unknown): obj is AgentManifest;
