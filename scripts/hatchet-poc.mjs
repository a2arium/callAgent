#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMPOSE_PREFIX = [
  'compose',
  '-f',
  'apps/hatchet-poc/docker-compose.yml',
  '--env-file',
  '.env',
];

function positiveInteger(name, value, fallback) {
  const raw = value ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function readHatchetPocTimeouts(env = process.env) {
  return {
    upTimeoutMs: positiveInteger(
      'HATCHET_POC_UP_TIMEOUT_SECONDS',
      env.HATCHET_POC_UP_TIMEOUT_SECONDS,
      120
    ) * 1_000,
    downTimeoutMs: positiveInteger(
      'HATCHET_POC_DOWN_TIMEOUT_SECONDS',
      env.HATCHET_POC_DOWN_TIMEOUT_SECONDS,
      30
    ) * 1_000,
    stopGraceSeconds: positiveInteger(
      'HATCHET_POC_STOP_GRACE_SECONDS',
      env.HATCHET_POC_STOP_GRACE_SECONDS,
      10
    ),
    hardTimeoutMs: positiveInteger(
      'HATCHET_POC_HARD_TIMEOUT_SECONDS',
      env.HATCHET_POC_HARD_TIMEOUT_SECONDS,
      15
    ) * 1_000,
  };
}

function signalProcess(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function runDockerCompose(
  composeArgs,
  {
    timeoutMs,
    label,
    spawnImpl = spawn,
    logger = console,
  }
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      'docker',
      [...COMPOSE_PREFIX, ...composeArgs],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        detached: process.platform !== 'win32',
        stdio: 'inherit',
      }
    );
    let settled = false;
    let timedOut = false;
    let forceTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceTimer);
      resolve(result);
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      finish({ code: code ?? 1, signal, timedOut });
    });

    const deadline = setTimeout(() => {
      timedOut = true;
      logger.error(`[hatchet:poc] ${label} timed out after ${timeoutMs / 1_000}s; terminating Docker Compose.`);
      signalProcess(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        logger.error(`[hatchet:poc] ${label} did not terminate; sending SIGKILL.`);
        signalProcess(child, 'SIGKILL');
      }, 2_000);
    }, timeoutMs);
  });
}

function failed(result) {
  return result.timedOut || result.code !== 0;
}

async function stopHatchetPoc({ invoke, logger, timeouts }) {
  logger.info(`[hatchet:poc] stopping gracefully (${timeouts.stopGraceSeconds}s container grace period)`);
  const graceful = await invoke(
    ['down', '--timeout', String(timeouts.stopGraceSeconds), '--remove-orphans'],
    { timeoutMs: timeouts.downTimeoutMs, label: 'graceful shutdown' }
  );
  if (!failed(graceful)) {
    logger.info('[hatchet:poc] stopped');
    return;
  }
  if (!graceful.timedOut) {
    throw new Error(`[hatchet:poc] graceful shutdown failed with exit code ${graceful.code}`);
  }

  logger.error('[hatchet:poc] graceful shutdown deadline expired; forcing container termination');
  const killResult = await invoke(
    ['kill', '--signal', 'SIGKILL'],
    { timeoutMs: timeouts.hardTimeoutMs, label: 'forced container kill' }
  );
  const cleanupResult = await invoke(
    ['down', '--timeout', '0', '--remove-orphans'],
    { timeoutMs: timeouts.hardTimeoutMs, label: 'forced shutdown cleanup' }
  );
  if (failed(cleanupResult)) {
    const killDetail = killResult.timedOut ? 'timed out' : `exit ${killResult.code}`;
    const cleanupDetail = cleanupResult.timedOut ? 'timed out' : `exit ${cleanupResult.code}`;
    throw new Error(
      `[hatchet:poc] forced shutdown failed (kill: ${killDetail}; cleanup: ${cleanupDetail}). ` +
      'Docker Engine may be unavailable.'
    );
  }
  logger.info('[hatchet:poc] stopped after forced cleanup');
}

async function startHatchetPoc({ invoke, logger, timeouts }) {
  logger.info(`[hatchet:poc] starting (deadline ${timeouts.upTimeoutMs / 1_000}s)`);
  const result = await invoke(
    ['up', '-d'],
    { timeoutMs: timeouts.upTimeoutMs, label: 'startup' }
  );
  if (failed(result)) {
    const detail = result.timedOut ? 'timed out' : `failed with exit code ${result.code}`;
    throw new Error(
      `[hatchet:poc] startup ${detail}. Check Docker Engine health with ` +
      '`docker info`; Docker commands cannot recover an unresponsive daemon.'
    );
  }
  logger.info('[hatchet:poc] started');
}

export async function runHatchetPoc(
  command,
  {
    env = process.env,
    logger = console,
    invoke = (args, options) => runDockerCompose(args, { ...options, logger }),
  } = {}
) {
  const timeouts = readHatchetPocTimeouts(env);
  if (command === 'up') {
    await startHatchetPoc({ invoke, logger, timeouts });
    return;
  }
  if (command === 'down') {
    await stopHatchetPoc({ invoke, logger, timeouts });
    return;
  }
  if (command === 'restart') {
    await stopHatchetPoc({ invoke, logger, timeouts });
    await startHatchetPoc({ invoke, logger, timeouts });
    return;
  }
  throw new Error(`Usage: node scripts/hatchet-poc.mjs <up|down|restart>`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  runHatchetPoc(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
