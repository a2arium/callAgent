import path from 'node:path';
import fs from 'node:fs'; // Use sync read for simplicity in minimal setup
import type { AgentPlugin, CreateAgentPluginOptions } from './types.js';
import type { AgentManifest } from '../../shared/types/index.js';
import { registerPlugin } from './pluginRegistry.js';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { ManifestError, PluginError } from '../../utils/errors.js';
import { LLMCallerAdapter } from '../llm/LLMCallerAdapter.js';
import { createLLMForTask } from '../llm/LLMFactory.js';

// Create component-specific logger
const pluginLogger = logger.createLogger({ prefix: 'PluginLoader' });

/**
 * Helper to get __dirname in ES modules
 * @param metaUrl - import.meta.url from the caller
 * @returns Directory path of the caller
 */
const getDirname = (metaUrl: string): string => path.dirname(fileURLToPath(metaUrl));

/**
 * Creates and registers an agent plugin with the framework
 * @param options - Configuration options for the plugin
 * @param metaUrl - import.meta.url from the caller for path resolution
 * @returns The created agent plugin instance
 * @throws {ManifestError} If the manifest cannot be loaded or is invalid
 * @throws {PluginError} If plugin creation fails for other reasons
 */
export const createAgentPlugin = (options: CreateAgentPluginOptions, metaUrl: string): AgentPlugin => {
    // Get caller directory directly from required metaUrl
    const callerDir = getDirname(metaUrl);

    pluginLogger.debug('Creating agent plugin', {
        metaUrl,
        callerDir
    });

    let manifest: AgentManifest;

    if (typeof options.manifest === 'string') {
        // Resolve path relative to the calling module's directory
        const manifestPath = path.resolve(callerDir, options.manifest);
        pluginLogger.debug('Loading manifest from path', { manifestPath });

        try {
            // Synchronous read for simplicity in minimal setup, async in prod
            const manifestJson = fs.readFileSync(manifestPath, 'utf8');
            manifest = JSON.parse(manifestJson);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            pluginLogger.error('Failed to load manifest', error, { manifestPath });
            throw new ManifestError(`Failed to load agent manifest from ${manifestPath}: ${message}`, { manifestPath });
        }
    } else {
        pluginLogger.debug('Using provided manifest object');
        manifest = options.manifest;
    }

    // Basic validation (can expand later)
    if (!manifest.name || !manifest.version) {
        pluginLogger.error('Invalid manifest', null, { manifest });
        throw new ManifestError('Invalid agent manifest: missing name or version', { manifest });
    }

    const plugin: AgentPlugin = {
        manifest,
        handleTask: options.handleTask,
        // Future hooks (initialize, etc.) would be stored here
    };

    // If llmConfig is provided, create an LLM adapter and store it on the plugin
    if (options.llmConfig) {
        try {
            pluginLogger.debug('Creating LLM adapter for plugin', {
                provider: options.llmConfig.provider,
                model: options.llmConfig.modelAliasOrName
            });
            // Store the config instead of creating the adapter directly
            // The adapter will be created per-task in the runner with automatic usage tracking
            plugin.llmConfig = options.llmConfig;
            pluginLogger.info(`LLM config stored for plugin: ${manifest.name}`);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            pluginLogger.error('Failed to setup LLM config', error);
            throw new PluginError(`Failed to setup LLM config for plugin ${manifest.name}: ${message}`);
        }
    }

    // Register the plugin
    registerPlugin(plugin);
    pluginLogger.info(`Plugin registered successfully: ${manifest.name} (v${manifest.version})`);

    return plugin; // Returned value is primarily for typing consistency
};

/**
 * Minimal Plugin Discovery & Loading Utility for the Runner
 * This is intentionally left simple/placeholder as the runner will dynamically import.
 * In a full framework, this would be more sophisticated (scanning node_modules, DI containers, etc.)
 * @param pluginDir - Directory to scan for plugins
 */
export async function loadPlugins(pluginDir: string): Promise<void> {
    // Simple glob/readdir in pluginDir to find AgentModule.ts or AgentModule.js
    // For this minimal example, let's assume the runner imports specific files directly
    // or we provide a hardcoded list for simplicity.
    // A slightly less minimal version might use glob:
    // const files = await glob('**/AgentModule.{js,ts}', { cwd: pluginDir });
    // for (const file of files) {
    //     await import(path.resolve(pluginDir, file)); // Importing triggers createAgentPlugin
    // }
    pluginLogger.info(`Plugin discovery placeholder. Directory: ${pluginDir}`);
    pluginLogger.info('Runner should directly import plugin files.');
} 