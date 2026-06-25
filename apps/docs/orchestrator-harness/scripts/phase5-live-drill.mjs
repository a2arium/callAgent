#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8790';
const FIXTURE_URL = 'https://update-fixtures.staticdomains.app/pages/listing/static.html';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const [key, inlineValue] = arg.slice(2).split('=');
  if (inlineValue !== undefined) {
    args.set(key, inlineValue);
  } else {
    args.set(key, process.argv[i + 1]);
    i += 1;
  }
}

const baseUrl = args.get('base-url') ?? DEFAULT_BASE_URL;
const tenantId = args.get('tenant') ?? 'default';
const agentId = args.get('agent') ?? 'fetch-page-router';
const count = Number.parseInt(args.get('count') ?? '8', 10);
const prefix = args.get('prefix') ?? `phase5-live-${Date.now()}`;
const pollMs = Number.parseInt(args.get('poll-ms') ?? '2000', 10);
const maxPolls = Number.parseInt(args.get('max-polls') ?? '90', 10);
const waitForActive = args.get('wait-for-active') !== 'false';
const interruptHatchet = args.get('interrupt-hatchet') === 'true';
const interruptService = args.get('interrupt-service') ?? (interruptHatchet ? 'hatchet-engine' : undefined);
const interruptSleepMs = Number.parseInt(args.get('interrupt-sleep-ms') ?? '8000', 10);
const interruptPostgresConnections = args.get('interrupt-postgres-connections') === 'true';
const postgresUrl = args.get('postgres-url') ?? process.env.MEMORY_DATABASE_URL ?? readDotEnvValue('MEMORY_DATABASE_URL');
const cancelRoots = args.get('cancel-roots') === 'true';
const cancelReason = args.get('cancel-reason') ?? 'phase5 cancellation drill';

if (!Number.isFinite(count) || count <= 0) {
  throw new Error('--count must be a positive integer');
}

const payload = {
  cacheBypass: true,
  pageType: 'listing',
  url: FIXTURE_URL,
  siteConfig: {
    site_id: 'fixtures.fetch-web.listing-static',
    defaults: { fetch_mode: 'static_html' },
    pages: {
      listing: {
        access: { mode: 'url' },
        items: { mode: 'url' },
        pagination: { strategy: 'none' },
        urls: [FIXTURE_URL],
      },
      detail: {
        extract: {
          address: { mode: 'in_dom' },
          schema: { mode: 'in_dom' },
        },
      },
    },
  },
};

const taskIds = Array.from({ length: count }, (_, index) =>
  `${prefix}-${String(index + 1).padStart(2, '0')}`
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerComposeService(service, action) {
  execFileSync('docker', [
    'compose',
    '-f',
    'apps/hatchet-poc/docker-compose.yml',
    '--env-file',
    '.env',
    action,
    ...(action === 'up' ? ['-d'] : []),
    service,
  ], { stdio: 'inherit' });
}

function readDotEnvValue(name) {
  let text;
  try {
    text = readFileSync('.env', 'utf8');
  } catch {
    return undefined;
  }
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (line === undefined) {
    return undefined;
  }
  const raw = line.slice(name.length + 1).trim();
  return raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function interruptPostgres() {
  if (postgresUrl === undefined || postgresUrl.trim().length === 0) {
    throw new Error('Postgres interruption requires MEMORY_DATABASE_URL or --postgres-url');
  }
  const connection = postgresConnection(postgresUrl);
  const sql = `
    select count(*)
    from (
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and usename = current_user
    ) terminated;
  `;
  const output = execFileSync('psql', [...connection.args, '-At', '-c', sql], {
    encoding: 'utf8',
    env: connection.env,
  }).trim();
  return Number.parseInt(output, 10);
}

function postgresConnection(urlString) {
  const url = new URL(urlString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (url.hostname.length === 0 || url.username.length === 0 || database.length === 0) {
    throw new Error('Postgres interruption requires a complete MEMORY_DATABASE_URL');
  }
  return {
    args: [
      '-h', url.hostname,
      '-p', url.port || '5432',
      '-U', decodeURIComponent(url.username),
      '-d', database,
    ],
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(url.password),
      ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
    },
  };
}

async function postJson(url, body) {
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'x-callagent-operator-launch': 'true',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, ok: response.ok, json, ms: performance.now() - started };
}

async function getJson(path) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-tenant-id': tenantId },
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, ok: response.ok, json, ms: performance.now() - started };
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value ?? 'missing'] = (counts[value ?? 'missing'] ?? 0) + 1;
  }
  return counts;
}

