import path from 'node:path';
import fs from 'node:fs'; // Use sync read for simplicity in minimal setup
import type { AgentPlugin, CreateAgentPluginOptions } from './types.js';
import type { AgentManifest } from '../shared/types/index.js';
import { PluginManager } from './pluginManager.js';
import { fileURLToPath } from 'node:url';
import { logger } from '@a2arium/callagent-utils';
import { ManifestError, PluginError } from '../utils/errors.js';
import { LLMCallerAdapter } from '../llm/LLMCallerAdapter.js';
import { createLLMForTask } from '../llm/LLMFactory.js';
import { resolveTenantId, validateTenantId } from './tenantResolver.js';

// Create component-specific logger
const pluginLogger = logger.createLogger({ prefix: 'PluginLoader' });

/**
 * Helper to get __dirname in ES modules
 * @param metaUrl - import.meta.url from the caller
 * @returns Directory path of the caller
 */
const getDirname = (metaUrl: string): string => path.dirname(fileURLToPath(metaUrl));

/**
 * Creates and registers an agent with the framework
 * @param options - Configuration options for the agent
 * @param metaUrl - import.meta.url from the caller for path resolution
 * @returns The created agent instance
 * @throws {ManifestError} If the manifest cannot be loaded or is invalid
 * @throws {PluginError} If agent creation fails for other reasons
 */
export const createAgent = <
    Sensory = unknown,
    Obs = unknown,
    Alpha = unknown,
    ExecData = unknown,
    ExecError extends import('../loop/oneTurn.js').ExecErrorPayload = import('../loop/oneTurn.js').ExecErrorPayload,
    ObsConfigOrPayload extends import('../loop/oneTurn.js').ObservationConfig = import('../loop/oneTurn.js').ObservationConfig
>(
    options: CreateAgentPluginOptions<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>,
    metaUrl?: string
): AgentPlugin => {
    // ✅ BUG FIX: Make metaUrl optional to prevent "path argument must be of type string" crash when omitted
    // Fall back to stacking trace inference if explicit metaUrl is not provided (e.g. from wrapper functions)
    let callerDir = process.cwd();
    if (metaUrl) {
        callerDir = getDirname(metaUrl);
    } else {
        try {
            const stack = new Error().stack?.split('\n') || [];
            for (let i = 2; i < stack.length; i++) {
                const line = stack[i];
                // Match both file:// URLs (ESM) and absolute paths (CJS/Jest)
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

    // Resolve tenant ID using hierarchy: explicit → env → default
    const tenantId = resolveTenantId(options.tenantId);
    validateTenantId(tenantId);

    pluginLogger.debug('Creating agent', {
        metaUrl,
        callerDir,
        tenantId
    });

    let manifest: AgentManifest;

    // Phase 1: Establish base manifest
    if (typeof options.manifest === 'string') {
        // Custom JSON file specified
        const manifestPath = path.resolve(callerDir, options.manifest);
        try {
            const manifestJson = fs.readFileSync(manifestPath, 'utf8');
            manifest = JSON.parse(manifestJson);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ManifestError(`Failed to load agent manifest from ${manifestPath}: ${message}`, { manifestPath });
        }
    } else if (options.manifest && typeof options.manifest === 'object') {
        // Inline manifest object provided
        manifest = { ...options.manifest };
    } else {
        // No manifest provided at all, we'll try to discover agent.json below
        manifest = {} as any;
    }

    // Phase 2: Discovery & Deep Merge (BUG 1 FIX)
    // Always try to find and merge agent.json if we are in a directory that looks like an agent folder
    // and we don't have a full manifest yet, OR if we have a partial manifest and want to fill in defaults.
    const defaultJsonPath = path.resolve(callerDir, 'agent.json');
    if (fs.existsSync(defaultJsonPath)) {
        try {
            const jsonContent = fs.readFileSync(defaultJsonPath, 'utf8');
            const jsonManifest = JSON.parse(jsonContent);

            // If we already have a manifest (from inline options), deep merge it with agent.json
            // and ensure agent.json provides the defaults.
            const base = jsonManifest;
            const explicit = manifest;

            // Start with everything from agent.json
            const merged = { ...base };

            // Overwrite with explicit options, but PROTECT nested objects like budget
            for (const [key, value] of Object.entries(explicit)) {
                if (value === undefined) continue;

                if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
                    typeof (merged as any)[key] === 'object' && (merged as any)[key] !== null) {
                    // Deep merge for nested objects (e.g., budget, capabilities)
                    (merged as any)[key] = {
                        ...(merged as any)[key],
                        ...Object.fromEntries(Object.entries(value).filter(([_, v]) => v !== undefined))
                    };
                } else {
                    // Direct overwrite for primitives, arrays, or new keys
                    (merged as any)[key] = value;
                }
            }
            manifest = merged;

            // Validation: agent.json can only be used if it matches the folder/name structure (security/sanity check)
            let folderName = path.basename(callerDir);
            if (folderName === 'dist') folderName = path.basename(path.dirname(callerDir));

            const validateFolderStructure = (mName: string, fName: string): boolean => {
                if (!mName) return true;
                if (mName.includes('/')) {
                    const parts = mName.split('/');
                    if (parts.length === 2) {
                        const parentDir = path.dirname(callerDir === 'dist' ? path.dirname(callerDir) : callerDir);
                        const categoryName = path.basename(path.dirname(parentDir));
                        return parts[1] === fName && parts[0] === categoryName;
                    }
                }
                return mName === fName;
            };

            if (!validateFolderStructure(manifest.name, folderName)) {
                pluginLogger.warn('agent.json name mismatch with folder structure', {
                    manifestName: manifest.name,
                    folderName
                });
            }

        } catch (err) {
            pluginLogger.warn('Found agent.json but failed to merge it', { error: err });
        }
    }

    // Phase 3: Final validation
    if (!manifest.name || !manifest.version) {
        pluginLogger.error('Invalid manifest', null, { manifest });
        throw new ManifestError('Invalid agent manifest: missing name or version. Ensure agent.json exists or inline manifest provides these.', { manifest });
    }

    // Build loop.modules from either explicit loop or top-level sugar
    const sugarModules: Record<string, unknown> = {};
    const moduleKeys: Array<
        keyof NonNullable<
            NonNullable<CreateAgentPluginOptions<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['loop']>['modules']
        >
    > = ['attention', 'perception', 'learning', 'policy', 'shield', 'execution', 'transition'];
    for (const k of moduleKeys) {
        const v = (options as any)[k];
        if (typeof v === 'function') sugarModules[k as string] = v;
    }
    const hasSugar = Object.keys(sugarModules).length > 0;
    const loop = hasSugar ? { modules: { ...(options.loop?.modules || {}), ...(sugarModules as any) } } : options.loop;

    const plugin: AgentPlugin = {
        manifest,
        handleTask: options.handleTask,
        tenantId: tenantId,
        loop: loop as any,
        llmConfig: options.llmConfig,     // ✅ BUG 7 FIX: Forward LLM Configuration
        llmAdapter: options.llmAdapter,   // ✅ BUG 7 FIX: Forward custom adapter if provided
    };

    // Register with framework
    PluginManager.registerAgent(plugin);

    return plugin;
};