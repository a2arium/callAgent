import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@a2arium/callagent-utils';
import { SmartAgentDiscoveryService } from './dependencies/SmartAgentDiscoveryService.js';

const indexLogger = logger.createLogger({ prefix: 'AgentIndexBuilder' });

const RUNTIME_FILE_CANDIDATES = [
    'agent.js',
    'AgentModule.js',
    'index.js',
    'Agent.js'
];

const SOURCE_FILE_CANDIDATES = [
    'agent.ts',
    'AgentModule.ts',
    'index.ts',
    'Agent.ts'
];

const AGENT_NAME_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/i;

export const DEFAULT_AGENT_INDEX_PATH = '.callagent/agent-paths.json';

export type AgentIndexRecord = Record<string, AgentIndexEntry>;

export interface AgentIndexEntry {
    module: string;
    manifest?: string | null;
}

export interface BuildAgentIndexOptions {
    /**
     * Location where the index should be written. Defaults to `.callagent/agent-paths.json` in the current working directory.
     */
    outputPath?: string;
    /**
     * Working directory used to resolve relative paths. Defaults to `process.cwd()`.
     */
    cwd?: string;
    /**
     * When true, the builder will include unresolved (source) module paths even if no compiled artifact exists.
     * Helpful in CI diagnostics, but disabled by default to ensure index contains runnable modules.
     */
    allowSourceFallback?: boolean;
}

const toPosix = (filePath: string): string => filePath.split(path.sep).join(path.posix.sep);

const fileExists = async (candidate: string): Promise<boolean> => {
    try {
        await fs.access(candidate);
        return true;
    } catch {
        return false;
    }
};

const findFirstExisting = async (dir: string, names: string[]): Promise<string | null> => {
    for (const name of names) {
        const candidate = path.join(dir, name);
        if (await fileExists(candidate)) {
            return candidate;
        }
    }
    return null;
};

const resolveSiblingModule = async (
    absolutePath: string,
    options: BuildAgentIndexOptions
): Promise<string | null> => {
    const normalized = path.normalize(absolutePath);

    if (normalized.includes(`${path.sep}.callagent${path.sep}`)) {
        return null;
    }

    const ext = path.extname(normalized);
    const dir = path.dirname(normalized);

    if (await fileExists(normalized)) {
        if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
            return normalized;
        }

        if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
            const compiled = normalized.slice(0, -ext.length) + '.js';
            if (await fileExists(compiled)) {
                return compiled;
            }
            if (options.allowSourceFallback) {
                return normalized;
            }
            return null;
        }

        if (ext === '.json') {
            const runtime = await findFirstExisting(dir, RUNTIME_FILE_CANDIDATES);
            if (runtime) {
                return runtime;
            }
            if (options.allowSourceFallback) {
                const source = await findFirstExisting(dir, SOURCE_FILE_CANDIDATES);
                if (source) {
                    return source;
                }
            }
            return null;
        }

        if (ext === '.d.ts' || ext === '.map') {
            // Metadata files – not treated as agents and no warning necessary.
            return null;
        }
    }

    // When the path does not exist, check common runtime names relative to the directory.
    const runtime = await findFirstExisting(dir, RUNTIME_FILE_CANDIDATES);
    if (runtime) {
        return runtime;
    }

    if (options.allowSourceFallback) {
        const source = await findFirstExisting(dir, SOURCE_FILE_CANDIDATES);
        if (source) {
            return source;
        }
    }

    return null;
};

const addAlternatePaths = (value: string | null, bucket: Set<string>): void => {
    if (!value) return;
    bucket.add(value);

    const normalized = path.normalize(value);
    const srcSegment = `${path.sep}src${path.sep}`;
    const distSegment = `${path.sep}dist${path.sep}`;

    if (normalized.includes(srcSegment)) {
        bucket.add(normalized.replace(srcSegment, distSegment));
    }

    if (normalized.includes(distSegment)) {
        bucket.add(normalized.replace(distSegment, srcSegment));
    }
};

