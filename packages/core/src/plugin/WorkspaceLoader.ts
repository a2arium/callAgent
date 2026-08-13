import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { logger } from '@a2arium/callagent-utils';
import { DEFAULT_AGENT_INDEX_PATH } from './AgentIndexBuilder.js';
import { loadAgentIndex } from './AgentIndexLoader.js';
import { PluginManager } from './pluginManager.js';

const workspaceLogger = logger.createLogger({ prefix: 'WorkspaceLoader' });

const DEFAULT_WORKSPACES_PATH = '.callagent/workspaces.json';
const DEFAULT_ENV_FILE = '.env';

export type WorkspaceDefinition = {
    name: string;
    root: string;
    agentIndex?: string;
    envFile?: string;
};

export type WorkspaceEnvConflict = {
    key: string;
    existingSource: string;
    workspaceName: string;
};

export type WorkspaceLoadResult = {
    name: string;
    root: string;
    agentIndexPath: string;
    envFilePath?: string;
    envKeysApplied: string[];
    envConflicts: WorkspaceEnvConflict[];
    agentsLoaded: string[];
    agentsSkipped: string[];
};

export type WorkspaceLoadSummary = {
    registryPath?: string;
    workspaces: WorkspaceLoadResult[];
};

export type LoadWorkspacesOptions = {
    registryPath?: string;
    cwd?: string;
};

type WorkspaceRegistry = {
    workspaces: WorkspaceDefinition[];
};

type EnvValueSource = {
    source: string;
};

export type AgentWorkspaceInfo = {
    workspaceName: string;
    workspaceRoot: string;
    agentIndexPath: string;
    agentCardPath?: string;
    runtimeManifestPath?: string;
    modulePath?: string;
    loaded: boolean;
};

const envSources = new Map<string, EnvValueSource>();
const agentWorkspaceInfo = new Map<string, AgentWorkspaceInfo>();

export function getAgentWorkspaceInfo(agentName: string): AgentWorkspaceInfo | undefined {
    return agentWorkspaceInfo.get(agentName);
}

export function listAgentWorkspaceInfos(): Array<{ agentName: string; info: AgentWorkspaceInfo }> {
    return Array.from(agentWorkspaceInfo.entries()).map(([agentName, info]) => ({ agentName, info }));
}

/** Records descriptor-backed workspace metadata without loading workspace files or mutating env. */
export function registerAgentWorkspaceInfo(agentName: string, info: AgentWorkspaceInfo): void {
    agentWorkspaceInfo.set(agentName, info);
}

export async function loadWorkspaces(options: LoadWorkspacesOptions = {}): Promise<WorkspaceLoadSummary> {
    const cwd = options.cwd ?? process.cwd();
    const registryPath = await resolveRegistryPath(options.registryPath ?? process.env.CALLAGENT_WORKSPACES, cwd);
    const registry = await readWorkspaceRegistry(registryPath);

    if (!registry) {
        const implicit = implicitWorkspaceFromAgentIndex(cwd);
        if (!implicit) {
            workspaceLogger.debug('Workspace registry not found and CALLAGENT_AGENT_INDEX is not set', {
                registryPath,
            });
            return { registryPath, workspaces: [] };
        }

        const result = await loadWorkspace(implicit, cwd);
        return { workspaces: [result] };
    }

    const registryDir = path.dirname(registryPath);
    const workspaces: WorkspaceLoadResult[] = [];
    for (const workspace of registry.workspaces) {
        workspaces.push(await loadWorkspace(workspace, registryDir));
    }

    workspaceLogger.info('Workspace registry loaded', {
        registryPath,
        workspaces: workspaces.length,
        agentsLoaded: workspaces.reduce((sum, workspace) => sum + workspace.agentsLoaded.length, 0),
        agentsSkipped: workspaces.reduce((sum, workspace) => sum + workspace.agentsSkipped.length, 0),
    });

    return { registryPath, workspaces };
}

async function readWorkspaceRegistry(registryPath: string): Promise<WorkspaceRegistry | null> {
    let raw: string;
    try {
        raw = await fs.readFile(registryPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }

    const parsed = JSON.parse(raw) as unknown;
    const registry = normalizeRegistry(parsed, registryPath);
    if (registry.workspaces.length === 0) {
        throw new Error(`Workspace registry has no workspaces: ${registryPath}`);
    }
    return registry;
}

function normalizeRegistry(value: unknown, registryPath: string): WorkspaceRegistry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Workspace registry must be an object: ${registryPath}`);
    }

    const workspaces = (value as { workspaces?: unknown }).workspaces;
    if (!Array.isArray(workspaces)) {
        throw new Error(`Workspace registry must contain a workspaces array: ${registryPath}`);
    }

    return {
        workspaces: workspaces.map((entry, index) => normalizeWorkspace(entry, index, registryPath)),
    };
}

function normalizeWorkspace(value: unknown, index: number, registryPath: string): WorkspaceDefinition {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Workspace entry ${index} must be an object: ${registryPath}`);
    }

    const entry = value as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
        throw new Error(`Workspace entry ${index} must include a non-empty name: ${registryPath}`);
    }
    if (typeof entry.root !== 'string' || entry.root.trim().length === 0) {
        throw new Error(`Workspace "${entry.name}" must include a non-empty root: ${registryPath}`);
    }

    return {
        name: entry.name.trim(),
        root: entry.root.trim(),
        ...(typeof entry.agentIndex === 'string' && entry.agentIndex.trim().length > 0
            ? { agentIndex: entry.agentIndex.trim() }
            : {}),
        ...(typeof entry.envFile === 'string' && entry.envFile.trim().length > 0
            ? { envFile: entry.envFile.trim() }
            : {}),
    };
}

