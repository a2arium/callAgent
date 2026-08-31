#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { resolveWorkspaceRuntime, WorkspaceResolutionError } from '@a2arium/callagent-core';
import { runtimeEntryPoints } from '@a2arium/callagent-runtime';
import { fileURLToPath } from 'node:url';
import { writeRuntimeDescriptor } from './descriptorFile.js';
import { addAgentSource, createAgent, createAgentProject, createWorkspace, removeAgentSource } from './generate.js';
import { detectLocalSource, localInstall, localSourceStatus, setupLocalSource, syncLocalSource, unlinkLocalSource } from './localSource.js';

type Options = { workspaces?: string; json: boolean; noObserver: boolean; host?: string; port?: string; hostEntry?: string; workerEntry?: string; output?: string; project?: string; withAgent?: string; preset?: 'minimal' | 'non-trivial'; force?: boolean; usesLlm?: boolean; usesTools?: boolean; usesChildren?: boolean; usesPlans?: boolean; agentSources?: string[]; packageManager?: string; name?: string; envFile?: string; localSource?: string; npm?: boolean; compose?: string; arguments: string[] };

async function main(argv: string[]): Promise<void> {
    const { command, options } = parse(argv);
    if (command === 'help') return printHelp();
    if (command.startsWith('local ')) return local(command, options);
    if (command.startsWith('infra ')) return infra(command, options);
    if (command.startsWith('db ')) return database(command, options);
    const sourceRoot = await detectLocalSource(options);
    if (command === 'workspace validate' || command === 'agents list') {
        const { descriptor } = await resolve(options);
        if (sourceRoot) await setupDescriptorOverlay(descriptor, sourceRoot);
        if (command === 'workspace validate') return printValidation(descriptor, options.json);
        return printAgents(descriptor, options.json);
    }
    if (command === 'start' || command === 'dev') return dev(options, sourceRoot);
    if (command.startsWith('create agent ')) {
        const result = await createAgent(requireName(options), options);
        if (sourceRoot) await setupLocalSource(result.project, sourceRoot);
        return printMutation(result, options.json);
    }
    if (command.startsWith('create agent-project ')) {
        const result = await createAgentProject(requireName(options), options);
        if (sourceRoot) {
            await setupLocalSource(result.output, sourceRoot);
            await localInstall(result.output, options.packageManager ?? await preferredLocalPackageManager(sourceRoot));
        }
        return printMutation(result, options.json);
    }
    if (command.startsWith('create workspace ')) {
        const result = await createWorkspace(requireName(options), options);
        if (sourceRoot) {
            await setupLocalSource(result.output, sourceRoot);
            const { descriptor } = await resolveWorkspaceRuntime({ cwd: result.output, allowEmpty: true });
            await setupDescriptorOverlay(descriptor, sourceRoot);
        }
        return printMutation(result, options.json);
    }
    if (command.startsWith('workspace add-agent-source ')) {
        const result = await addAgentSource(requireArgument(options), options);
        if (sourceRoot) {
            const { descriptor } = await resolve(options);
            await setupDescriptorOverlay(descriptor, sourceRoot);
        }
        return printMutation(result, options.json);
    }
    if (command.startsWith('workspace remove-agent-source ')) return printMutation(await removeAgentSource(requireArgument(options), options), options.json);
    throw new Error(`Unknown command: ${command}. Run \`callagent --help\`.`);
}

async function resolve(options: Options) {
    return resolveWorkspaceRuntime({ cwd: process.cwd(), registryPath: options.workspaces });
}

async function setupDescriptorOverlay(descriptor: Awaited<ReturnType<typeof resolveWorkspaceRuntime>>['descriptor'], sourceRoot: string): Promise<void> {
    const roots = new Set<string>([path.dirname(path.dirname(descriptor.registryPath))]);
    for (const workspace of descriptor.workspaces) roots.add(workspace.root);
    for (const root of roots) await setupLocalSource(root, sourceRoot);
}

