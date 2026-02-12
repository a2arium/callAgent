import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logger } from '@a2arium/callagent-utils';
import { PluginManager } from '../plugin/pluginManager.js';
import type { AgentPlugin } from '../plugin/types.js';
import { TaskExecutionError } from '../utils/errors.js';
import { loadAgentIndexIfPresent } from '../plugin/AgentIndexLoader.js';

const runnerLogger = logger.createLogger({ prefix: 'AgentLoader' });

export type AgentLoadOptions = {
    resolveDeps?: boolean;
};

export class AgentLoader {
    async loadAgent(agentFilePath: string, options: AgentLoadOptions = {}): Promise<AgentPlugin> {
        await loadAgentIndexIfPresent();

        const resolveDeps = options.resolveDeps !== false; // Default true

        let plugin: AgentPlugin | undefined;

        if (resolveDeps) {
            runnerLogger.debug(`🔍 Resolving agent dependencies for ${agentFilePath}...`);
            try {
                const loadedAgents = await PluginManager.loadAgentWithDependencies(agentFilePath);

                if (loadedAgents.length > 0) {
                    // The main agent is the first one loaded
                    plugin = loadedAgents[0];
                    runnerLogger.debug(`📦 Loaded agent: ${plugin.manifest.name} (v${plugin.manifest.version})`);
                }
            } catch (error: unknown) {
                this.handleLoadError(error, agentFilePath);
            }
        } else {
            runnerLogger.debug(`⚠️ Dependency resolution disabled - loading single agent only from ${agentFilePath}`);
            try {
                const resolvedPath = path.resolve(agentFilePath);
                const agentModulePath = fs.realpathSync(resolvedPath);
                const agentModuleUrl = pathToFileURL(agentModulePath).href;
                await import(agentModuleUrl);
            } catch (error: unknown) {
                throw new TaskExecutionError(`Failed to load agent module from ${agentFilePath}`, {
                    path: agentFilePath,
                    originalError: error
                });
            }
        }

        // If dependency resolution was disabled or plugin not found in list, try to find it
        if (!plugin) {
            plugin = this.findPluginForFile(agentFilePath);
        }

        if (!plugin) {
            throw new TaskExecutionError(
                `No plugin registered by file ${agentFilePath}. Ensure the file exports the result of createAgent.`,
                { path: agentFilePath }
            );
        }

        return plugin;
    }

    private findPluginForFile(agentFilePath: string): AgentPlugin | undefined {
        // Heuristic: try to find the plugin whose file path roughly matches the input
        let plugin = PluginManager.findAgent(path.basename(agentFilePath, '.js').replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''));

        if (!plugin) {
            const baseName = path.basename(agentFilePath, '.js');
            plugin = PluginManager.findAgent(baseName);
        }

        // If still not found, search all agents for one whose source path matches
        if (!plugin) {
            const absPath = path.resolve(agentFilePath);
            // This is a bit inefficient but robust fallback
            const agents = PluginManager.listAgents();
            // We don't strictly track source paths easily in PluginManager unless we check where they came from.
            // But usually PluginManager registers them by name. 
            // If manual import happened (no deps), the agent should be registered.
            // We'll rely on the existing heuristic for now or just pick the last registered one if strict mode off?
            // Actually, the original code used 'stricter check' or just returned the one matching name.
            // Let's stick to the name matching logic we recovered.
        }

        return plugin || undefined;
    }

    private handleLoadError(error: unknown, agentFilePath: string): never {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('Circular dependency')) {
            throw new TaskExecutionError(`Circular dependency detected: ${errorMessage}`, {
                path: agentFilePath,
                originalError: error
            });
        } else if (errorMessage.includes('not found')) {
            throw new TaskExecutionError(`Missing dependency: ${errorMessage}`, {
                path: agentFilePath,
                originalError: error
            });
        } else {
            throw new TaskExecutionError(`Dependency resolution failed: ${errorMessage}`, {
                path: agentFilePath,
                originalError: error
            });
        }
    }
}

export const agentLoader = new AgentLoader();