async function resolveRegistryPath(registryPath: string | undefined, cwd: string): Promise<string> {
    const requestedPath = registryPath ?? DEFAULT_WORKSPACES_PATH;
    if (path.isAbsolute(requestedPath)) {
        return requestedPath;
    }

    const cwdResolved = path.resolve(cwd, requestedPath);
    if (await pathExists(cwdResolved)) {
        return cwdResolved;
    }

    let dir = cwd;
    while (true) {
        const candidate = path.resolve(dir, requestedPath);
        if (await pathExists(candidate)) {
            return candidate;
        }

        const parent = path.dirname(dir);
        if (parent === dir) {
            return cwdResolved;
        }
        dir = parent;
    }
}

function implicitWorkspaceFromAgentIndex(cwd: string): WorkspaceDefinition | null {
    const indexPath = process.env.CALLAGENT_AGENT_INDEX;
    if (!indexPath) return null;

    return {
        name: 'external-agent-index',
        root: cwd,
        agentIndex: path.resolve(cwd, indexPath),
        envFile: DEFAULT_ENV_FILE,
    };
}

async function loadWorkspace(workspace: WorkspaceDefinition, baseDir: string): Promise<WorkspaceLoadResult> {
    const root = path.resolve(baseDir, workspace.root);
    const agentIndexPath = path.resolve(root, workspace.agentIndex ?? DEFAULT_AGENT_INDEX_PATH);
    const envFilePath = path.resolve(root, workspace.envFile ?? DEFAULT_ENV_FILE);
    const { applied, conflicts, found } = await mergeEnvFile(envFilePath, workspace.name);

    const result = await loadAgentIndex({
        indexPath: agentIndexPath,
        cwd: root,
    });
    const indexedAgents = await readWorkspaceAgentIndex(agentIndexPath, root);
    const discoveredAgents = await discoverWorkspaceAgents(root);
    for (const [agentName, entry] of discoveredAgents) {
        if (!indexedAgents.has(agentName)) {
            indexedAgents.set(agentName, entry);
        }
    }

    if (result.loaded.length === 0 && indexedAgents.size === 0) {
        throw new Error(`Workspace "${workspace.name}" did not load any agents from ${agentIndexPath}`);
    }

    const loadedAgentNames = new Set(result.loaded);
    for (const [agentName, entry] of indexedAgents) {
        if (loadedAgentNames.has(agentName) || PluginManager.isAgentLoaded(agentName)) {
            loadedAgentNames.add(agentName);
            continue;
        }
        const loaded = await PluginManager.loadAgent(entry.modulePath ?? agentName);
        if (loaded) {
            loadedAgentNames.add(loaded.resolved.agentCard.name);
        }
    }

    for (const [agentName, entry] of indexedAgents) {
        agentWorkspaceInfo.set(agentName, {
            workspaceName: workspace.name,
            workspaceRoot: root,
            agentIndexPath,
            ...(entry.agentCardPath ? { agentCardPath: entry.agentCardPath } : {}),
            ...(entry.runtimeManifestPath ? { runtimeManifestPath: entry.runtimeManifestPath } : {}),
            ...(entry.modulePath ? { modulePath: entry.modulePath } : {}),
            loaded: loadedAgentNames.has(agentName),
        });
    }

    for (const agentName of result.loaded) {
        const existing = agentWorkspaceInfo.get(agentName);
        agentWorkspaceInfo.set(agentName, {
            workspaceName: workspace.name,
            workspaceRoot: root,
            agentIndexPath,
            ...(existing?.agentCardPath ? { agentCardPath: existing.agentCardPath } : {}),
            ...(existing?.runtimeManifestPath ? { runtimeManifestPath: existing.runtimeManifestPath } : {}),
            ...(existing?.modulePath ? { modulePath: existing.modulePath } : {}),
            loaded: true,
        });
    }

    workspaceLogger.info('Workspace loaded', {
        name: workspace.name,
        root,
        agentIndexPath,
        envFilePath: found ? envFilePath : undefined,
        envKeysApplied: applied.length,
        envConflicts: conflicts.length,
        agentsLoaded: result.loaded.length,
        agentsSkipped: result.skipped.length,
    });

    return {
        name: workspace.name,
        root,
        agentIndexPath,
        ...(found ? { envFilePath } : {}),
        envKeysApplied: applied,
        envConflicts: conflicts,
        agentsLoaded: result.loaded,
        agentsSkipped: result.skipped,
    };
}

