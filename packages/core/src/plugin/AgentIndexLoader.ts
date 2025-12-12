import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginManager } from './pluginManager.js';
import { logger } from '@a2arium/callagent-utils';
import { DEFAULT_AGENT_INDEX_PATH, AgentIndexEntry, AgentIndexRecord } from './AgentIndexBuilder.js';

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

type IndexShape = AgentIndexRecord | Record<string, string>;

const toAbsolute = (value: string, baseDir: string): string => path.resolve(baseDir, value);

const isAgentIndexRecord = (value: IndexShape): value is AgentIndexRecord => {
    return Object.values(value).every(entry => typeof entry === 'object');
};

export async function loadAgentIndex(options: LoadAgentIndexOptions = {}): Promise<{ loaded: string[]; skipped: string[] }> {
    const cwd = options.cwd ?? process.cwd();
    const indexPath = path.resolve(cwd, options.indexPath ?? DEFAULT_AGENT_INDEX_PATH);
    const normalizedIndexPath = path.normalize(indexPath);

    if (loadedPaths.has(normalizedIndexPath)) {
        return { loaded: [], skipped: [] };
    }

    let json: IndexShape;
    try {
        const content = await fs.readFile(indexPath, 'utf8');
        json = JSON.parse(content) as IndexShape;
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

    const entries: AgentIndexRecord = isAgentIndexRecord(json)
        ? json
        : Object.fromEntries(
              Object.entries(json).map(([name, module]) => [name, { module } as AgentIndexEntry])
          );

    for (const [agentName, entry] of Object.entries(entries)) {
        const modulePath = entry.module;
        if (!modulePath) {
            skippedAgents.push(agentName);
            continue;
        }

        const absoluteModulePath = toAbsolute(modulePath, baseDir);
        const manifestPath = entry.manifest ? toAbsolute(entry.manifest, baseDir) : undefined;

        try {
            if (PluginManager.isAgentLoaded(agentName)) {
                skippedAgents.push(agentName);
                continue;
            }

            manifestByAgent.set(agentName, manifestPath);

            const moduleUrl = pathToFileURL(absoluteModulePath).href;
            const agentModule = await import(moduleUrl);

            const registered = PluginManager.findAgent(agentName);
            if (!registered) {
                const newAgents = PluginManager.listAgents().filter(agent => {
                    const manifest = agent.manifest as { name?: string } | undefined;
                    return manifest?.name === agentName;
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
        } catch (error) {
            skippedAgents.push(agentName);
            if (!options.silent) {
                loaderLogger.warn('Failed to load agent from index entry. Falling back to discovery.', {
                    agentName,
                    modulePath: absoluteModulePath,
                    error: error instanceof Error ? error.message : String(error)
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
        const result = await loadAgentIndex({ ...options, silent: false });
        if (!result.loaded.length && !result.skipped.length) {
            loaderLogger.warn(`Agent index not found. Run "yarn agent-index" to generate ${DEFAULT_AGENT_INDEX_PATH}. Falling back to smart discovery.`);
        }
    } catch (error) {
        loaderLogger.error('Agent index load failed', error);
    }
}

