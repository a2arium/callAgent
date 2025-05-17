import type { AgentPlugin } from './types.js';
/**
 * Register an agent plugin with the framework
 * @param plugin - The agent plugin to register
 */
export declare const registerPlugin: (plugin: AgentPlugin) => void;
/**
 * Get a plugin by name
 * @param name - Name of the plugin to retrieve
 * @returns The plugin if found, undefined otherwise
 */
export declare const getPlugin: (name: string) => AgentPlugin | undefined;
/**
 * List all registered plugins
 * @returns Array of all registered plugins
 */
export declare const listPlugins: () => AgentPlugin[];