async function mergeEnvFile(
    envFilePath: string,
    workspaceName: string
): Promise<{ applied: string[]; conflicts: WorkspaceEnvConflict[]; found: boolean }> {
    let raw: string;
    try {
        raw = await fs.readFile(envFilePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            workspaceLogger.warn('Workspace env file not found; continuing without workspace-specific env', {
                workspaceName,
                envFilePath,
            });
            return { applied: [], conflicts: [], found: false };
        }
        throw error;
    }

    const parsed = parseDotenv(raw);
    const applied: string[] = [];
    const conflicts: WorkspaceEnvConflict[] = [];

    for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
            process.env[key] = value;
            envSources.set(key, { source: `workspace:${workspaceName}` });
            applied.push(key);
            continue;
        }

        const source = envSources.get(key)?.source ?? 'process';
        const conflict = {
            key,
            existingSource: source,
            workspaceName,
        };
        conflicts.push(conflict);
        workspaceLogger.warn('Workspace env key already exists; keeping existing value', conflict);
    }

    return { applied, conflicts, found: true };
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await fs.access(candidate);
        return true;
    } catch {
        return false;
    }
}

async function discoverWorkspaceAgents(
    workspaceRoot: string
): Promise<Map<string, { modulePath?: string; agentCardPath?: string; runtimeManifestPath?: string }>> {
    const entries = new Map<string, { modulePath?: string; agentCardPath?: string; runtimeManifestPath?: string }>();
    await collectWorkspaceAgentCards(path.join(workspaceRoot, 'src', 'agents'), entries);
    return entries;
}

async function collectWorkspaceAgentCards(
    dir: string,
    entries: Map<string, { modulePath?: string; agentCardPath?: string; runtimeManifestPath?: string }>
): Promise<void> {
    let dirents: Array<import('node:fs').Dirent>;
    try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }

    if (dirents.some((entry) => entry.isFile() && entry.name === 'agent-card.json')) {
        const agentCardPath = path.join(dir, 'agent-card.json');
        const agentName = await readAgentNameFromCard(agentCardPath);
        if (agentName !== undefined) {
            const runtimeManifestPath = path.join(dir, 'agent-runtime.json');
            entries.set(agentName, {
                agentCardPath,
                ...(await pathExists(runtimeManifestPath) ? { runtimeManifestPath } : {}),
                ...(await firstExistingPath([
                    path.join(dir, 'agent.ts'),
                    path.join(dir, 'agent.js'),
                    path.join(dir, 'index.ts'),
                    path.join(dir, 'index.js'),
                ]).then((modulePath) => modulePath ? { modulePath } : {})),
            });
        }
    }

    for (const entry of dirents) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
            await collectWorkspaceAgentCards(path.join(dir, entry.name), entries);
        }
    }
}

async function readAgentNameFromCard(agentCardPath: string): Promise<string | undefined> {
    try {
        const parsed = JSON.parse(await fs.readFile(agentCardPath, 'utf8')) as { name?: unknown };
        return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
    } catch {
        return undefined;
    }
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
    for (const candidate of paths) {
        if (await pathExists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

async function readWorkspaceAgentIndex(
    agentIndexPath: string,
    workspaceRoot: string
): Promise<Map<string, { modulePath?: string; agentCardPath?: string; runtimeManifestPath?: string }>> {
    const entries = new Map<string, { modulePath?: string; agentCardPath?: string; runtimeManifestPath?: string }>();
    let raw: string;
    try {
        raw = await fs.readFile(agentIndexPath, 'utf8');
    } catch {
        return entries;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return entries;
    }

    const indexDir = path.dirname(agentIndexPath);
    for (const [agentName, value] of Object.entries(parsed)) {
        const entry = normalizeAgentIndexEntry(value);
        if (!entry) continue;
        entries.set(agentName, {
            modulePath: path.resolve(indexDir, entry.module),
            ...(entry.agentCard ? { agentCardPath: path.resolve(indexDir, entry.agentCard) } : {}),
            ...(entry.runtimeManifest ? { runtimeManifestPath: path.resolve(indexDir, entry.runtimeManifest) } : {}),
        });
    }

    if (entries.size === 0 && workspaceRoot !== indexDir) {
        workspaceLogger.warn('Workspace agent index had no readable entries', { agentIndexPath, workspaceRoot });
    }
    return entries;
}

function normalizeAgentIndexEntry(value: unknown): { module: string; agentCard?: string; runtimeManifest?: string } | null {
    if (typeof value === 'string' && value.length > 0) {
        return { module: value };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.module !== 'string' || candidate.module.length === 0) {
        return null;
    }
    return {
        module: candidate.module,
        ...(typeof candidate.agentCard === 'string' && candidate.agentCard.length > 0
            ? { agentCard: candidate.agentCard }
            : {}),
        ...(typeof candidate.runtimeManifest === 'string' && candidate.runtimeManifest.length > 0
            ? { runtimeManifest: candidate.runtimeManifest }
            : {}),
    };
}