async function local(command: string, options: Options): Promise<void> {
    const project = path.resolve(options.project ?? process.cwd());
    if (command === 'local setup') {
        const source = await detectLocalSource(options);
        if (!source) throw new Error('No local CallAgent source was detected. Pass --callagent-source <path>.');
        return printMutation(await setupLocalSource(project, source), options.json);
    }
    if (command === 'local sync') return printMutation(await syncLocalSource(project), options.json);
    if (command === 'local status') return printMutation(await localSourceStatus(project), options.json);
    if (command === 'local unlink') { await unlinkLocalSource(project); return printMutation({ project, unlinked: true }, options.json); }
    if (command === 'local install') { await localInstall(project, options.packageManager); return printMutation({ project, installed: true, packageManager: options.packageManager ?? 'npm' }, options.json); }
    throw new Error(`Unknown local command: ${command}`);
}

async function infra(command: string, options: Options): Promise<void> {
    const action = command.slice('infra '.length);
    if (!['up', 'down', 'restart'].includes(action)) throw new Error('Usage: callagent infra <up|down|restart> [--compose FILE]');
    const workspace = await workspaceRoot(options);
    const files = [runtimeComposeFile(), ...(options.compose ? [path.resolve(workspace, options.compose)] : [])];
    for (const file of files) await fsp.access(file);
    const args = ['compose', ...files.flatMap((file) => ['-f', file]), '--project-directory', workspace, '--env-file', path.join(workspace, '.env')];
    console.log(`CallAgent infrastructure: ${action} (${files.join(', ')})`);
    if (action === 'up') args.push('up', '-d');
    if (action === 'down') args.push('down', '--remove-orphans');
    if (action === 'restart') args.push('restart');
    await runCommand('docker', args, workspace, 120_000);
}

async function database(command: string, options: Options): Promise<void> {
    const action = command.slice('db '.length);
    if (!['setup', 'migrate', 'generate'].includes(action)) throw new Error('Usage: callagent db <setup|migrate|generate>');
    const workspace = await workspaceRoot(options);
    const setupScript = path.join(workspace, 'node_modules', '@a2arium', 'callagent-memory-sql', 'scripts', 'setup-database.cjs');
    await fsp.access(setupScript);
    await runCommand(process.execPath, [setupScript, action], workspace);
}

async function workspaceRoot(options: Options): Promise<string> {
    const registryPath = await findWorkspaceRegistry(options.workspaces);
    return path.dirname(path.dirname(registryPath));
}

async function findWorkspaceRegistry(requested?: string): Promise<string> {
    if (requested) return path.resolve(process.cwd(), requested);
    let current = process.cwd();
    while (true) {
        const candidate = path.join(current, '.callagent', 'workspaces.json');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(current);
        if (parent === current) throw new Error('No CallAgent workspace found; pass --workspaces <path>');
        current = parent;
    }
}

function runtimeComposeFile(): string { return path.join(path.dirname(runtimeEntryPoints().host), 'infra', 'docker-compose.yml'); }

