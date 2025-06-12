import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '@callagent/utils';

const discoveryLogger = logger.createLogger({ prefix: 'AgentDiscovery' });

/**
 * Parsed agent name structure for category-based organization
 */
type ParsedAgentName = {
    category?: string;
    name: string;
    fullName: string;
};

/**
 * Service for discovering agent files and manifests in standard locations
 * Searches through examples directories and dist folders
 * Supports both traditional flat structure and category-based subfolders
 */
export class AgentDiscoveryService {
    /**
     * Parse agent name to support category-based organization
     * @param agentName - Agent name (e.g., 'hello-agent' or 'data-processing/csv-parser')
     * @returns Parsed agent name components
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
            // Invalid format - treat as simple name
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
     * Find the agent file for a given agent name
     * Supports both folder-based discovery and filename-based discovery within the same folder
     * Now supports category-based organization (e.g., 'data-processing/csv-parser')
     * @param agentName - Name of the agent to find (supports 'category/agent' format)
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Path to agent file or null if not found
     */
    static async findAgentFile(agentName: string, contextPath?: string): Promise<string | null> {
        discoveryLogger.debug('Searching for agent file', { agentName, contextPath });

        // First try traditional folder-based discovery (supports categories)
        const traditionalResult = await this.findAgentFileInFolder(agentName);
        if (traditionalResult) {
            return traditionalResult;
        }

        // If we have a context path, try same-folder filename-based discovery
        if (contextPath) {
            const sameDirectoryResult = await this.findAgentFileInSameDirectory(agentName, contextPath);
            if (sameDirectoryResult) {
                discoveryLogger.info('Found agent file via filename-based discovery', {
                    agentName,
                    path: sameDirectoryResult,
                    contextPath
                });
                return sameDirectoryResult;
            }
        }

        discoveryLogger.debug('Agent file not found', { agentName, contextPath });
        return null;
    }

    /**
     * Find agent file using traditional folder-based discovery
     * Now supports category-based organization
     * @param agentName - Name of the agent to find (supports 'category/agent' format)
     * @returns Path to agent file or null if not found
     */
    private static async findAgentFileInFolder(agentName: string): Promise<string | null> {
        const searchPaths = this.getAgentSearchPaths();
        const agentFileNames = this.getAgentFileNames(agentName);
        const { category, name } = this.parseAgentName(agentName);

        discoveryLogger.debug('Folder-based discovery', {
            agentName,
            category,
            name,
            searchPaths: searchPaths.length
        });

        for (const searchPath of searchPaths) {
            for (const fileName of agentFileNames) {
                // Priority 1: Category-based search (if category is specified)
                if (category) {
                    const categoryAgentDir = path.join(searchPath, category, name);

                    // Try dist subdirectory first
                    const categoryDistPath = path.join(categoryAgentDir, 'dist', fileName);
                    try {
                        await fs.access(categoryDistPath);
                        discoveryLogger.info('Found agent file in category dist (folder-based)', {
                            agentName,
                            category,
                            name,
                            path: categoryDistPath
                        });
                        return categoryDistPath;
                    } catch {
                        // File doesn't exist in category dist, continue
                    }

                    // Try root directory in category
                    const categoryRootPath = path.join(categoryAgentDir, fileName);
                    try {
                        await fs.access(categoryRootPath);
                        discoveryLogger.info('Found agent file in category root (folder-based)', {
                            agentName,
                            category,
                            name,
                            path: categoryRootPath
                        });
                        return categoryRootPath;
                    } catch {
                        // File doesn't exist in category root, continue
                    }
                }

                // Priority 2: Root-level search (backward compatibility)
                const agentDir = category ? name : agentName; // Use simple name for root-level search

                // Try dist subdirectory
                const distPath = path.join(searchPath, agentDir, 'dist', fileName);
                try {
                    await fs.access(distPath);
                    discoveryLogger.info('Found agent file in root dist (folder-based)', {
                        agentName,
                        agentDir,
                        path: distPath
                    });
                    return distPath;
                } catch {
                    // File doesn't exist in dist, continue
                }

                // Try root directory
                const rootPath = path.join(searchPath, agentDir, fileName);
                try {
                    await fs.access(rootPath);
                    discoveryLogger.info('Found agent file in root (folder-based)', {
                        agentName,
                        agentDir,
                        path: rootPath
                    });
                    return rootPath;
                } catch {
                    // File doesn't exist, continue searching
                }
            }
        }

        return null;
    }

