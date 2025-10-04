interface RegisteredAgent {
    path: string;
    manifest?: any;
    loadedAt: Date;
}
/**
 * Smart Agent Discovery Service
 * Replaces hardcoded paths with intelligent pattern-based discovery
 *
 * Discovery priority:
 * 1. Registry lookup (fastest - O(1))
 * 2. Context-aware discovery (same/sibling directories)
 * 3. Workspace-aware discovery (uses package.json workspaces)
 * 4. Smart filesystem discovery (pattern-based scanning)
 */
export declare class SmartAgentDiscoveryService {
    private static cache;
    private static registry;
    private static readonly CACHE_TTL;
    private static readonly MAX_SCAN_DEPTH;
    /**
     * Parse agent name to support category-based organization
     */
    private static parseAgentName;
    /**
     * Main discovery entry point - tries all discovery mechanisms in priority order
     */
    static findAgent(name: string, contextPath?: string): Promise<string | null>;
    /**
     * Register an agent for fast lookup
     */
    static registerAgent(name: string, info: RegisteredAgent): void;
    /**
     * Check if agent is registered
     */
    static hasRegisteredAgent(name: string): boolean;
    /**
     * Registry-based discovery (fastest)
     */
    private static findInRegistry;
    /**
     * Context-aware discovery - same directory and sibling directories
     */
    private static findInContext;
    /**
     * Check if directory name matches agent name (case-insensitive)
     */
    private static nameMatches;
    /**
     * Workspace-aware discovery - uses existing package.json workspaces
     */
    private static findInWorkspaces;
    /**
     * Get workspace paths from package.json
     */
    private static getWorkspacePaths;
    /**
     * Smart filesystem discovery - pattern-based scanning
     */
    private static findViaSmartDiscovery;
    /**
     * Discover directories that contain agent-like files
     */
    private static discoverAgentDirectories;
    /**
     * Recursively scan directory for agent files
     */
    private static scanDirectoryForAgents;
    /**
     * Check if filename indicates an agent file (case-insensitive)
     */
    private static isAgentFile;
    /**
     * Check if directory should be ignored during scanning
     */
    private static shouldIgnoreDirectory;
    /**
     * Search for agent in a specific path (workspace pattern)
     */
    private static searchInPath;
    /**
     * Search for agent files in a specific directory
     */
    private static searchInDirectory;
    /**
     * Check if a manifest exists for the given agent path and name
     */
    private static checkManifestExists;
    /**
     * Search for agent in a discovered directory
     */
    private static searchForAgentInDirectory;
    /**
     * Generate possible filenames for an agent (case-insensitive)
     */
    private static generateAgentFilenames;
    /**
     * Convert string to PascalCase
     */
    private static toPascalCase;
    /**
     * Convert string to camelCase
     */
    private static toCamelCase;
    /**
     * Find manifest file for an agent
     */
    static findManifest(name: string, contextPath?: string): Promise<string | null>;
    /**
     * Search for the correct manifest file when the obvious location doesn't work
     */
    private static searchForCorrectManifest;
    /**
     * List all discoverable agents
     */
    static listAvailableAgents(): Promise<Array<{
        name: string;
        agentPath: string;
        manifestPath: string | null;
    }>>;
    /**
     * Extract agent name from file path
     */
    private static extractAgentNameFromPath;
    /**
     * Clear discovery cache (useful for testing)
     */
    static clearCache(): void;
    /**
     * Validate that an agent directory has the required structure
     * @param agentName - Name of the agent to validate
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Validation result with errors
     */
    static validateAgentStructure(agentName: string, contextPath?: string): Promise<{
        isValid: boolean;
        errors: string[];
    }>;
}
export {};
