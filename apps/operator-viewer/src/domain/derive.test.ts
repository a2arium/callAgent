import { describe, expect, it } from 'vitest';
import { deriveGraphInsights, deriveStatus } from './derive';
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
  };
}