    /**
     * Find agent file in the same directory as the context path using filename-based discovery
     * @param agentName - Name of the agent to find
     * @param contextPath - Path to the main agent file for context
     * @returns Path to agent file or null if not found
     */
    private static async findAgentFileInSameDirectory(agentName: string, contextPath: string): Promise<string | null> {
        try {
            const contextDir = path.dirname(contextPath);
            discoveryLogger.debug('Searching same directory for agent by filename', {
                agentName,
                contextDir,
                contextPath
            });

            // Get agent-specific filenames (no generic patterns for same-directory discovery)
            const possibleFilenames = this.getAgentSpecificFilenames(agentName);

            // Check each possible filename in the context directory
            for (const filename of possibleFilenames) {
                const agentPath = path.join(contextDir, filename);
                try {
                    await fs.access(agentPath);
                    discoveryLogger.debug('Found matching filename', {
                        agentName,
                        filename,
                        agentPath
                    });
                    return agentPath;
                } catch {
                    // File doesn't exist, continue
                }
            }

            // Also check dist subdirectory
            const distDir = path.join(contextDir, 'dist');
            try {
                await fs.access(distDir);
                for (const filename of possibleFilenames) {
                    const agentPath = path.join(distDir, filename);
                    try {
                        await fs.access(agentPath);
                        discoveryLogger.debug('Found matching filename in dist', {
                            agentName,
                            filename,
                            agentPath
                        });
                        return agentPath;
                    } catch {
                        // File doesn't exist, continue
                    }
                }
            } catch {
                // dist directory doesn't exist, skip
            }

            // If not found in same directory, check sibling directories for folder-based structure
            // This handles cases like src/agents/agentA/ and src/agents/agentB/
            const parentDir = path.dirname(contextDir);
            const siblingAgentDir = path.join(parentDir, agentName);

            discoveryLogger.debug('Checking sibling directory for folder-based structure', {
                agentName,
                parentDir,
                siblingAgentDir
            });

            // Check if sibling directory exists and contains agent files
            try {
                await fs.access(siblingAgentDir);

                // For sibling directories (agent-specific folders), use full filename patterns including generic ones
                const siblingFilenames = this.getFilenamesForAgentName(agentName);

                // Check for agent files in the sibling directory
                for (const filename of siblingFilenames) {
                    const agentPath = path.join(siblingAgentDir, filename);
                    try {
                        await fs.access(agentPath);
                        discoveryLogger.debug('Found agent in sibling directory', {
                            agentName,
                            filename,
                            agentPath,
                            siblingAgentDir
                        });
                        return agentPath;
                    } catch {
                        // File doesn't exist, continue
                    }
                }

                // Also check dist subdirectory in sibling directory
                const siblingDistDir = path.join(siblingAgentDir, 'dist');
                try {
                    await fs.access(siblingDistDir);
                    for (const filename of siblingFilenames) {
                        const agentPath = path.join(siblingDistDir, filename);
                        try {
                            await fs.access(agentPath);
                            discoveryLogger.debug('Found agent in sibling dist directory', {
                                agentName,
                                filename,
                                agentPath,
                                siblingDistDir
                            });
                            return agentPath;
                        } catch {
                            // File doesn't exist, continue
                        }
                    }
                } catch {
                    // Sibling dist directory doesn't exist, skip
                }
            } catch {
                // Sibling directory doesn't exist, skip
            }

            discoveryLogger.debug('No matching filename found in same or sibling directories', {
                agentName,
                contextDir,
                parentDir,
                siblingAgentDir,
                checkedFilenames: possibleFilenames
            });
            return null;

        } catch (error) {
            discoveryLogger.debug('Same directory search failed', { agentName, contextPath, error });
            return null;
        }
    }