const resolveModulePath = async (
    name: string,
    agentPath: string | null,
    manifestPath: string | null,
    options: BuildAgentIndexOptions
): Promise<string | null> => {
    const candidates = new Set<string>();

    addAlternatePaths(agentPath, candidates);
    addAlternatePaths(manifestPath, candidates);

    try {
        const smartPath = await SmartAgentDiscoveryService.findAgent(name, agentPath ?? manifestPath ?? undefined);
        if (smartPath) {
            addAlternatePaths(smartPath, candidates);
        }
    } catch {
        // fallthrough
    }

    for (const candidate of candidates) {
        const absolute = path.resolve(candidate);
        const resolved = await resolveSiblingModule(absolute, options);
        if (resolved) {
            return resolved;
        }
    }

    return null;
};

const resolveManifestPath = async (
    name: string,
    manifestCandidate: string | null,
    agentCandidate: string | null
): Promise<string | null> => {
    const candidates = new Set<string>();
    addAlternatePaths(manifestCandidate, candidates);
    addAlternatePaths(agentCandidate, candidates);

    try {
        const smart = await SmartAgentDiscoveryService.findManifest(name, agentCandidate ?? manifestCandidate ?? undefined);
        if (smart) {
            addAlternatePaths(smart, candidates);
        }
    } catch {
        // ignore
    }

    for (const candidate of candidates) {
        const absolute = path.resolve(candidate);
        if (await fileExists(absolute)) {
            return absolute;
        }
    }

    return null;
};

export interface AgentIndexBuildResult {
    outputPath: string;
    index: AgentIndexRecord;
    warnings: string[];
}

export async function buildAgentIndex(options: BuildAgentIndexOptions = {}): Promise<AgentIndexBuildResult> {
    const cwd = options.cwd ?? process.cwd();
    const outputPath = path.resolve(cwd, options.outputPath ?? DEFAULT_AGENT_INDEX_PATH);
    const entries = await SmartAgentDiscoveryService.listAvailableAgents();

    if (!entries.length) {
        indexLogger.warn('No agents discovered during index build');
    }

    const index: AgentIndexRecord = {};
    const primaryModuleByAgent = new Map<string, string>();
    const warnings: string[] = [];

    for (const entry of entries) {
        const { name, agentPath, manifestPath } = entry;

        if (!name || !AGENT_NAME_PATTERN.test(name)) {
            continue;
        }

        const resolvedManifest = await resolveManifestPath(name, manifestPath ?? null, agentPath ?? null);
        if (!resolvedManifest) {
            warnings.push(`Skipping agent "${name}" because manifest could not be located`);
            continue;
        }

        const modulePath = await resolveModulePath(name, agentPath ?? null, resolvedManifest, options);
        if (!modulePath) {
            warnings.push(`Skipping agent "${name}" because runtime module was not found near ${toPosix(path.relative(cwd, agentPath ?? cwd))}`);
            continue;
        }

        if (modulePath.includes(`${path.sep}.callagent${path.sep}`)) {
            continue;
        }

        const base = path.basename(modulePath).toLowerCase();
        const isLikelyAgentModule =
            base === 'agent.js' ||
            base === 'agentmodule.js' ||
            base.endsWith('agent.js');
        if (!isLikelyAgentModule) {
            continue;
        }

        const existingModule = primaryModuleByAgent.get(name);
        if (existingModule) {
            if (path.resolve(existingModule) !== path.resolve(modulePath)) {
                warnings.push(`Duplicate agent name detected: "${name}". Keeping first occurrence and skipping ${modulePath}`);
            }
            continue;
        }

        const relModule = toPosix(path.relative(cwd, modulePath));
        const relManifest = toPosix(path.relative(cwd, resolvedManifest));

        index[name] = {
            module: relModule,
            manifest: relManifest
        };

        primaryModuleByAgent.set(name, modulePath);
    }

    const resolvedDir = path.dirname(outputPath);
    await fs.mkdir(resolvedDir, { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(index, null, 2), 'utf8');

    indexLogger.info('Agent index written', {
        outputPath,
        agentCount: Object.keys(index).length
    });

    for (const warning of warnings) {
        indexLogger.warn(warning);
    }

    return { outputPath, index, warnings };
}