function graphSummary(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const turns = Array.isArray(graph?.turns) ? graph.turns : [];
  const root = graph?.root ?? nodes.find((node) => node.scope === 'root') ?? nodes[0];
  const childNodes = nodes.filter((node) => node.scope === 'child' || node.taskId !== root?.taskId);
  const duplicateChildParents = [];
  const edgeTokensByParent = new Map();
  for (const edge of edges) {
    const key = `${edge.parentTaskId ?? ''}:${edge.token ?? ''}`;
    const current = edgeTokensByParent.get(key) ?? [];
    current.push(edge.childTaskId);
    edgeTokensByParent.set(key, current);
  }
  for (const [key, childTaskIds] of edgeTokensByParent.entries()) {
    const unique = [...new Set(childTaskIds)];
    if (unique.length > 1) {
      duplicateChildParents.push({ key, childTaskIds: unique });
    }
  }

  return {
    rootStatus: root?.status ?? 'missing',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    turnCount: turns.length,
    nodeStatuses: countBy(nodes.map((node) => node.status)),
    edgeStatuses: countBy(edges.map((edge) => edge.status)),
    childStatuses: countBy(childNodes.map((node) => node.status)),
    childTaskIds: childNodes.map((node) => node.taskId),
    duplicateChildParents,
  };
}