    /**
     * Get agent-specific filenames for a given agent name
     * Used for same-directory discovery where we need exact matches
     * @param agentName - Agent name (e.g., 'multiplication-agent')
     * @returns Array of agent-specific filenames (no generic patterns)
     */
    private static getAgentSpecificFilenames(agentName: string): string[] {
        // Convert kebab-case agent name to various filename patterns
        const baseName = agentName.replace(/-agent$/, ''); // Remove -agent suffix if present
        const pascalName = this.toPascalCase(baseName);
        const camelName = this.toCamelCase(baseName);

        return [
            // PascalCase patterns (most common for multi-agent folders)
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

            // Exact agent name patterns
            `${agentName}.ts`,
            `${agentName}.js`
        ];
    }

    /**
     * Get possible filenames for a given agent name including generic patterns
     * Used for folder-based discovery where generic patterns are acceptable
     * @param agentName - Agent name (e.g., 'multiplication-agent')
     * @returns Array of possible filenames including generic patterns
     */
    private static getFilenamesForAgentName(agentName: string): string[] {
        const specificFilenames = this.getAgentSpecificFilenames(agentName);

        // Add generic patterns for folder-based discovery
        const genericPatterns = [
            'AgentModule.ts',
            'AgentModule.js',
            'agent.ts',
            'agent.js',
            'index.ts',
            'index.js'
        ];

        return [...specificFilenames, ...genericPatterns];
    }

    /**
     * Convert kebab-case to camelCase
     * @param str - kebab-case string
     * @returns camelCase string
     */
    private static toCamelCase(str: string): string {
        return str
            .split(/[-_]/)
            .map((word, index) =>
                index === 0
                    ? word.toLowerCase()
                    : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
            )
            .join('');
    }

