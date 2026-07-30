// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeInspector } from './NodeInspector';
import type { AgentRunGraph, AgentRunNode } from '../../types';

afterEach(cleanup);

describe('NodeInspector Hatchet links', () => {
  it('places agent and effect links in context and removes the generic Links tab', () => {
    const node = agentNode();
    render(
      <NodeInspector
        graph={graph(node)}
        node={node}
        tenantId="tenant-1"
        activeTab="summary"
        config={{ hatchetDashboardUrl: 'http://hatchet.test/', hatchetDashboardTenantId: 'tenant-1' }}
        onTabChange={vi.fn()}
        onTurnSelect={vi.fn()}
        onTurnBack={vi.fn()}
      />,
    );

    expect(screen.queryByRole('tab', { name: 'Links' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open agent run in Hatchet' }).getAttribute('href')).toBe(
      'http://hatchet.test/tenants/tenant-1/runs/agent-run-1',
    );
    expect(screen.getByRole('link', { name: 'Open effect.timer in Hatchet' }).getAttribute('href')).toBe(
      'http://hatchet.test/tenants/tenant-1/runs/effect-run-1',
    );
    expect(screen.getByRole('link', { name: 'Open task.completed in Hatchet' }).getAttribute('href')).toBe(
      'http://hatchet.test/tenants/tenant-1/runs/outbox-run-1',
    );
    expect(screen.getByText('Technical details')).toBeTruthy();
    expect(screen.getByText('trace-1')).toBeTruthy();
  });

  it('omits Hatchet actions when provider run IDs are unavailable', () => {
    const node = agentNode({ providerRunId: undefined });
    render(
      <NodeInspector
        graph={graph(node, false)}
        node={node}
        tenantId="tenant-1"
        activeTab="summary"
        config={{}}
        onTabChange={vi.fn()}
        onTurnSelect={vi.fn()}
        onTurnBack={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link', { name: /Hatchet/i })).toBeNull();
    expect(screen.queryByText('Provider run ID not captured')).toBeNull();
  });
});

function agentNode(overrides: Partial<AgentRunNode> = {}): AgentRunNode {
  return {
    id: 'task-1',
    kind: 'agent',
    tenantId: 'tenant-1',
    rootTaskId: 'task-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    status: 'completed',
    severity: 'success',
    traceId: 'trace-1',
    providerRunId: 'agent-run-1',
    startedAt: '2026-07-30T10:00:00.000Z',
    finishedAt: '2026-07-30T10:00:01.000Z',
    ...overrides,
  };
}

function graph(node: AgentRunNode, withEffect = true): AgentRunGraph {
  return {
    schemaVersion: 3,
    tenantId: 'tenant-1',
    taskId: node.taskId,
    root: node,
    nodes: [node],
    edges: [],
    turns: [],
    unassignedAttempts: [],
    memoryOps: [],
    effects: withEffect ? [{
      id: 'effect-1',
      rootTaskId: node.rootTaskId,
      taskId: node.taskId,
      operation: 'effect.timer',
      status: 'completed',
      providerRunId: 'effect-run-1',
      hiddenByDefault: true,
    }] : [],
    events: [{
      id: 'event-1',
      source: 'wm_event',
      type: 'task.completed',
      taskId: node.taskId,
      seq: 1,
      timestamp: '2026-07-30T10:00:01.000Z',
      visibility: 'operator',
      group: { taskId: node.taskId, agentId: node.agentId },
      payload: {
        taskId: node.taskId,
        status: 'completed',
        ...(withEffect ? { providerRunId: 'outbox-run-1' } : {}),
      },
    }],
    coordination: {
      taskId: node.taskId,
      state: 'terminal',
      health: 'healthy',
      observedAt: '2026-07-30T10:00:01.000Z',
      requestedGeneration: '1',
      completedGeneration: '1',
      issues: [],
    },
    debug: { driverRuns: [] },
  };
}
