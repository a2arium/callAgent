import { describe, expect, it } from 'vitest';
import { deriveGraphInsights, deriveStatus, normalizeRuntimeStatus } from './derive';
import { semanticFailureFromTurns } from './semanticFailure';
import type { AgentRunGraph } from '../types';

describe('deriveGraphInsights', () => {
  it('selects the deepest failed node and failure path', () => {
    const graph = graphFixture();
    const insights = deriveGraphInsights(graph);

    expect(insights.deepestFailedNodeId).toBe('leaf');
    expect(insights.failurePathNodeIds).toEqual(['root-task', 'child-task', 'leaf-task']);
    expect(insights.failurePathEdgeIds).toEqual(['e1', 'e2']);
    expect(insights.selectedNodeId).toBe('leaf');
  });
});

describe('deriveStatus', () => {
  it('preserves waiting statuses from semantic operator projections', () => {
    expect(normalizeRuntimeStatus('waiting')).toBe('waiting');
    expect(deriveStatus({ status: 'waiting' }).status).toBe('waiting');
  });

  it('derives waiting and stuck from await boundary turns', () => {
    const waiting = deriveStatus({
      status: 'running',
      updatedAt: '2026-06-19T10:00:00.000Z',
      turns: [
        {
          id: 't1',
          rootTaskId: 'root-task',
          taskId: 'root-task',
          status: 'running',
          operation: 'turn.segment',
          boundaryKind: 'await_child',
        },
      ],
      now: new Date('2026-06-19T10:05:00.000Z'),
    });
    const stuck = deriveStatus({
      status: 'running',
      updatedAt: '2026-06-19T10:00:00.000Z',
      turns: [
        {
          id: 't1',
          rootTaskId: 'root-task',
          taskId: 'root-task',
          status: 'running',
          operation: 'turn.segment',
          boundaryKind: 'await_child',
        },
      ],
      now: new Date('2026-06-19T10:20:00.000Z'),
    });

    expect(waiting.status).toBe('waiting');
    expect(waiting.derived).toBe(true);
    expect(stuck.status).toBe('stuck');
    expect(stuck.derived).toBe(true);
  });

  it('derives waiting from transition kind when boundaryKind is missing', () => {
    const waiting = deriveStatus({
      status: 'running',
      updatedAt: '2026-06-19T10:00:00.000Z',
      turns: [
        {
          id: 't1',
          rootTaskId: 'root-task',
          taskId: 'root-task',
          status: 'running',
          operation: 'turn.segment',
          cognition: {
            transition: { kind: 'await_child' },
          },
        },
      ],
      now: new Date('2026-06-19T10:05:00.000Z'),
    });

    expect(waiting.status).toBe('waiting');
    expect(waiting.awaitType).toBe('await_child');
  });

  it('does not let an older await boundary mask a newer running turn', () => {
    const status = deriveStatus({
      status: 'running',
      updatedAt: '2026-06-19T10:10:00.000Z',
      turns: [
        {
          id: 't1',
          rootTaskId: 'root-task',
          taskId: 'root-task',
          status: 'completed',
          operation: 'turn.segment',
          turnSeq: 1,
          boundaryKind: 'await_child',
        },
        {
          id: 't2',
          rootTaskId: 'root-task',
          taskId: 'root-task',
          status: 'running',
          operation: 'turn.segment',
          turnSeq: 2,
        },
      ],
      now: new Date('2026-06-19T10:11:00.000Z'),
    });

    expect(status.status).toBe('running');
    expect(status.derived).toBe(false);
  });
});

describe('semanticFailureFromTurns', () => {
  it('extracts readable transition failure details', () => {
    const failure = semanticFailureFromTurns([
      {
        id: 't1',
        rootTaskId: 'root-task',
        taskId: 'root-task',
        status: 'failed',
        operation: 'turn.segment',
        cognition: {
          transition: {
            kind: 'complete',
            result: {
              ok: false,
              error: {
                code: 'NO_HTML',
                message: 'Agent reached a state where it has no HTML and no URL to fetch.',
              },
            },
          },
        },
      },
    ]);

    expect(failure).toEqual({
      code: 'NO_HTML',
      message: 'Agent reached a state where it has no HTML and no URL to fetch.',
    });
  });
});

function graphFixture(): AgentRunGraph {
  return {
    schemaVersion: 1,
    tenantId: 'default',
    taskId: 'root-task',
    root: {
      id: 'root',
      kind: 'agent',
      tenantId: 'default',
      rootTaskId: 'root-task',
      taskId: 'root-task',
      agentId: 'root-agent',
      status: 'failed',
    },
    nodes: [
      {
        id: 'root',
        kind: 'agent',
        tenantId: 'default',
        rootTaskId: 'root-task',
        taskId: 'root-task',
        agentId: 'root-agent',
        status: 'failed',
      },
      {
        id: 'child',
        kind: 'agent',
        tenantId: 'default',
        rootTaskId: 'root-task',
        taskId: 'child-task',
        parentTaskId: 'root-task',
        agentId: 'child-agent',
        status: 'failed',
      },
      {
        id: 'leaf',
        kind: 'agent',
        tenantId: 'default',
        rootTaskId: 'root-task',
        taskId: 'leaf-task',
        parentTaskId: 'child-task',
        agentId: 'leaf-agent',
        status: 'failed',
      },
    ],
    edges: [
      {
        id: 'e1',
        kind: 'agent-child',
        rootTaskId: 'root-task',
        parentTaskId: 'root-task',
        childTaskId: 'child-task',
        edgeKind: 'delegates_to',
        status: 'failed',
      },
      {
        id: 'e2',
        kind: 'agent-child',
        rootTaskId: 'root-task',
        parentTaskId: 'child-task',
        childTaskId: 'leaf-task',
        edgeKind: 'delegates_to',
        status: 'failed',
      },
    ],
    turns: [],
    memoryOps: [],
    effects: [],
    events: [],
    debug: { driverRuns: [] },
  };
}
