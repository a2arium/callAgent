import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '@callagent/utils';

const discoveryLogger = logger.createLogger({ prefix: 'AgentDiscovery' });

/**
 * Service for discovering agent files and manifests in standard locations
 * Searches through examples directories and dist folders
 */
export class AgentDiscoveryService {
    /**
     * Find the main agent file (TypeScript or JavaScript) by agent name
     * @param agentName - Name of the agent to find
     * @returns Path to agent file or null if not found
     */
    static async findAgentFile(agentName: string): Promise<string | null> {
        discoveryLogger.debug('Searching for agent file', { agentName });

        const searchPaths = this.getAgentSearchPaths();
        const agentFileNames = this.getAgentFileNames(agentName);

        // Try both dist subdirectory and root directory for each search path
        for (const searchPath of searchPaths) {
            // First try the dist subdirectory (for individual package builds)
            for (const fileName of agentFileNames) {
                const distPath = path.join(searchPath, agentName, 'dist', fileName);
                try {
                    await fs.access(distPath);
                    discoveryLogger.info('Found agent file in dist', { agentName, path: distPath });
                    return distPath;
                } catch {
                    // File doesn't exist in dist, continue
                }
            }

            // Then try the root directory (for source files or root builds)
            for (const fileName of agentFileNames) {
                const rootPath = path.join(searchPath, agentName, fileName);
                try {
                    await fs.access(rootPath);
                    discoveryLogger.info('Found agent file in root', { agentName, path: rootPath });
                    return rootPath;
                } catch {
                    // File doesn't exist, continue searching
                }
            }
        }

        discoveryLogger.warn('Agent file not found', { agentName, searchPaths });
        return null;
    }

