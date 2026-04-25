import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginManager } from './pluginManager.js';
import { logger } from '@a2arium/callagent-utils';
import { DEFAULT_AGENT_INDEX_PATH, AgentIndexEntry } from './AgentIndexBuilder.js';

const loaderLogger = logger.createLogger({ prefix: 'AgentIndexLoader' });

const loadedPaths = new Set<string>();

export interface LoadAgentIndexOptions {
    /**
     * Optional override for the index location. Defaults to `.callagent/agent-paths.json`.
     */
    indexPath?: string;
    /**
     * Working directory used to resolve relative paths inside the index file. Defaults to `process.cwd()`.
     */
    cwd?: string;
    /**
     * When true, suppresses informational logging. Warnings and errors still appear.
     */
    silent?: boolean;
}

type RawIndexShape = Record<string, unknown>;

const toAbsolute = (value: string, baseDir: string): string => path.resolve(baseDir, value);
const isTypeScriptModulePath = (modulePath: string): boolean => /\.(ts|mts|cts)$/i.test(modulePath);
const hasTypeScriptRuntimeSupport = (): boolean => {
    const argv = process.execArgv.join(' ');
    return argv.includes('ts-node') || argv.includes('tsx');
};

const normalizeEntry = (entry: unknown): AgentIndexEntry | null => {
    if (typeof entry === 'string') {
        return { module: entry };
    }
    if (entry && typeof entry === 'object') {
        const candidate = entry as Partial<AgentIndexEntry>;
        if (typeof candidate.module === 'string') {
            return {
                module: candidate.module,
                agentCard: typeof candidate.agentCard === 'string' ? candidate.agentCard : null,
                runtimeManifest: typeof candidate.runtimeManifest === 'string' ? candidate.runtimeManifest : null
            };
        }
    }
    return null;
};

/** Avoid `String(unknown)` when a thrown value blocks primitive conversion (e.g. null-prototype object). */
const formatUnknownThrownValue = (value: unknown): string => {
    if (value instanceof Error) {
        return value.message;
    }
    try {
        return String(value);
    } catch {
        try {
            return Object.prototype.toString.call(value);
        } catch {
            return '<unrepresentable thrown value>';
        }
    }
};

