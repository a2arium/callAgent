import path from 'node:path';
import type { AgentPlugin, CreateAgentPluginOptions } from './types.js';
import type { Modules } from '../loop/oneTurn.js';
import { PluginManager } from './pluginManager.js';
import { fileURLToPath } from 'node:url';
import { logger } from '@a2arium/callagent-utils';
import { resolveTenantId, validateTenantId } from './tenantResolver.js';
import { resolveManifests } from './manifestResolver.js';

// Create component-specific logger
const pluginLogger = logger.createLogger({ prefix: 'PluginLoader' });

/**
 * Helper to get __dirname in ES modules
 * @param metaUrl - import.meta.url from the caller
 * @returns Directory path of the caller
 */
const getDirname = (metaUrl: string): string => path.dirname(fileURLToPath(metaUrl));

/**
 * Creates and registers an agent with the framework.
 * Resolves both Agent Card and Runtime Manifest asynchronously.
 * 
 * @param options - Configuration options for the agent
 * @param metaUrl - import.meta.url from the caller for path resolution
 * @returns A promise resolving to the created agent instance
 */
export const createAgent = async <
    Sensory = unknown,
    Obs = unknown,
    Alpha = unknown,
    ExecData = unknown,
    ExecError extends import('../loop/oneTurn.js').ExecErrorPayload = import('../loop/oneTurn.js').ExecErrorPayload
>(
    options: CreateAgentPluginOptions<Sensory, Obs, Alpha, ExecData, ExecError>,
    metaUrl?: string
): Promise<AgentPlugin> => {
    // Fall back to stacking trace inference if explicit metaUrl is not provided
    let callerDir = process.cwd();
    if (metaUrl) {
        callerDir = getDirname(metaUrl);
    } else {
        try {
            const stack = new Error().stack?.split('\n') || [];
            for (let i = 2; i < stack.length; i++) {
                const line = stack[i];
                const match = line.match(/(?:file:\/\/|\/)([^\s\(\)]+?)(?::\d+:\d+)/);
                if (match && match[1]) {
                    const extracted = match[1];
                    const rawPath = line.includes('file://') ? fileURLToPath('file://' + extracted) : (extracted.startsWith('/') ? extracted : `/${extracted}`);
                    callerDir = path.dirname(rawPath);
                    break;
                }
            }
        } catch { /* fallback to cwd */ }
    }

    // Resolve tenant ID
    const tenantId = resolveTenantId(options.tenantId);
    validateTenantId(tenantId);

    pluginLogger.debug('Creating agent (async)', {
        callerDir,
        tenantId
    });

    // Phase 1: Resolve and Validate Manifests (New System)
    const resolved = await resolveManifests(callerDir, {
        agentCard: options.agentCard,
        runtimeManifest: options.runtimeManifest
    });

    // Build loop.modules from either explicit loop or top-level sugar (per-key so TS narrows each module type)
    type Mods = Modules<Sensory, Obs, Alpha, ExecData, ExecError>;
    const sugarModules: Partial<Mods> = {};
    if (typeof options.attention === 'function') sugarModules.attention = options.attention;
    if (typeof options.perception === 'function') sugarModules.perception = options.perception;
    if (typeof options.learning === 'function') sugarModules.learning = options.learning;
    if (typeof options.policy === 'function') sugarModules.policy = options.policy;
    if (typeof options.shield === 'function') sugarModules.shield = options.shield;
    if (typeof options.execution === 'function') sugarModules.execution = options.execution;
    if (typeof options.transition === 'function') sugarModules.transition = options.transition;

    const hasSugar = Object.keys(sugarModules).length > 0;
    const loop = hasSugar
        ? { modules: { ...(options.loop?.modules ?? {}), ...sugarModules } }
        : options.loop;

    const plugin: AgentPlugin = {
        resolved,
        handleTask: options.handleTask,
        tenantId: tenantId,
        // AgentPlugin uses default `Modules` type params; agent-specific generics are preserved at `handleTask` / runtime loop wiring.
        loop: loop as AgentPlugin['loop'],
        llmConfig: options.llmConfig,
        llmAdapter: options.llmAdapter,
    };

    // Register with framework
    PluginManager.registerAgent(plugin);

    return plugin;
};