    /**
     * Find the manifest file (agent.json or named manifest) for an agent
     * @param agentName - Name of the agent to find manifest for
     * @returns Path to manifest file or null if not found
     */
    static async findManifestFile(agentName: string): Promise<string | null> {
        discoveryLogger.debug('Searching for manifest file', { agentName });

        const searchPaths = this.getManifestSearchPaths();
        const manifestFileNames = this.getManifestFileNames(agentName);

        // Try both dist subdirectory and root directory for each search path
        for (const searchPath of searchPaths) {
            // First try the dist subdirectory (for individual package builds)
            for (const fileName of manifestFileNames) {
                const distPath = path.join(searchPath, agentName, 'dist', fileName);
                try {
                    await fs.access(distPath);
                    discoveryLogger.info('Found manifest file in dist', { agentName, path: distPath });
                    return distPath;
                } catch {
                    // File doesn't exist in dist, continue
                }
            }

            // Then try the root directory (for source files or root builds)
            for (const fileName of manifestFileNames) {
                const rootPath = path.join(searchPath, agentName, fileName);
                try {
                    await fs.access(rootPath);
                    discoveryLogger.info('Found manifest file in root', { agentName, path: rootPath });
                    return rootPath;
                } catch {
                    // File doesn't exist, continue searching
                }
            }
        }

        discoveryLogger.warn('Manifest file not found', { agentName, searchPaths });
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
            '.'                        // Current directory (for single-agent projects)
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
     */
    private static getManifestFileNames(agentName: string): string[] {
        return [
            'agent.json',                    // Standard manifest name
            `${agentName}.json`,             // Agent-specific manifest
            `${agentName}-manifest.json`,    // Alternative naming
            'manifest.json',                 // Generic manifest
            'package.json'                   // Fallback to package.json
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
                        // Try both discovery approaches:
                        // 1. Traditional: folder name = agent name (backward compatibility)
                        // 2. Enhanced: scan for multiple agents in folder

                        const folderPath = path.join(searchPath, entry.name);
                        const discoveredAgents = await this.discoverAgentsInDirectory(folderPath, entry.name);
                        agents.push(...discoveredAgents);
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
     * Discover all agents within a specific directory
     * Supports both single-agent folders and multi-agent folders
     * @param directoryPath - Path to the directory to scan
     * @param folderName - Name of the folder (used for backward compatibility)
     * @returns Array of discovered agents
     */
    private static async discoverAgentsInDirectory(
        directoryPath: string,
        folderName: string
    ): Promise<Array<{ name: string; agentPath: string; manifestPath: string | null }>> {
        const agents: Array<{ name: string; agentPath: string; manifestPath: string | null }> = [];

        try {
            // First, try traditional approach (folder name = agent name)
            const traditionalAgent = await this.tryTraditionalDiscovery(directoryPath, folderName);
            if (traditionalAgent) {
                agents.push(traditionalAgent);
                return agents; // If traditional works, use it (backward compatibility)
            }

            // If traditional approach fails, try enhanced discovery
            const enhancedAgents = await this.tryEnhancedDiscovery(directoryPath);
            agents.push(...enhancedAgents);

        } catch (error) {
            discoveryLogger.debug('Failed to discover agents in directory', { directoryPath, error });
        }

        return agents;
    }

    /**
     * Try traditional discovery approach (folder name = agent name)
     */
    private static async tryTraditionalDiscovery(
        directoryPath: string,
        folderName: string
    ): Promise<{ name: string; agentPath: string; manifestPath: string | null } | null> {
        const agentPath = await this.findAgentFile(folderName);
        if (agentPath && agentPath.includes(directoryPath)) {
            const manifestPath = await this.findManifestFile(folderName);
            return { name: folderName, agentPath, manifestPath };
        }
        return null;
    }

    /**
     * Try enhanced discovery approach (scan for multiple agent files)
     */
    private static async tryEnhancedDiscovery(
        directoryPath: string
    ): Promise<Array<{ name: string; agentPath: string; manifestPath: string | null }>> {
        const agents: Array<{ name: string; agentPath: string; manifestPath: string | null }> = [];

        try {
            // Find all potential agent files in the directory
            const agentFiles = await this.findAllAgentFilesInDirectory(directoryPath);

            for (const agentFile of agentFiles) {
                try {
                    // Extract agent name from the file's manifest
                    const agentName = await this.extractAgentNameFromFile(agentFile);
                    if (agentName) {
                        // Find corresponding manifest file
                        const manifestPath = await this.findManifestFileForAgent(directoryPath, agentName);
                        agents.push({ name: agentName, agentPath: agentFile, manifestPath });
                    }
                } catch (error) {
                    discoveryLogger.debug('Failed to extract agent name from file', { agentFile, error });
                }
            }
        } catch (error) {
            discoveryLogger.debug('Enhanced discovery failed', { directoryPath, error });
        }

        return agents;
    }

    /**
     * Find all potential agent files in a directory
     */
    private static async findAllAgentFilesInDirectory(directoryPath: string): Promise<string[]> {
        const agentFiles: string[] = [];

        try {
            const entries = await fs.readdir(directoryPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isFile()) {
                    const fileName = entry.name;

                    // Check if this looks like an agent file
                    if (this.isLikelyAgentFile(fileName)) {
                        agentFiles.push(path.join(directoryPath, fileName));
                    }
                }

                // Also check dist subdirectory
                if (entry.isDirectory() && entry.name === 'dist') {
                    const distPath = path.join(directoryPath, 'dist');
                    const distFiles = await this.findAllAgentFilesInDirectory(distPath);
                    agentFiles.push(...distFiles);
                }
            }
        } catch (error) {
            discoveryLogger.debug('Failed to scan directory for agent files', { directoryPath, error });
        }

        return agentFiles;
    }

    /**
     * Check if a filename looks like an agent file
     */
    private static isLikelyAgentFile(fileName: string): boolean {
        const agentPatterns = [
            /^AgentModule\.(js|ts)$/,
            /^.*Agent\.(js|ts)$/,
            /^agent\.(js|ts)$/,
            /^index\.(js|ts)$/,
            /.*-agent\.(js|ts)$/
        ];

        return agentPatterns.some(pattern => pattern.test(fileName));
    }

    /**
     * Extract agent name from an agent file by reading its manifest
     */
    private static async extractAgentNameFromFile(agentFilePath: string): Promise<string | null> {
        try {
            // First try to find inline manifest by importing the file
            const agentName = await this.extractInlineManifestName(agentFilePath);
            if (agentName) {
                return agentName;
            }

            // If no inline manifest, try to infer from filename
            return this.inferAgentNameFromFilename(agentFilePath);
        } catch (error) {
            discoveryLogger.debug('Failed to extract agent name', { agentFilePath, error });
            return null;
        }
    }

    /**
     * Try to extract agent name from inline manifest
     */
    private static async extractInlineManifestName(agentFilePath: string): Promise<string | null> {
        try {
            // This is tricky - we'd need to import the file to get the inline manifest
            // For now, we'll skip this and rely on external manifests or filename inference
            // TODO: Implement safe module inspection without full import
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Infer agent name from filename
     */
    private static inferAgentNameFromFilename(agentFilePath: string): string | null {
        const fileName = path.basename(agentFilePath, path.extname(agentFilePath));

        // Convert various patterns to kebab-case
        if (fileName === 'AgentModule' || fileName === 'index' || fileName === 'agent') {
            // Can't infer from generic names
            return null;
        }

        // Convert PascalCase to kebab-case (e.g., "DataAnalysisAgent" -> "data-analysis-agent")
        if (fileName.endsWith('Agent')) {
            const baseName = fileName.slice(0, -5); // Remove "Agent" suffix
            return this.toKebabCase(baseName);
        }

        // Already in kebab-case or similar
        return this.toKebabCase(fileName);
    }

    /**
     * Convert PascalCase/camelCase to kebab-case
     */
    private static toKebabCase(str: string): string {
        return str
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
    }

    /**
     * Find manifest file for a specific agent in a directory
     */
    private static async findManifestFileForAgent(directoryPath: string, agentName: string): Promise<string | null> {
        const manifestFileNames = this.getManifestFileNames(agentName);

        for (const fileName of manifestFileNames) {
            const manifestPath = path.join(directoryPath, fileName);
            try {
                await fs.access(manifestPath);
                return manifestPath;
            } catch {
                // File doesn't exist, continue
            }
        }

        // Also check dist subdirectory
        const distPath = path.join(directoryPath, 'dist');
        for (const fileName of manifestFileNames) {
            const manifestPath = path.join(distPath, fileName);
            try {
                await fs.access(manifestPath);
                return manifestPath;
            } catch {
                // File doesn't exist, continue
            }
        }

        return null;
    }

    /**
     * Validate that an agent directory has the required structure
     */
    static async validateAgentStructure(agentName: string): Promise<{ isValid: boolean; errors: string[] }> {
        const errors: string[] = [];

        const agentPath = await this.findAgentFile(agentName);
        if (!agentPath) {
            errors.push(`Agent file not found for '${agentName}'`);
        }

        const manifestPath = await this.findManifestFile(agentName);
        if (!manifestPath) {
            errors.push(`Manifest file not found for '${agentName}'`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }
} 