export async function loadAgentIndex(options: LoadAgentIndexOptions = {}): Promise<{ loaded: string[]; skipped: string[] }> {
    const cwd = options.cwd ?? process.cwd();
    const indexPath = path.resolve(cwd, options.indexPath ?? DEFAULT_AGENT_INDEX_PATH);
    const normalizedIndexPath = path.normalize(indexPath);

    if (loadedPaths.has(normalizedIndexPath)) {
        return { loaded: [], skipped: [] };
    }

    let json: RawIndexShape;
    try {
        const content = await fs.readFile(indexPath, 'utf8');
        json = JSON.parse(content) as RawIndexShape;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            if (!options.silent) {
                loaderLogger.debug('Agent index not found', { indexPath });
            }
            return { loaded: [], skipped: [] };
        }

        loaderLogger.error('Failed to read agent index', error, { indexPath });
        throw error;
    }

    const baseDir = path.dirname(indexPath);
    const loadedAgents: string[] = [];
    const skippedAgents: string[] = [];
    const manifestByAgent = new Map<string, string | undefined>();

    for (const [agentName, rawEntry] of Object.entries(json)) {
        const entry = normalizeEntry(rawEntry);
        if (!entry) {
            skippedAgents.push(agentName);
            if (!options.silent) {
                loaderLogger.warn('Skipping malformed agent index entry. Expected string module path or object with string `module`.', {
                    agentName,
                    entryType: rawEntry === null ? 'null' : typeof rawEntry
                });
            }
            continue;
        }
        const modulePath = entry.module;
        if (!modulePath) {
            skippedAgents.push(agentName);
            continue;
        }

        const absoluteModulePath = toAbsolute(modulePath, baseDir);
        const agentCardPath = entry.agentCard ? toAbsolute(entry.agentCard, baseDir) : undefined;
        const runtimeManifestPath = entry.runtimeManifest ? toAbsolute(entry.runtimeManifest, baseDir) : undefined;

        try {
            if (PluginManager.isAgentLoaded(agentName)) {
                skippedAgents.push(agentName);
                continue;
            }

            manifestByAgent.set(agentName, agentCardPath || runtimeManifestPath);

            if (isTypeScriptModulePath(absoluteModulePath) && !hasTypeScriptRuntimeSupport()) {
                skippedAgents.push(agentName);
                if (!options.silent) {
                    loaderLogger.warn(
                        'Agent index points to a TypeScript module that this runtime cannot import directly. ' +
                            'Compile the agent to .js or run with a TypeScript loader (for example tsx or ts-node/esm).',
                        {
                            agentName,
                            modulePath: absoluteModulePath
                        }
                    );
                }
                try {
                    const discovered = await PluginManager.loadAgent(agentName);
                    if (discovered) {
                        loadedAgents.push(agentName);
                    }
                } catch (fallbackError) {
                    if (!options.silent) {
                        loaderLogger.error('Fallback discovery failed for TypeScript index entry', fallbackError, {
                            agentName
                        });
                    }
                }
                continue;
            }

            const moduleUrl = pathToFileURL(absoluteModulePath).href;
            const agentModule = await import(moduleUrl);

            const registered = PluginManager.findAgent(agentName);
            if (!registered) {
                const newAgents = PluginManager.listAgents().filter(card => {
                    return card.name === agentName;
                });
                if (!newAgents.length) {
                    skippedAgents.push(agentName);
                    if (!options.silent) {
                        loaderLogger.warn('Module imported but agent was not registered. Ensure createAgent is executed on import.', {
                            agentName,
                            modulePath: absoluteModulePath
                        });
                    }
                    continue;
                }
            }

            loadedAgents.push(agentName);
        } catch (error: unknown) {
            skippedAgents.push(agentName);
            if (!options.silent) {
                loaderLogger.warn('Failed to load agent from index entry. Falling back to discovery.', {
                    agentName,
                    modulePath: absoluteModulePath,
                    error: formatUnknownThrownValue(error)
                });
            }
            try {
                const discovered = await PluginManager.loadAgent(agentName);
                if (discovered) {
                    loadedAgents.push(agentName);
                    continue;
                }
            } catch (fallbackError) {
                if (!options.silent) {
                    loaderLogger.error('Fallback discovery failed for agent', fallbackError, {
                        agentName
                    });
                }
            }
        }
    }

    loadedPaths.add(normalizedIndexPath);

    if (!options.silent) {
        loaderLogger.debug('Agent index loaded', {
            indexPath,
            loaded: loadedAgents.length,
            skipped: skippedAgents.length
        });
        if (!loadedAgents.length) {
            loaderLogger.warn('No agents were loaded from the index. Run "yarn agent-index" to refresh .callagent/agent-paths.json', {
                indexPath
            });
        }
    }

    return { loaded: loadedAgents, skipped: skippedAgents };
}

export async function loadAgentIndexIfPresent(options: LoadAgentIndexOptions = {}): Promise<void> {
    try {
        const cwd = options.cwd ?? process.cwd();
        const resolvedIndexPath = path.resolve(cwd, options.indexPath ?? DEFAULT_AGENT_INDEX_PATH);
        const result = await loadAgentIndex({ ...options, silent: false });
        if (!result.loaded.length && !result.skipped.length) {
            loaderLogger.warn(
                `Agent index not found. Run "yarn agent-index" to generate ${DEFAULT_AGENT_INDEX_PATH}. Falling back to smart discovery.`,
                {
                    cwd,
                    indexPath: resolvedIndexPath,
                }
            );
        }
    } catch (error) {
        loaderLogger.error('Agent index load failed', error);
    }
}