    /**
     * Find the manifest file (agent.json) for an agent
     * Supports both standard search paths and context-aware sibling directory discovery
     * Now supports category-based organization (e.g., 'data-processing/csv-parser')
     * @param agentName - Name of the agent to find manifest for (supports 'category/agent' format)
     * @param contextPath - Optional context path for sibling directory discovery
     * @returns Path to agent.json file or null if not found
     */
    static async findManifestFile(agentName: string, contextPath?: string): Promise<string | null> {
        discoveryLogger.debug('Searching for agent.json manifest file', { agentName, contextPath });
        const { category, name } = this.parseAgentName(agentName);

        // If we have a context path, try sibling directory discovery first
        if (contextPath) {
            const contextDir = path.dirname(contextPath);
            const parentDir = path.dirname(contextDir);

            // For category-based agents, check both category structure and simple structure
            const siblingPaths = category
                ? [path.join(parentDir, category, name), path.join(parentDir, name)]
                : [path.join(parentDir, agentName)];

            for (const siblingAgentDir of siblingPaths) {
                discoveryLogger.debug('Checking sibling directory for manifest', {
                    agentName,
                    contextDir,
                    parentDir,
                    siblingAgentDir,
                    category,
                    name
                });

                // Check for agent.json in sibling directory
                try {
                    await fs.access(siblingAgentDir);

                    // Try the dist subdirectory first (for compiled agents)
                    const siblingDistPath = path.join(siblingAgentDir, 'dist', 'agent.json');
                    try {
                        await fs.access(siblingDistPath);
                        discoveryLogger.info('Found agent.json in sibling dist', {
                            agentName,
                            category,
                            name,
                            path: siblingDistPath
                        });
                        return siblingDistPath;
                    } catch {
                        // File doesn't exist in dist, continue
                    }

                    // Then try the root directory (for source files)
                    const siblingRootPath = path.join(siblingAgentDir, 'agent.json');
                    try {
                        await fs.access(siblingRootPath);
                        discoveryLogger.info('Found agent.json in sibling root', {
                            agentName,
                            category,
                            name,
                            path: siblingRootPath
                        });
                        return siblingRootPath;
                    } catch {
                        // File doesn't exist, continue
                    }
                } catch {
                    // Sibling directory doesn't exist, continue to next path
                }
            }
        }

        // Fall back to standard search paths
        const searchPaths = this.getManifestSearchPaths();

        for (const searchPath of searchPaths) {
            // Priority 1: Category-based search (if category is specified)
            if (category) {
                const categoryAgentDir = path.join(searchPath, category, name);

                // Try dist subdirectory first
                const categoryDistPath = path.join(categoryAgentDir, 'dist', 'agent.json');
                try {
                    await fs.access(categoryDistPath);
                    discoveryLogger.info('Found agent.json in category dist', {
                        agentName,
                        category,
                        name,
                        path: categoryDistPath
                    });
                    return categoryDistPath;
                } catch {
                    // File doesn't exist in category dist, continue
                }

                // Try root directory in category
                const categoryRootPath = path.join(categoryAgentDir, 'agent.json');
                try {
                    await fs.access(categoryRootPath);
                    discoveryLogger.info('Found agent.json in category root', {
                        agentName,
                        category,
                        name,
                        path: categoryRootPath
                    });
                    return categoryRootPath;
                } catch {
                    // File doesn't exist in category root, continue
                }
            }

            // Priority 2: Root-level search (backward compatibility)
            const agentDir = category ? name : agentName; // Use simple name for root-level search

            // Try dist subdirectory
            const distPath = path.join(searchPath, agentDir, 'dist', 'agent.json');
            try {
                await fs.access(distPath);
                discoveryLogger.info('Found agent.json in root dist', {
                    agentName,
                    agentDir,
                    path: distPath
                });
                return distPath;
            } catch {
                // File doesn't exist in dist, continue
            }

            // Try root directory
            const rootPath = path.join(searchPath, agentDir, 'agent.json');
            try {
                await fs.access(rootPath);
                discoveryLogger.info('Found agent.json in root', {
                    agentName,
                    agentDir,
                    path: rootPath
                });
                return rootPath;
            } catch {
                // File doesn't exist, continue searching
            }
        }

        discoveryLogger.debug('agent.json not found for agent', { agentName, category, name, searchPaths, contextPath });
        return null;
    }

    /**
     * Get standard search paths for agent files
     * Includes both source and compiled output directories
     * Prioritizes individual package dist directories over root dist
     */
    static getAgentSearchPaths(): string[] {
        return [
            'apps/examples',           // Source examples (with individual dist folders)
            'packages/examples',       // Alternative location (with individual dist folders)
            'dist/apps/examples',      // Root compiled examples
            'dist/packages/examples',  // Root compiled alternative
            '.',                       // Current directory (for single-agent projects)
            '..'                       // Parent directory (for agents one level up)
        ];
    }

    /**
     * Get standard search paths for manifest files
     * Same as agent search paths since manifests are co-located with agents
     */
    static getManifestSearchPaths(): string[] {
        return this.getAgentSearchPaths();
    }

    /**
     * Get possible agent file names for a given agent name
     * Checks multiple naming conventions and file extensions
     */
    private static getAgentFileNames(agentName: string): string[] {
        const baseName = agentName.replace(/-agent$/, ''); // Remove -agent suffix if present
        const pascalName = this.toPascalCase(baseName);

        return [
            // Common patterns
            'AgentModule.js',
            'AgentModule.ts',
            'agent.js',
            'agent.ts',
            'index.js',
            'index.ts',

            // Agent-specific patterns
            `${pascalName}Agent.js`,
            `${pascalName}Agent.ts`,
            `${baseName}-agent.js`,
            `${baseName}-agent.ts`,
            `${baseName}.js`,
            `${baseName}.ts`,

            // Capital versions
            `${pascalName}.js`,
            `${pascalName}.ts`,
        ];
    }