function isTerminal(status) {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

async function launchTasks() {
  const launches = [];
  for (const taskId of taskIds) {
    launches.push(postJson(`${baseUrl}/rpc`, {
      jsonrpc: '2.0',
      id: `phase5-${taskId}`,
      method: 'tasks/send',
      params: {
        id: taskId,
        agentId,
        ...payload,
      },
    }));
  }
  return Promise.all(launches);
}

async function cancelTasks() {
  return Promise.all(taskIds.map((taskId) =>
    postJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/cancel`, {
      reason: cancelReason,
    })
  ));
}

async function pollGraphs({ stopWhenActive = false, requireGraphIdle = false } = {}) {
  const timings = [];
  let last = [];
  for (let tick = 0; tick < maxPolls; tick += 1) {
    const graphs = await Promise.all(taskIds.map(async (taskId) => {
      const result = await getJson(`/tasks/${encodeURIComponent(taskId)}/run-graph`);
      timings.push(result.ms);
      return {
        taskId,
        status: result.status,
        ok: result.ok,
        graph: result.json,
        summary: graphSummary(result.json),
      };
    }));
    last = graphs;
    const rootStatuses = countBy(graphs.map((item) => item.summary.rootStatus));
    const edgeStatuses = countBy(graphs.flatMap((item) => Object.entries(item.summary.edgeStatuses).flatMap(([status, amount]) =>
      Array.from({ length: amount }, () => status)
    )));
    const hasActiveChildEdges = graphs.some((item) =>
      (item.summary.edgeStatuses.running ?? 0) > 0 ||
      (item.summary.rootStatus === 'waiting')
    );
    const hasActiveChildNodes = graphs.some((item) =>
      (item.summary.childStatuses.running ?? 0) > 0 ||
      (item.summary.childStatuses.waiting ?? 0) > 0 ||
      (item.summary.childStatuses.queued ?? 0) > 0
    );
    const graphIdle = !hasActiveChildEdges && !hasActiveChildNodes;
    const allTerminal = graphs.every((item) => isTerminal(item.summary.rootStatus));
    console.log(JSON.stringify({ tick, rootStatuses, edgeStatuses, hasActiveChildEdges, hasActiveChildNodes }));
    if (stopWhenActive && hasActiveChildEdges) {
      return { tick, graphs, timings };
    }
    if (!stopWhenActive && allTerminal && (!requireGraphIdle || graphIdle)) {
      return { tick, graphs, timings };
    }
    await sleep(pollMs);
  }
  return { tick: null, graphs: last, timings };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(1));
}

function finalReport(label, launchResults, activePoll, finalPoll) {
  const final = finalPoll.graphs;
  const duplicates = final
    .map((item) => ({ taskId: item.taskId, duplicates: item.summary.duplicateChildParents }))
    .filter((item) => item.duplicates.length > 0);
  const timings = [...(activePoll?.timings ?? []), ...finalPoll.timings];
  return {
    label,
    prefix,
    count,
    launchHttp: countBy(launchResults.map((result) => String(result.status))),
    launchErrors: launchResults.filter((result) => !result.ok || result.json?.error).length,
    activeTick: activePoll?.tick ?? null,
    terminalTick: finalPoll.tick,
    finalRoots: countBy(final.map((item) => item.summary.rootStatus)),
    finalEdgeStatuses: countBy(final.flatMap((item) => Object.entries(item.summary.edgeStatuses).flatMap(([status, amount]) =>
      Array.from({ length: amount }, () => status)
    ))),
    childStatuses: countBy(final.flatMap((item) => Object.entries(item.summary.childStatuses).flatMap(([status, amount]) =>
      Array.from({ length: amount }, () => status)
    ))),
    finalNodeCounts: final.map((item) => item.summary.nodeCount),
    finalEdgeCounts: final.map((item) => item.summary.edgeCount),
    finalTurnCounts: final.map((item) => item.summary.turnCount),
    duplicateChildEdges: duplicates,
    graphPollTiming: {
      count: timings.length,
      p50Ms: percentile(timings, 50),
      p95Ms: percentile(timings, 95),
      maxMs: Number((timings.length === 0 ? 0 : Math.max(...timings)).toFixed(1)),
    },
  };
}

console.log(JSON.stringify({ phase: 'launch', prefix, count, agentId }));
const launchResults = await launchTasks();
const activePoll = waitForActive ? await pollGraphs({ stopWhenActive: true }) : undefined;
console.log(JSON.stringify({ phase: 'ready-for-interruption', prefix, activeTick: activePoll?.tick ?? null }));
let cancelResults;
if (cancelRoots) {
  console.log(JSON.stringify({ phase: 'cancel-roots', prefix, reason: cancelReason }));
  cancelResults = await cancelTasks();
  console.log(JSON.stringify({
    phase: 'cancel-roots-result',
    prefix,
    cancelHttp: countBy(cancelResults.map((result) => String(result.status))),
    cancelErrors: cancelResults.filter((result) => !result.ok || result.json?.error).length,
  }));
}
let postgresTerminatedConnections;
if (interruptPostgresConnections) {
  console.log(JSON.stringify({ phase: 'interrupt-postgres-connections', prefix }));
  postgresTerminatedConnections = interruptPostgres();
  console.log(JSON.stringify({
    phase: 'interrupt-postgres-connections-result',
    prefix,
    terminatedConnections: postgresTerminatedConnections,
  }));
}
if (interruptService !== undefined) {
  console.log(JSON.stringify({ phase: 'interrupt-service-stop', prefix, service: interruptService }));
  dockerComposeService(interruptService, 'stop');
  await sleep(interruptSleepMs);
  console.log(JSON.stringify({ phase: 'interrupt-service-start', prefix, service: interruptService }));
  dockerComposeService(interruptService, 'up');
}
const finalPoll = await pollGraphs({ requireGraphIdle: cancelRoots });
console.log(JSON.stringify({
  ...finalReport('phase5-live-drill', launchResults, activePoll, finalPoll),
  ...(cancelResults
    ? {
        cancelHttp: countBy(cancelResults.map((result) => String(result.status))),
        cancelErrors: cancelResults.filter((result) => !result.ok || result.json?.error).length,
      }
    : {}),
  ...(postgresTerminatedConnections !== undefined
    ? { postgresTerminatedConnections }
    : {}),
}, null, 2));
