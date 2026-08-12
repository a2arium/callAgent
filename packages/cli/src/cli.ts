#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { resolveWorkspaceRuntime, WorkspaceResolutionError } from '@a2arium/callagent-core';
import { runtimeEntryPoints } from '@a2arium/callagent-runtime';
import { writeRuntimeDescriptor } from './descriptorFile.js';
import { addAgentSource, createAgent, createAgentProject, createWorkspace, removeAgentSource } from './generate.js';

type Options = { workspaces?: string; json: boolean; noObserver: boolean; host?: string; port?: string; hostEntry?: string; workerEntry?: string; output?: string; project?: string; withAgent?: string; preset?: 'minimal' | 'non-trivial'; force?: boolean; monorepo?: boolean; usesLlm?: boolean; usesTools?: boolean; usesChildren?: boolean; usesPlans?: boolean; agentSources?: string[]; packageManager?: string; name?: string; envFile?: string; arguments: string[] };

async function main(argv: string[]): Promise<void> {
    const { command, options } = parse(argv);
    if (command === 'help') return printHelp();
    if (command === 'workspace validate' || command === 'agents list') {
        const { descriptor } = await resolve(options);
        if (command === 'workspace validate') return printValidation(descriptor, options.json);
        return printAgents(descriptor, options.json);
    }
    if (command === 'dev') return dev(options);
    if (command.startsWith('create agent ')) return printMutation(await createAgent(requireName(options), options), options.json);
    if (command.startsWith('create agent-project ')) return printMutation(await createAgentProject(requireName(options), options), options.json);
    if (command.startsWith('create workspace ')) return printMutation(await createWorkspace(requireName(options), options), options.json);
    if (command.startsWith('workspace add-agent-source ')) return printMutation(await addAgentSource(requireArgument(options), options), options.json);
    if (command.startsWith('workspace remove-agent-source ')) return printMutation(await removeAgentSource(requireArgument(options), options), options.json);
    throw new Error(`Unknown command: ${command}. Run \`callagent --help\`.`);
}

async function resolve(options: Options) {
    return resolveWorkspaceRuntime({ cwd: process.cwd(), registryPath: options.workspaces });
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

async function dev(options: Options): Promise<void> {
    const { descriptor, environment } = await resolve(options);
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
    };
    const expectedAgents = descriptor.workspaces.flatMap((workspace) => workspace.agents.map((agent) => agent.id)).sort();
    const children = new Map<string, ChildProcess>();
    let stopped = false;
    const stop = async (reason: string, code = 0): Promise<never> => {
        if (!stopped) {
            stopped = true;
            console.log(`Stopping runtime (${reason})...`);
            for (const child of children.values()) child.kill('SIGTERM');
            await Promise.race([Promise.allSettled(Array.from(children.values()).map(waitForExit)), timeout(5_000)]);
            for (const child of children.values()) if (child.exitCode === null) child.kill('SIGKILL');
            await descriptorFile.cleanup();
        }
        process.exit(code);
    };
    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));
    try {
        const ready = await Promise.all([
            startChild('host', hostEntry, childEnv, children, expectedAgents),
            startChild('worker', workerEntry, childEnv, children, expectedAgents),
        ]);
        if (ready.some((item) => item.fingerprint !== descriptor.fingerprint || !sameIds(item.agentIds, expectedAgents))) {
            throw new Error('Runtime child readiness did not match the resolved workspace descriptor');
        }
        console.log(`Runtime started (${expectedAgents.length} agent(s), fingerprint ${descriptor.fingerprint})`);
    } catch (error) {
        await stop(error instanceof Error ? error.message : String(error), 1);
    }
}

function startChild(name: string, entry: string, env: NodeJS.ProcessEnv, children: Map<string, ChildProcess>, expectedAgents: string[]): Promise<{ fingerprint: string; agentIds: string[] }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve(entry)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.set(name, child);
        let settled = false;
        const fail = (message: string) => { if (!settled) { settled = true; reject(new Error(message)); } };
        child.once('exit', (code, signal) => fail(`${name} exited before readiness (${signal ?? code ?? 'unknown'})`));
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
        if (argument === '--force' || argument === '--monorepo' || argument === '--uses-llm' || argument === '--uses-tools' || argument === '--uses-children' || argument === '--uses-plans') {
            const key = ({ '--force': 'force', '--monorepo': 'monorepo', '--uses-llm': 'usesLlm', '--uses-tools': 'usesTools', '--uses-children': 'usesChildren', '--uses-plans': 'usesPlans' } as const)[argument];
            options[key] = true;
            continue;
        }
        if (argument === '--agent-source') { const value = argv[++index]; if (!value) throw new Error('--agent-source requires a value'); (options.agentSources ??= []).push(value); continue; }
        const key = ({ '--workspaces': 'workspaces', '--host': 'host', '--port': 'port', '--host-entry': 'hostEntry', '--worker-entry': 'workerEntry', '--output': 'output', '--project': 'project', '--with-agent': 'withAgent', '--preset': 'preset', '--package-manager': 'packageManager', '--name': 'name', '--env-file': 'envFile' } as const)[argument];
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

function sameIds(actual: string[], expected: string[]): boolean { return actual.slice().sort().join('\0') === expected.slice().sort().join('\0'); }
function timeout(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitForExit(child: ChildProcess): Promise<void> { return new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', () => resolve())); }
function requireName(options: Options): string { const name = options.arguments.at(-1); if (!name) throw new Error('A name is required'); return name; }
function requireArgument(options: Options): string { const value = options.arguments.at(-1); if (!value) throw new Error('A path or agent-source name is required'); return value; }
function printMutation(value: unknown, json: boolean): void { if (json) console.log(JSON.stringify({ schemaVersion: 1, ...asRecord(value) })); else console.log(JSON.stringify(value, null, 2)); }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : { result: value }; }
function printHelp(): void { console.log(`Usage: callagent <command> [options]\n\nCommands:\n  dev\n  workspace validate [--json]\n  workspace add-agent-source <path>\n  workspace remove-agent-source <name>\n  agents list [--json]\n  create agent <name>\n  create agent-project <name>\n  create workspace <name>`); }

main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof WorkspaceResolutionError) {
        for (const issue of error.issues) console.error(`${issue.path ?? 'workspace'}: ${issue.message}`);
    } else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
