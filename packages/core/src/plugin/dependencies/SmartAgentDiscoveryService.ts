import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '@a2arium/callagent-utils';
import { 
    AgentCard, 
    AgentRuntimeManifest, 
    DiscoveredManifestPaths 
} from '@a2arium/callagent-types';

const discoveryLogger = logger.createLogger({ prefix: 'SmartAgentDiscovery' });

/**
 * Parsed agent name structure for category-based organization
 */
type ParsedAgentName = {
    category?: string;
    name: string;
    fullName: string;
};

/**
 * Cache for discovery results and filesystem scans
 */
interface DiscoveryCache {
    agentLocations: Map<string, string>;
    discoveredDirectories: string[];
    lastScan: number;
    workspacePaths: string[] | null;
}

/**
 * Registry for loaded agents (for fast lookup)
 */
interface AgentRegistry {
    agents: Map<string, RegisteredAgent>;
}

interface RegisteredAgent {
    path: string;
    card?: AgentCard;
    loadedAt: Date;
}

const DISCOVERY_STATE_KEY = Symbol.for('callagent.discoveryState');
const globalDiscoveryState: {
    cache: DiscoveryCache;
    registry: AgentRegistry;
} = (globalThis as any)[DISCOVERY_STATE_KEY] || {
    cache: {
        agentLocations: new Map(),
        discoveredDirectories: [],
        lastScan: 0,
        workspacePaths: null
    },
    registry: {
        agents: new Map()
    }
};