function runCommand(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit' });
        let settled = false;
        const finish = (callback: () => void) => { if (!settled) { settled = true; if (timeout) clearTimeout(timeout); callback(); } };
        const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
            child.kill('SIGTERM');
            finish(() => reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1_000)} seconds. Check Docker Desktop / Docker Engine with \`docker info\`.`)));
        }, timeoutMs);
        child.once('error', (error) => finish(() => reject(error)));
        child.once('exit', (code) => finish(() => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`))));
    });
}

async function preferredLocalPackageManager(sourceRoot: string): Promise<string> {
    try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(sourceRoot, 'package.json'), 'utf8')) as { packageManager?: unknown };
        if (typeof manifest.packageManager === 'string' && manifest.packageManager.startsWith('yarn@')) return 'yarn';
    } catch { /* default below */ }
    return 'npm';
}

function printValidation(descriptor: Awaited<ReturnType<typeof resolveWorkspaceRuntime>>['descriptor'], json: boolean): void {
    const result = { schemaVersion: 1, ok: true, fingerprint: descriptor.fingerprint, registryPath: descriptor.registryPath, agents: descriptor.workspaces.flatMap((workspace) => workspace.agents.map((agent) => ({ id: agent.id, workspace: workspace.name }))) };
    if (json) return console.log(JSON.stringify(result));
    console.log(`Workspace is valid: ${result.agents.length} agent(s), fingerprint ${result.fingerprint}`);
    for (const agent of result.agents) console.log(`  ${agent.id} (${agent.workspace})`);
}

function printAgents(descriptor: Awaited<ReturnType<typeof resolveWorkspaceRuntime>>['descriptor'], json: boolean): void {
    const agents = descriptor.workspaces.flatMap((workspace) => workspace.agents.map((agent) => ({ id: agent.id, workspace: workspace.name, modulePath: agent.modulePath, validation: 'valid' })));
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, agents }));
    for (const agent of agents) console.log(`${agent.id}\t${agent.workspace}\t${agent.modulePath}`);
}

async function dev(options: Options, sourceRoot?: string): Promise<void> {
    const { descriptor, environment } = await resolve(options);
    if (sourceRoot) await setupDescriptorOverlay(descriptor, sourceRoot);
    await preflight(environment.values);
    const descriptorFile = await writeRuntimeDescriptor(descriptor);
    const installedEntries = runtimeEntryPoints();
    const hostEntry = options.hostEntry ?? process.env.CALLAGENT_HOST_ENTRY ?? installedEntries.host;
    const workerEntry = options.workerEntry ?? process.env.CALLAGENT_WORKER_ENTRY ?? installedEntries.worker;
    if (!hostEntry || !workerEntry) {
        await descriptorFile.cleanup();
        throw new Error('Runtime entries are not installed yet. Set CALLAGENT_HOST_ENTRY and CALLAGENT_WORKER_ENTRY while migrating the runtime host and Hatchet worker into @a2arium/callagent-runtime.');
    }
    const childEnv = {
        ...environment.values,
        CALLAGENT_WORKSPACE_DESCRIPTOR: descriptorFile.path,
        CALLAGENT_WORKSPACE_FINGERPRINT: descriptor.fingerprint,
        ...(options.host ? { HOST: options.host } : {}),
        ...(options.port ? { PORT: options.port } : {}),
        ...(options.noObserver ? { CALLAGENT_OBSERVER_ENABLED: 'false' } : {}),
        CALLAGENT_STRICT_AGENT_IDS: 'true',
    };
    for (const conflict of environment.conflicts) {
        console.warn(`Environment key ${conflict.key} from ${conflict.ignoredSource} was ignored; keeping ${conflict.keptSource}`);
    }
    const expectedAgents = descriptor.workspaces.flatMap((workspace) => workspace.agents.map((agent) => agent.id)).sort();
    const children = new Map<string, ChildProcess>();
    let stopped = false;
    const stop = async (reason: string, code = 0): Promise<void> => {
        if (!stopped) {
            stopped = true;
            console.log(`Stopping runtime (${reason})...`);
            for (const child of children.values()) child.kill('SIGTERM');
            await Promise.race([Promise.allSettled(Array.from(children.values()).map(waitForExit)), timeout(5_000)]);
            for (const child of children.values()) if (child.exitCode === null) child.kill('SIGKILL');
            await descriptorFile.cleanup();
        }
        process.exitCode = code;
    };
    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));
    try {
        const ready = await Promise.all([
            startChild('host', hostEntry, childEnv, children, expectedAgents, () => void stop('host exited unexpectedly', 1)),
            startChild('worker', workerEntry, childEnv, children, expectedAgents, () => void stop('worker exited unexpectedly', 1)),
        ]);
        if (ready.some((item) => item.fingerprint !== descriptor.fingerprint || !sameIds(item.agentIds, expectedAgents))) {
            throw new Error('Runtime child readiness did not match the resolved workspace descriptor');
        }
        printStartupSummary({
            agentCount: expectedAgents.length,
            fingerprint: descriptor.fingerprint,
            host: childEnv.HOST ?? '127.0.0.1',
            port: Number(childEnv.PORT ?? 8790),
            observerEnabled: childEnv.CALLAGENT_OBSERVER_ENABLED !== 'false',
            hatchetDashboardUrl: environment.values.HATCHET_DASHBOARD_URL,
        });
    } catch (error) {
        await stop(error instanceof Error ? error.message : String(error), 1);
    }
}

export function printStartupSummary(options: {
    agentCount: number;
    fingerprint: string;
    host: string;
    port: number;
    observerEnabled: boolean;
    hatchetDashboardUrl?: string;
}): void {
    const host = displayHost(options.host);
    const runtimeUrl = `http://${host}:${options.port}`;
    console.log(`\nCallAgent workspace is running\n`);
    console.log(`  Runtime API  ${runtimeUrl}`);
    if (options.observerEnabled) console.log(`  Operator     ${runtimeUrl}/operator`);
    else console.log('  Operator     disabled (--no-observer)');
    if (options.hatchetDashboardUrl) console.log(`  Hatchet      ${options.hatchetDashboardUrl}`);
    console.log(`\n  ${options.agentCount} agent(s) ready  ·  ${options.fingerprint.slice(0, 12)}\n`);
    console.log('Press Ctrl-C to stop the runtime.');
}

async function preflight(env: Record<string, string>): Promise<void> {
    const targets = [
        ['NATS', endpointFromUrl(env.NATS_URL ?? 'nats://127.0.0.1:4222', 4222)],
        ['Hatchet gRPC', endpointFromHostPort(env.HATCHET_CLIENT_HOST_PORT ?? '127.0.0.1:7077', 7077)],
        ['Postgres', endpointFromUrl(env.MEMORY_DATABASE_URL ?? 'postgres://127.0.0.1:5432/callagent', 5432)],
    ] as const;
    const results = await Promise.all(targets.map(async ([name, endpoint]) => ({ name, endpoint, ok: await tcpConnect(endpoint.host, endpoint.port) })));
    const failed = results.filter((result) => !result.ok);
    if (failed.length) throw new Error(`Runtime preflight failed: ${failed.map((result) => `${result.name} at ${result.endpoint.host}:${result.endpoint.port}`).join(', ')}. Start infrastructure before callagent start.`);
}

function endpointFromUrl(value: string, defaultPort: number): { host: string; port: number } {
    try { const url = new URL(value); return { host: normalizeHost(url.hostname), port: Number(url.port || defaultPort) }; }
    catch { return endpointFromHostPort(value, defaultPort); }
}
function endpointFromHostPort(value: string, defaultPort: number): { host: string; port: number } {
    const separator = value.lastIndexOf(':');
    return separator === -1 ? { host: normalizeHost(value), port: defaultPort } : { host: normalizeHost(value.slice(0, separator)), port: Number(value.slice(separator + 1) || defaultPort) };
}
function normalizeHost(host: string): string { return host === 'localhost' || host === '0.0.0.0' ? '127.0.0.1' : host; }
function displayHost(host: string): string { return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host; }
function tcpConnect(host: string, port: number): Promise<boolean> { return new Promise((resolve) => { const socket = net.createConnection({ host, port }); const done = (result: boolean) => { socket.destroy(); resolve(result); }; socket.setTimeout(1_500); socket.once('connect', () => done(true)); socket.once('timeout', () => done(false)); socket.once('error', () => done(false)); }); }

function startChild(name: string, entry: string, env: NodeJS.ProcessEnv, children: Map<string, ChildProcess>, expectedAgents: string[], onUnexpectedExit: () => void): Promise<{ fingerprint: string; agentIds: string[] }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve(entry)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.set(name, child);
        let settled = false;
        const fail = (message: string) => { if (!settled) { settled = true; reject(new Error(message)); } };
        child.once('exit', (code, signal) => {
            children.delete(name);
            if (settled) {
                onUnexpectedExit();
                return;
            }
            fail(`${name} exited before readiness (${signal ?? code ?? 'unknown'})`);
        });
        child.stdout?.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString().split(/\r?\n/)) {
                if (!line) continue;
                console.log(`[${name}] ${line}`);
                if (line.startsWith('CALLAGENT_RUNTIME_READY ')) {
                    try {
                        const ready = JSON.parse(line.slice('CALLAGENT_RUNTIME_READY '.length)) as { fingerprint?: unknown; agentIds?: unknown };
                        if (typeof ready.fingerprint !== 'string' || !Array.isArray(ready.agentIds) || !ready.agentIds.every((id) => typeof id === 'string')) return fail(`${name} emitted invalid readiness`);
                        if (!sameIds(ready.agentIds, expectedAgents)) return fail(`${name} registered an unexpected agent set`);
                        if (!settled) { settled = true; resolve({ fingerprint: ready.fingerprint, agentIds: ready.agentIds }); }
                    } catch { fail(`${name} emitted invalid readiness JSON`); }
                }
            }
        });
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${name}] ${chunk}`));
    });
}

function parse(argv: string[]): { command: string; options: Options } {
    const options: Options = { json: false, noObserver: false, arguments: [] };
    const positional: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === '--help' || argument === '-h') return { command: 'help', options };
        if (argument === '--json') { options.json = true; continue; }
        if (argument === '--no-observer') { options.noObserver = true; continue; }
        if (argument === '--force' || argument === '--npm' || argument === '--uses-llm' || argument === '--uses-tools' || argument === '--uses-children' || argument === '--uses-plans') {
            const key = ({ '--force': 'force', '--npm': 'npm', '--uses-llm': 'usesLlm', '--uses-tools': 'usesTools', '--uses-children': 'usesChildren', '--uses-plans': 'usesPlans' } as const)[argument];
            options[key] = true;
            continue;
        }
        if (argument === '--agent-source') { const value = argv[++index]; if (!value) throw new Error('--agent-source requires a value'); (options.agentSources ??= []).push(value); continue; }
        const key = ({ '--workspaces': 'workspaces', '--host': 'host', '--port': 'port', '--host-entry': 'hostEntry', '--worker-entry': 'workerEntry', '--output': 'output', '--project': 'project', '--with-agent': 'withAgent', '--preset': 'preset', '--package-manager': 'packageManager', '--name': 'name', '--env-file': 'envFile', '--callagent-source': 'localSource', '--compose': 'compose' } as const)[argument];
        if (key) {
            const value = argv[++index];
            if (!value) throw new Error(`${argument} requires a value`);
            if (key === 'preset') {
                if (value !== 'minimal' && value !== 'non-trivial') throw new Error('--preset must be minimal or non-trivial');
                options.preset = value;
            } else {
                options[key] = value;
            }
            continue;
        }
        positional.push(argument); options.arguments.push(argument);
    }
    const command = positional.join(' ');
    return { command: command || 'help', options };
}

function localCliPath(): string | undefined {
    if (process.env.CALLAGENT_LOCAL_CLI_REEXEC === '1') return undefined;
    let current = process.cwd();
    while (true) {
        const candidate = path.join(current, 'node_modules', '@a2arium', 'callagent-cli', 'dist', 'cli.js');
        if (fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(process.argv[1] ?? '')) return candidate;
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

function sameIds(actual: string[], expected: string[]): boolean { return actual.slice().sort().join('\0') === expected.slice().sort().join('\0'); }
function timeout(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitForExit(child: ChildProcess): Promise<void> { return new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', () => resolve())); }
function requireName(options: Options): string { const name = options.arguments.at(-1); if (!name) throw new Error('A name is required'); return name; }
function requireArgument(options: Options): string { const value = options.arguments.at(-1); if (!value) throw new Error('A path or agent-source name is required'); return value; }
function printMutation(value: unknown, json: boolean): void { if (json) console.log(JSON.stringify({ schemaVersion: 1, ...asRecord(value) })); else console.log(JSON.stringify(value, null, 2)); }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : { result: value }; }
function printHelp(): void { console.log(`Usage: callagent <command> [options]\n\nCommands:\n  start [--workspaces PATH] [--no-observer]\n  dev (compatibility alias for start)\n  db setup|migrate|generate\n  infra up|down|restart [--compose FILE]\n  workspace validate [--json]\n  workspace add-agent-source <path>\n  workspace remove-agent-source <name>\n  agents list [--json]\n  create agent <name>\n  create agent-project <name>\n  create workspace <name>\n  local setup|sync|status|unlink|install\n\nLocal source options:\n  --callagent-source <path>  use a built CallAgent checkout\n  --npm                       disable local-source detection\n  --package-manager npm|yarn package manager for local install`); }

const localCli = localCliPath();
if (localCli) {
    const child = spawn(process.execPath, [localCli, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, CALLAGENT_LOCAL_CLI_REEXEC: '1' },
    });
    child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
} else main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof WorkspaceResolutionError) {
        for (const issue of error.issues) console.error(`${issue.path ?? 'workspace'}: ${issue.message}`);
    } else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