    /**
     * Get possible manifest file names for a given agent name
     * Simplified logic: only 'agent.json' is supported for external manifests
     */
    private static getManifestFileNames(agentName: string): string[] {
        return [
            'agent.json'  // Only agent.json is supported for external manifests
        ];
    }

    /**
     * Convert a kebab-case or snake_case string to PascalCase
     */
    private static toPascalCase(str: string): string {
        return str
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    /**
     * List all discoverable agents in the search paths
     * Supports both traditional flat structure and category-based organization
     * Useful for debugging and CLI tools
     */
    static async listAvailableAgents(): Promise<Array<{ name: string; agentPath: string; manifestPath: string | null }>> {
        const agents: Array<{ name: string; agentPath: string; manifestPath: string | null }> = [];
        const searchPaths = this.getAgentSearchPaths();

        for (const searchPath of searchPaths) {
            try {
                const entries = await fs.readdir(searchPath, { withFileTypes: true });

                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const folderName = entry.name;

                        // Check if this is a category folder (contains subdirectories with agents)
                        const categoryPath = path.join(searchPath, folderName);
                        try {
                            const categoryEntries = await fs.readdir(categoryPath, { withFileTypes: true });
                            const hasSubdirectories = categoryEntries.some(subEntry => subEntry.isDirectory());

                            if (hasSubdirectories) {
                                // This might be a category folder, check subdirectories for agents
                                for (const subEntry of categoryEntries) {
                                    if (subEntry.isDirectory()) {
                                        const categoryAgentName = `${folderName}/${subEntry.name}`;
                                        const agentPath = await this.findAgentFile(categoryAgentName);

                                        if (agentPath) {
                                            const manifestPath = await this.findManifestFile(categoryAgentName);
                                            agents.push({
                                                name: categoryAgentName,
                                                agentPath,
                                                manifestPath
                                            });
                                        }
                                    }
                                }
                            }
                        } catch {
                            // Not a readable directory or no subdirectories, skip category check
                        }

                        // Also check if this is a traditional agent folder (backward compatibility)
                        const agentPath = await this.findAgentFile(folderName);
                        if (agentPath) {
                            const manifestPath = await this.findManifestFile(folderName);
                            agents.push({ name: folderName, agentPath, manifestPath });
                        }
                    }
                }
            } catch (error) {
                // Search path doesn't exist or isn't readable, skip it
                discoveryLogger.debug('Skipping search path', { searchPath, error });
            }
        }

        return agents;
    }

    /**
     * Validate that an agent directory has the required structure
     * Supports both folder-based and filename-based discovery
     * Now supports category-based organization (e.g., 'data-processing/csv-parser')
     * @param agentName - Name of the agent to validate (supports 'category/agent' format)
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Validation result with errors
     */
    static async validateAgentStructure(agentName: string, contextPath?: string): Promise<{ isValid: boolean; errors: string[] }> {
        const errors: string[] = [];
        const { category, name } = this.parseAgentName(agentName);

        discoveryLogger.debug('Validating agent structure', {
            agentName,
            category,
            name,
            contextPath
        });

        const agentPath = await this.findAgentFile(agentName, contextPath);
        if (!agentPath) {
            if (category) {
                errors.push(`Agent file not found for '${agentName}' (category: '${category}', name: '${name}')`);
            } else {
                errors.push(`Agent file not found for '${agentName}'`);
            }
        }

        // For folder-based discovery, also check for manifest file
        if (!contextPath) {
            const manifestPath = await this.findManifestFile(agentName);
            if (!manifestPath) {
                if (category) {
                    errors.push(`Manifest file not found for '${agentName}' (category: '${category}', name: '${name}')`);
                } else {
                    errors.push(`Manifest file not found for '${agentName}'`);
                }
            }
        }
        // For filename-based discovery, agents should use inline manifests

        return {
            isValid: errors.length === 0,
            errors
        };
    }
} 