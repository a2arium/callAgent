import type { AgentPlugin } from './types.js';
import { logger } from '../../utils/logger.js';

// Create component-specific logger
const registryLogger = logger.createLogger({ prefix: 'PluginRegistry' });

/**
 * In-memory registry of loaded agent plugins
 */
const pluginRegistry: Map<string, AgentPlugin> = new Map();

/**
 * Register an agent plugin with the framework
 * @param plugin - The agent plugin to register
 */
export const registerPlugin = (plugin: AgentPlugin): void => {
    if (pluginRegistry.has(plugin.manifest.name)) {
        registryLogger.warn(`Duplicate plugin name registered: ${plugin.manifest.name}. Overwriting.`, {
            existing: pluginRegistry.get(plugin.manifest.name)?.manifest.version,
            new: plugin.manifest.version
        });
    }
    pluginRegistry.set(plugin.manifest.name, plugin);
    registryLogger.info(`Registered: ${plugin.manifest.name} (v${plugin.manifest.version})`);
};

/**
 * Get a plugin by name
 * @param name - Name of the plugin to retrieve
 * @returns The plugin if found, undefined otherwise
 */
export const getPlugin = (name: string): AgentPlugin | undefined => pluginRegistry.get(name);

/**
 * List all registered plugins
 * @returns Array of all registered plugins
 */
export const listPlugins = (): AgentPlugin[] => Array.from(pluginRegistry.values()); 