if (!(globalThis as any)[DISCOVERY_STATE_KEY]) {
    (globalThis as any)[DISCOVERY_STATE_KEY] = globalDiscoveryState;
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
export class SmartAgentDiscoveryService {
    private static cache: DiscoveryCache = globalDiscoveryState.cache;

    private static registry: AgentRegistry = globalDiscoveryState.registry;

    private static readonly CACHE_TTL = 300000; // 5 minutes
    private static readonly MAX_SCAN_DEPTH = 8;

    /**
     * Parse agent name to support category-based organization
     */
    private static parseAgentName(agentName: string): ParsedAgentName {
        if (agentName.includes('/')) {
            const parts = agentName.split('/');
            if (parts.length === 2 && parts[0] && parts[1]) {
                return {
                    category: parts[0],
                    name: parts[1],
                    fullName: agentName
                };
            }
            discoveryLogger.warn('Invalid category-based agent name format, treating as simple name', {
                agentName,
                expectedFormat: 'category/agent-name'
            });
        }
        return {
            name: agentName,
            fullName: agentName
        };
    }

    /**
     * Main discovery entry point - tries all discovery mechanisms in priority order
     */
    static async findAgent(name: string, contextPath?: string): Promise<string | null> {
        discoveryLogger.debug('Starting agent discovery', {
            name,
            contextPath,
            cwd: process.cwd(),
            searchingFrom: '.'
        });

        // 1. Registry lookup (fastest - O(1))
        const registryResult = this.findInRegistry(name);
        if (registryResult) {
            discoveryLogger.debug('Found in registry', { name, path: registryResult });
            return registryResult;
        }
        discoveryLogger.debug('Not found in registry', { name, registrySize: this.registry.agents.size });

        // 2. Context-aware discovery (if contextPath provided)
        if (contextPath) {
            discoveryLogger.debug('Attempting context-aware discovery', { name, contextPath });
            const contextResult = await this.findInContext(name, contextPath);
            if (contextResult) {
                discoveryLogger.debug('Found via context', { name, path: contextResult });
                // Cache the result
                this.cache.agentLocations.set(name, contextResult);
                return contextResult;
            }
            discoveryLogger.debug('Not found via context', { name });
        }

        // 3. Workspace-aware discovery
        discoveryLogger.debug('Attempting workspace-aware discovery', { name });
        const workspaceResult = await this.findInWorkspaces(name);
        if (workspaceResult) {
            discoveryLogger.debug('Found via workspace', { name, path: workspaceResult });
            this.cache.agentLocations.set(name, workspaceResult);
            return workspaceResult;
        }
        discoveryLogger.debug('Not found via workspace', { name });

        // 4. Smart filesystem discovery
        discoveryLogger.debug('Attempting smart filesystem discovery', { name });
        const smartResult = await this.findViaSmartDiscovery(name, contextPath);
        if (smartResult) {
            discoveryLogger.debug('Found via smart discovery', { name, path: smartResult });
            this.cache.agentLocations.set(name, smartResult);
            return smartResult;
        }
        discoveryLogger.debug('Not found via smart discovery', { name });

        discoveryLogger.debug('Agent not found after all discovery methods', {
            name,
            triedMethods: ['registry', 'context', 'workspace', 'smart'],
            cwd: process.cwd()
        });
        return null;
    }

    /**
     * Register an agent for fast lookup
     */
    static registerAgent(name: string, info: RegisteredAgent): void {
        this.registry.agents.set(name, info);
        discoveryLogger.debug('Agent registered', { name, path: info.path });
    }

    /**
     * Check if agent is registered
     */
    static hasRegisteredAgent(name: string): boolean {
        return this.registry.agents.has(name);
    }

    /**
     * Registry-based discovery (fastest)
     */
    private static findInRegistry(name: string): string | null {
        const agent = this.registry.agents.get(name);
        return agent?.path || null;
    }

    /**
     * Context-aware discovery - same directory and sibling directories
     */
    private static async findInContext(name: string, contextPath: string): Promise<string | null> {
        const contextDir = path.dirname(contextPath);
        const contextAgentName = this.extractAgentNameFromPath(contextPath);

        discoveryLogger.debug('Context-aware discovery details', {
            name,
            contextPath,
            contextDir,
            contextAgentName
        });

        // 1. Same directory search - allow multiple agents in same folder (e.g., demo apps)
        const sameDir = await this.searchInDirectory(name, contextDir);
        if (sameDir) {
            discoveryLogger.debug('Found in same directory', { name, path: sameDir });
            return sameDir;
        }

        // 2. Sibling directories - search more broadly
        const parentDir = path.dirname(contextDir);
        discoveryLogger.debug('Searching sibling directories', { name, parentDir });

        try {
            const siblings = await fs.readdir(parentDir, { withFileTypes: true });

            for (const sibling of siblings) {
                if (sibling.isDirectory()) {
                    // Case-insensitive name matching
                    if (this.nameMatches(sibling.name, name)) {
                        const siblingPath = path.join(parentDir, sibling.name);
                        discoveryLogger.debug('Checking sibling directory', {
                            name,
                            siblingName: sibling.name,
                            siblingPath
                        });
                        const found = await this.searchInDirectory(name, siblingPath);
                        if (found) {
                            discoveryLogger.debug('Found in sibling directory', { name, path: found });
                            return found;
                        }
                    }
                }
            }
        } catch {
            // Parent directory not accessible
        }

        // 3. Go up one more level for nested structures like src/agents/category/agent
        const grandParentDir = path.dirname(parentDir);
        if (grandParentDir !== parentDir) { // Make sure we're not at root
            discoveryLogger.debug('Searching grand-parent level', { name, grandParentDir });

            try {
                const grandSiblings = await fs.readdir(grandParentDir, { withFileTypes: true });

                for (const sibling of grandSiblings) {
                    if (sibling.isDirectory()) {
                        if (this.nameMatches(sibling.name, name)) {
                            const siblingPath = path.join(grandParentDir, sibling.name);
                            discoveryLogger.debug('Checking grand-sibling directory', {
                                name,
                                siblingName: sibling.name,
                                siblingPath
                            });
                            const found = await this.searchInDirectory(name, siblingPath);
                            if (found) {
                                discoveryLogger.debug('Found in grand-sibling directory', { name, path: found });
                                return found;
                            }
                        }
                    }
                }
            } catch {
                // Grand-parent directory not accessible
            }
        }

        discoveryLogger.debug('Context-aware discovery failed', { name });
        return null;
    }

    /**
     * Check if directory name matches agent name (case-insensitive)
     */
    private static nameMatches(dirName: string, agentName: string): boolean {
        const normalizedDir = dirName.toLowerCase();
        const normalizedAgent = agentName.toLowerCase();

        return normalizedDir === normalizedAgent ||
            normalizedDir.includes(normalizedAgent) ||
            normalizedAgent.includes(normalizedDir) ||
            normalizedDir.replace(/-/g, '') === normalizedAgent.replace(/-/g, '');
    }

    /**
     * Workspace-aware discovery - uses existing package.json workspaces
     */
    private static async findInWorkspaces(name: string): Promise<string | null> {
        const workspacePaths = await this.getWorkspacePaths();

        for (const workspacePath of workspacePaths) {
            const found = await this.searchInPath(name, workspacePath);
            if (found) return found;
        }

        return null;
    }

    /**
     * Get workspace paths from package.json
     */
    private static async getWorkspacePaths(): Promise<string[]> {
        if (this.cache.workspacePaths) {
            return this.cache.workspacePaths;
        }

        try {
            const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
            const workspaces = pkg.workspaces || [];

            // Convert workspace patterns to search paths
            const paths = workspaces.flatMap((workspace: string) => [
                workspace,                    // Source level
                `${workspace}/dist`,         // Compiled level
                `${workspace}/src`           // Common src pattern
            ]);

            this.cache.workspacePaths = paths;
            return paths;
        } catch {
            this.cache.workspacePaths = [];
            return [];
        }
    }

    /**
     * Smart filesystem discovery - pattern-based scanning
     */
    private static async findViaSmartDiscovery(name: string, contextPath?: string): Promise<string | null> {
        discoveryLogger.debug('Starting smart filesystem discovery', { name, contextPath });
        const agentDirectories = await this.discoverAgentDirectories();

        discoveryLogger.debug('Smart discovery found directories', {
            name,
            directoriesCount: agentDirectories.length,
            directories: agentDirectories.slice(0, 5) // Log first 5 for debugging
        });

        // Determine context directory from calling agent path
        let contextDir: string | null = null;
        if (contextPath) {
            // Extract the base directory (src, dist, build, etc.)
            const match = contextPath.match(/\/(src|dist|build|out|lib|compiled)\/agents\//);
            if (match) {
                contextDir = match[1]; // 'src', 'dist', 'build', etc.
                discoveryLogger.debug('Extracted context directory', { contextPath, contextDir });
            }
        }

        // Sort directories by context preference
        const prioritizedDirectories = agentDirectories.sort((a, b) => {
            if (contextDir) {
                const aMatchesContext = a.includes(`/${contextDir}/`);
                const bMatchesContext = b.includes(`/${contextDir}/`);

                if (aMatchesContext && !bMatchesContext) return -1; // Context first
                if (!aMatchesContext && bMatchesContext) return 1;
            }

            // Secondary priority: common build directories
            const buildDirPriority = ['dist', 'build', 'out', 'lib', 'src'];
            const aIndex = buildDirPriority.findIndex(dir => a.includes(`/${dir}/`));
            const bIndex = buildDirPriority.findIndex(dir => b.includes(`/${dir}/`));

            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;

            return 0;
        });

        discoveryLogger.debug('Prioritized directories for search', {
            name,
            contextDir,
            prioritizedDirectories: prioritizedDirectories.slice(0, 5)
        });

        // Try each directory in priority order, checking for manifest
        for (const dir of prioritizedDirectories) {
            discoveryLogger.debug('Searching in directory', { name, dir });
            const agentPath = await this.searchForAgentInDirectory(name, dir);
            if (agentPath) {
                // Check if card exists for this agent
                const cardExists = await this.checkCardExists(agentPath, name);
                if (cardExists) {
                    discoveryLogger.debug('Found complete agent (with agent-card.json)', { name, dir, agentPath });
                    return agentPath;
                }
                discoveryLogger.debug('Found agent but no card, continuing search', { name, dir, agentPath });
            }
        }

        // Fallback: return first found agent even without card
        for (const dir of prioritizedDirectories) {
            const found = await this.searchForAgentInDirectory(name, dir);
            if (found) {
                discoveryLogger.debug('Fallback: returning agent without card', { name, dir, found });
                return found;
            }
        }

        discoveryLogger.debug('Smart discovery completed - no agent found', {
            name,
            searchedDirectories: agentDirectories.length
        });
        return null;
    }

    /**
     * Discover directories that contain agent-like files
     */
    private static async discoverAgentDirectories(): Promise<string[]> {
        const now = Date.now();

        // Use cached results if recent
        if (this.cache.discoveredDirectories.length > 0 &&
            now - this.cache.lastScan < this.CACHE_TTL) {
            return this.cache.discoveredDirectories;
        }

        const directories = new Set<string>();

        // Scan for agent patterns using manual directory traversal
        await this.scanDirectoryForAgents('.', directories, 0);

        // Update cache
        this.cache.discoveredDirectories = Array.from(directories);
        this.cache.lastScan = now;

        discoveryLogger.debug('Discovered agent directories', {
            count: directories.size,
            directories: Array.from(directories).slice(0, 10) // Log first 10
        });

        return this.cache.discoveredDirectories;
    }

    /**
     * Recursively scan directory for agent files
     */
    private static async scanDirectoryForAgents(
        dir: string,
        foundDirs: Set<string>,
        depth: number
    ): Promise<void> {
        if (depth > this.MAX_SCAN_DEPTH) return;

        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            // Check if this directory contains agent files
            const hasAgentFiles = entries.some(entry =>
                entry.isFile() && this.isAgentFile(entry.name)
            );

            if (hasAgentFiles) {
                foundDirs.add(path.resolve(dir));
            }

            // Recursively scan subdirectories
            for (const entry of entries) {
                if (entry.isDirectory() && !this.shouldIgnoreDirectory(entry.name)) {
                    const subDir = path.join(dir, entry.name);
                    await this.scanDirectoryForAgents(subDir, foundDirs, depth + 1);
                }
            }
        } catch {
            // Directory not accessible, skip
        }
    }

    /**
     * Check if filename indicates an agent file (case-insensitive)
     */
    private static isAgentFile(filename: string): boolean {
        const lower = filename.toLowerCase();
        // Ignore map files, type definitions, and common non-agent patterns
        if (lower.endsWith('.map') || lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) {
            return false;
        }

        // Only consider .js, .mjs, .cjs, .ts, .mts, .cts files
        if (!/\.(j|t)s$|\.(m|c)(j|t)s$/.test(lower)) {
            return false;
        }

        return (
            lower.includes('agent') ||
            lower === 'agentmodule.js' ||
            lower === 'agentmodule.ts' ||
            lower === 'index.js' ||
            lower === 'index.ts' ||
            lower === 'agent.js' ||
            lower === 'agent.ts'
        );
    }

    /**
     * Check if directory should be ignored during scanning
     */
    private static shouldIgnoreDirectory(dirname: string): boolean {
        const lower = dirname.toLowerCase();
        return (
            lower === 'node_modules' ||
            lower === 'test' ||
            lower === 'tests' ||
            lower === '.git' ||
            lower === 'coverage' ||
            lower.startsWith('.')
        );
    }

    /**
     * Search for agent in a specific path (workspace pattern)
     */
    private static async searchInPath(name: string, searchPath: string): Promise<string | null> {
        try {
            const entries = await fs.readdir(searchPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory() && this.nameMatches(entry.name, name)) {
                    const agentDir = path.join(searchPath, entry.name);
                    const found = await this.searchInDirectory(name, agentDir);
                    if (found) return found;
                }
            }
        } catch {
            // Path doesn't exist or not accessible
        }

        return null;
    }

    /**
     * Search for agent files in a specific directory
     */
    private static async searchInDirectory(name: string, dir: string): Promise<string | null> {
        const possibleNames = this.generateAgentFilenames(name);

        try {
            // Prefer compiled `dist/` entrypoints when present (avoid importing root `agent.ts` in examples)
            const distDir = path.join(dir, 'dist');
            try {
                const distFiles = await fs.readdir(distDir);
                for (const file of distFiles) {
                    for (const possibleName of possibleNames) {
                        if (file.toLowerCase() === possibleName.toLowerCase()) {
                            const fullPath = path.join(distDir, file);
                            try {
                                await fs.access(fullPath);
                                return fullPath;
                            } catch {
                                continue;
                            }
                        }
                    }
                }
            } catch {
                // No dist directory
            }

            const files = await fs.readdir(dir);
            for (const file of files) {
                for (const possibleName of possibleNames) {
                    if (file.toLowerCase() === possibleName.toLowerCase()) {
                        const fullPath = path.join(dir, file);
                        try {
                            await fs.access(fullPath);
                            return fullPath;
                        } catch {
                            continue;
                        }
                    }
                }
            }
        } catch {
            // Directory not accessible
        }

        return null;
    }

    /**
     * Check if an agent-card.json exists for the given agent path and name
     */
    private static async checkCardExists(agentPath: string, expectedName: string): Promise<boolean> {
        let agentDir = path.dirname(agentPath);
        if (path.basename(agentDir).toLowerCase() === 'dist') {
            agentDir = path.dirname(agentDir);
        }
        const cardPath = path.join(agentDir, 'agent-card.json');

        try {
            await fs.access(cardPath);

            // Validate that this card actually belongs to the requested agent
            try {
                const cardContent = await fs.readFile(cardPath, 'utf8');
                const card = JSON.parse(cardContent);

                // Check if the card name matches what we're looking for
                return card.name === expectedName;
            } catch {
                // Failed to parse card
                return false;
            }
        } catch {
            // No card file found
            return false;
        }
    }

    /**
     * Search for agent in a discovered directory
     */
    private static async searchForAgentInDirectory(name: string, dir: string): Promise<string | null> {
        // First check if the directory name matches the agent name
        const dirName = path.basename(dir);
        if (this.nameMatches(dirName, name)) {
            return this.searchInDirectory(name, dir);
        }

        // Check subdirectories for category-based agents
        const { category, name: agentName } = this.parseAgentName(name);
        if (category) {
            const categoryDir = path.join(dir, category);
            try {
                await fs.access(categoryDir);
                const found = await this.searchInDirectory(agentName, categoryDir);
                if (found) return found;
            } catch {
                // Category directory doesn't exist
            }
        }

        return null;
    }

    /**
     * Generate possible filenames for an agent (case-insensitive)
     */
    private static generateAgentFilenames(name: string): string[] {
        const baseName = name.replace(/-agent$/i, ''); // Remove -agent suffix
        const pascalName = this.toPascalCase(baseName);
        const camelName = this.toCamelCase(baseName);

        return [
            // PascalCase patterns
            `${pascalName}Agent.ts`,
            `${pascalName}Agent.js`,
            `${pascalName}.ts`,
            `${pascalName}.js`,

            // camelCase patterns  
            `${camelName}Agent.ts`,
            `${camelName}Agent.js`,
            `${camelName}.ts`,
            `${camelName}.js`,

            // kebab-case patterns
            `${baseName}-agent.ts`,
            `${baseName}-agent.js`,
            `${baseName}.ts`,
            `${baseName}.js`,

            // Exact name patterns
            `${name}.ts`,
            `${name}.js`,

            // Generic patterns
            'AgentModule.ts',
            'AgentModule.js',
            'agent.ts',
            'agent.js',
            'index.ts',
            'index.js'
        ];
    }

    /**
     * Convert string to PascalCase
     */
    private static toPascalCase(str: string): string {
        return str
            .split(/[-_\s]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    /**
     * Convert string to camelCase
     */
    private static toCamelCase(str: string): string {
        const pascal = this.toPascalCase(str);
        return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    }

    /**
     * Find manifest paths for an agent (both card and runtime)
     */
    static async findManifestPaths(name: string, contextPath?: string): Promise<DiscoveredManifestPaths | null> {
        discoveryLogger.debug('Searching for agent manifest paths', { name, contextPath });

        // Try to find the agent first
        const agentPath = await this.findAgent(name, contextPath);
        if (!agentPath) {
            discoveryLogger.debug('Agent not found, cannot search for manifests', { name });
            return null;
        }

        let agentDir = path.dirname(agentPath);
        if (path.basename(agentDir).toLowerCase() === 'dist') {
            agentDir = path.dirname(agentDir);
        }
        const cardPath = path.join(agentDir, 'agent-card.json');
        const runtimePath = path.join(agentDir, 'agent-runtime.json');

        const result: DiscoveredManifestPaths = {
            agentCardPath: null,
            runtimeManifestPath: null
        };

        try {
            await fs.access(cardPath);
            result.agentCardPath = cardPath;
        } catch {
            discoveryLogger.debug('No agent-card.json found in agent directory', { agentDir });
        }

        try {
            await fs.access(runtimePath);
            result.runtimeManifestPath = runtimePath;
        } catch {
            discoveryLogger.debug('No agent-runtime.json found in agent directory', { agentDir });
        }

        return result;
    }

    /**
     * Search for the correct manifest file when the obvious location doesn't work
     */
    private static async searchForCorrectManifest(name: string, agentPath: string): Promise<string | null> {
        const agentDir = path.dirname(agentPath);

        // Search in parent directories (up to 3 levels)
        let currentDir = agentDir;
        for (let i = 0; i < 3; i++) {
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) break; // Reached root

            const manifestPath = path.join(parentDir, 'agent.json');
            try {
                await fs.access(manifestPath);
                const manifestContent = await fs.readFile(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);

                if (manifest.name === name) {
                    discoveryLogger.debug('Found matching manifest in parent directory', {
                        name,
                        manifestPath,
                        level: i + 1
                    });
                    return manifestPath;
                }
            } catch {
                // Continue searching
            }

            currentDir = parentDir;
        }

        // Search in sibling directories (for category-based structures)
        const parentDir = path.dirname(agentDir);
        try {
            const siblings = await fs.readdir(parentDir, { withFileTypes: true });

            for (const sibling of siblings) {
                if (sibling.isDirectory() && sibling.name !== path.basename(agentDir)) {
                    const siblingManifestPath = path.join(parentDir, sibling.name, 'agent.json');
                    try {
                        await fs.access(siblingManifestPath);
                        const manifestContent = await fs.readFile(siblingManifestPath, 'utf8');
                        const manifest = JSON.parse(manifestContent);

                        if (manifest.name === name) {
                            discoveryLogger.debug('Found matching manifest in sibling directory', {
                                name,
                                manifestPath: siblingManifestPath
                            });
                            return siblingManifestPath;
                        }
                    } catch {
                        // Continue searching
                    }
                }
            }
        } catch {
            // Parent directory not accessible
        }

        discoveryLogger.debug('No matching manifest found after exhaustive search', { name, agentPath });
        return null;
    }

    /**
     * Legacy helper for finding a manifest path (prefers card)
     */
    static async findManifest(name: string, contextPath?: string): Promise<string | null> {
        const paths = await this.findManifestPaths(name, contextPath);
        return paths?.agentCardPath || paths?.runtimeManifestPath || null;
    }

    /**
     * List all discoverable agents
     */
    static async listAvailableAgents(): Promise<Array<{ name: string; agentPath: string; agentCardPath: string | null; runtimeManifestPath: string | null }>> {
        const agentsMap = new Map<string, { name: string; agentPath: string; agentCardPath: string | null; runtimeManifestPath: string | null }>();
        const discoveredDirs = await this.discoverAgentDirectories();

        for (const dir of discoveredDirs) {
            try {
                const files = await fs.readdir(dir);

                // Priority within a directory: 
                // 1. Files containing "agent" (exact match "agent.js/ts" preferred)
                // 2. index.js/ts
                const sortedFiles = files.filter(f => this.isAgentFile(f)).sort((a, b) => {
                    const la = a.toLowerCase();
                    const lb = b.toLowerCase();
                    if (la === 'agent.js' || la === 'agent.ts') return -1;
                    if (lb === 'agent.js' || lb === 'agent.ts') return 1;
                    return la.localeCompare(lb);
                });

                for (const file of sortedFiles) {
                    const agentPath = path.join(dir, file);
                    const agentName = this.extractAgentNameFromPath(agentPath);

                    // If we already found this agent name in THIS directory (or previous), keep the first one
                    // The first one is likely the most "standard" due to our sorting
                    if (!agentsMap.has(agentName)) {
                        const manifests = await this.findManifestPaths(agentName, agentPath);

                        agentsMap.set(agentName, {
                            name: agentName,
                            agentPath,
                            agentCardPath: manifests?.agentCardPath || null,
                            runtimeManifestPath: manifests?.runtimeManifestPath || null
                        });
                    }
                }
            } catch {
                // Directory not accessible
            }
        }

        return Array.from(agentsMap.values());
    }

    /**
     * Extract agent name from file path
     */
    private static extractAgentNameFromPath(agentPath: string): string {
        const ext = path.extname(agentPath);
        const filename = path.basename(agentPath, ext);
        const dirname = path.basename(path.dirname(agentPath));

        // If filename is generic (index, agent, AgentModule), use directory name
        const lowerFilename = filename.toLowerCase();
        if (['index', 'agent', 'agentmodule'].includes(lowerFilename)) {
            return dirname;
        }

        // If the filename contains "agent" but it's not JUST "agent", 
        // we might have something like "my-cool-agent.ts"
        let name = filename;
        if (lowerFilename.endsWith('agent') && lowerFilename !== 'agent') {
            name = filename.slice(0, -5); // Remove "agent" or "Agent"
        }

        // Convert CamelCase/PascalCase to kebab-case
        return name
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
    }

    /**
     * Clear discovery cache (useful for testing)
     */
    static clearCache(): void {
        this.cache.agentLocations.clear();
        this.cache.discoveredDirectories = [];
        this.cache.lastScan = 0;
        this.cache.workspacePaths = null;
        this.registry.agents.clear();
    }

    /**
     * Validate that an agent directory has the required structure
     * @param agentName - Name of the agent to validate
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Validation result with errors
     */
    static async validateAgentStructure(agentName: string, contextPath?: string): Promise<{ isValid: boolean; errors: string[] }> {
        const errors: string[] = [];

        discoveryLogger.debug('Validating agent structure', {
            agentName,
            contextPath
        });

        const agentPath = await this.findAgent(agentName, contextPath);
        if (!agentPath) {
            errors.push(`Agent file not found for '${agentName}'`);
        }

        // For folder-based discovery, also check for card file
        if (!contextPath) {
            const manifests = await this.findManifestPaths(agentName);
            if (!manifests?.agentCardPath) {
                errors.push(`Agent card file (agent-card.json) not found for '${agentName}'`);
            }
        }
        // For filename-based discovery, agents should use inline manifests

        return {
            isValid: errors.length === 0,
            errors
        };
    }
} 