#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { buildRuntimeEnvironment, resolveRuntimeWorkspacePath } from './runtime-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const invocationCwd = process.cwd();
loadDotenv({ path: path.join(invocationCwd, '.env') });
if (invocationCwd !== repoRoot) {
    loadDotenv({ path: path.join(repoRoot, '.env') });
}

const argv = process.argv.slice(2);
const args = new Set(argv);
const prodMode = args.has('--prod');
const noDashboard = args.has('--no-dashboard');
const help = args.has('--help') || args.has('-h');
const workspacesArg = optionValue(argv, '--workspaces');

if (help) {
    printHelp();
    process.exit(0);
}

const env = buildRuntimeEnvironment(
    process.env,
    resolveRuntimePath(workspacesArg ?? process.env.CALLAGENT_WORKSPACES ?? '.callagent/workspaces.json'),
);

const children = new Map();
let shuttingDown = false;

try {
    await preflight(env);
    if (prodMode && !noDashboard) {
        await runBlocking('build:dashboard', ['workspace', '@a2arium/operator-viewer', 'build'], env);
    }

    startChild('worker', ['workspace', '@a2arium/hatchet-worker', 'dev'], env);
    startChild('host', ['workspace', '@a2arium/runtime-host', 'dev'], env);
    if (!noDashboard && !prodMode) {
        startChild('dash', ['workspace', '@a2arium/operator-viewer', 'dev', '--host', '127.0.0.1'], env);
    }

    console.log('');
    console.log('Runtime started');
    console.log('RPC:       http://127.0.0.1:8790/rpc');
    if (!noDashboard) {
        console.log(`Dashboard: ${prodMode ? 'http://127.0.0.1:8790/operator' : 'http://127.0.0.1:8791/operator'}`);
    }
    console.log('Press Ctrl-C to stop all runtime processes.');
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

function printHelp() {
    console.log(`Usage: yarn runtime [--prod] [--no-dashboard] [--workspaces <path>]

Runs the local callagent runtime apps:
  worker        Hatchet runtime worker
  host          Runtime host on http://127.0.0.1:8790
  dashboard     Vite dev server on http://127.0.0.1:8791 by default

Options:
  --prod          Build operator-viewer first and serve it from runtime-host at /operator
  --no-dashboard  Run worker and host only
  --workspaces     Workspace registry, resolved relative to the invoking workspace

Infra is not started by this command. Start Hatchet/NATS first with:
  yarn hatchet:poc:up
`);
}

async function preflight(runtimeEnv) {
    const checks = [
        serviceCheck('NATS', hostPortFromUrl(runtimeEnv.NATS_URL ?? 'nats://127.0.0.1:4222', 4222)),
        serviceCheck('Hatchet gRPC', hostPortFromHostPort(runtimeEnv.HATCHET_CLIENT_HOST_PORT ?? '127.0.0.1:7077')),
        serviceCheck('Postgres', hostPortFromUrl(runtimeEnv.MEMORY_DATABASE_URL ?? 'postgres://localhost:5432/callagent', 5432)),
    ];

    const results = await Promise.all(checks);
    const failures = results.filter((result) => !result.ok);
    if (failures.length === 0) return;

    console.error('Runtime preflight failed:');
    for (const failure of failures) {
        console.error(`  - ${failure.name}: cannot connect to ${failure.host}:${failure.port}`);
    }
    throw new Error('Start infra first with `yarn hatchet:poc:up` and ensure Postgres is running.');
}

function serviceCheck(name, endpoint) {
    return checkTcp(endpoint.host, endpoint.port).then((ok) => ({
        name,
        host: endpoint.host,
        port: endpoint.port,
        ok,
    }));
}

function hostPortFromUrl(value, defaultPort) {
    try {
        const url = new URL(value);
        return {
            host: normalizeHost(url.hostname || '127.0.0.1'),
            port: Number(url.port || defaultPort),
        };
    } catch {
        return hostPortFromHostPort(value, defaultPort);
    }
}

function hostPortFromHostPort(value, defaultPort = 7077) {
    const [hostPart, portPart] = value.split(':');
    return {
        host: normalizeHost(hostPart || '127.0.0.1'),
        port: Number(portPart || defaultPort),
    };
}

function normalizeHost(host) {
    if (host === 'localhost' || host === '0.0.0.0') return '127.0.0.1';
    return host;
}

function resolveRuntimePath(value) {
    return resolveRuntimeWorkspacePath(value, invocationCwd);
}

function optionValue(values, option) {
    const index = values.indexOf(option);
    if (index === -1) return undefined;
    const value = values[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${option} requires a path`);
    }
    return value;
}

function checkTcp(host, port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const done = (ok) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(1500);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

function startChild(name, yarnArgs, runtimeEnv) {
    const child = spawn('yarn', yarnArgs, {
        cwd: repoRoot,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(name, child);

    child.stdout.on('data', (chunk) => writePrefixed(name, chunk, false));
    child.stderr.on('data', (chunk) => writePrefixed(name, chunk, true));
    child.once('exit', (code, signal) => {
        children.delete(name);
        if (shuttingDown) return;
        const reason = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
        console.error(`[${name}] stopped unexpectedly (${reason}); stopping runtime`);
        void shutdown('child-exit').then(() => {
            process.exit(code ?? 1);
        });
    });
}

function runBlocking(name, yarnArgs, runtimeEnv) {
    return new Promise((resolve, reject) => {
        const child = spawn('yarn', yarnArgs, {
            cwd: repoRoot,
            env: runtimeEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk) => writePrefixed(name, chunk, false));
        child.stderr.on('data', (chunk) => writePrefixed(name, chunk, true));
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            const reason = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
            reject(new Error(`[${name}] failed (${reason})`));
        });
    });
}

function writePrefixed(name, chunk, isError) {
    const stream = isError ? process.stderr : process.stdout;
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        stream.write(`[${name}] ${line}\n`);
    }
}

async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Stopping runtime (${reason})...`);

    const exits = [];
    for (const child of children.values()) {
        exits.push(waitForExit(child));
        child.kill('SIGTERM');
    }

    await Promise.race([
        Promise.allSettled(exits),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    for (const child of children.values()) {
        if (!child.killed) {
            child.kill('SIGKILL');
        }
    }
}

function waitForExit(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        child.once('exit', () => resolve());
    });
}
