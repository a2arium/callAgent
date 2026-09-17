// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnDetail, TurnTimeline } from './TurnTimeline';
import type { CognitiveTurnRun, TurnAttemptRun, TurnRun } from '../../types';

afterEach(cleanup);

describe('TurnTimeline', () => {
  it('keeps a legacy segment visible as one turn stack', () => {
    const turn = canceledTurn();
    render(<TurnTimeline turns={[turn]} onSelect={vi.fn()} />);

    expect(screen.getByText('1 turn in 1 stack · 4 runtime deliveries')).toBeTruthy();
    expect(screen.getByText('Turn 1')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.queryByText('Inspect turns')).toBeNull();
    expect(screen.queryByText('Turn ?')).toBeNull();
  });

  it('keeps the stage inspector inside each expanded cognitive turn', () => {
    const turn = canceledTurn();
    turn.cognitiveTurns = [cognitiveTurn()];
    render(<TurnDetail turn={turn} onBack={vi.fn()} />);

    expect(screen.getByText('Individual turns')).toBeTruthy();
    expect(screen.getByText('APLRET models')).toBeTruthy();
    expect(screen.getByText('Attention')).toBeTruthy();
    expect(screen.getByText('Perception')).toBeTruthy();
    expect(screen.getByText('Policy')).toBeTruthy();
    expect(screen.getAllByText('Transition').length).toBeGreaterThan(0);
    expect(screen.queryByText('Stage timings')).toBeNull();
  });

  it('labels a started-only final turn as cancelled by the root timeout', () => {
    const turn = canceledTurn();
    turn.cognitiveTurns = [{ ...cognitiveTurn(), disposition: 'running' }];
    render(<TurnDetail turn={turn} ownerStatus="canceled" ownerCancellationReason="active_run_timeout" onBack={vi.fn()} />);

    expect(screen.getByText(/Turn 1 · cancelled by timeout/)).toBeTruthy();
    expect(screen.getByText(/time budget expired before this turn completed/i)).toBeTruthy();
  });

  it('keeps cancelled lifecycle wording while exposing the error and compressed attempts', () => {
    render(<TurnDetail
      turn={canceledTurn()}
      config={{ hatchetDashboardUrl: 'http://hatchet.test/', hatchetDashboardTenantId: 'tenant/one' }}
      onBack={vi.fn()}
    />);

    expect(screen.getByLabelText('Cancelled run')).toBeTruthy();
    expect(screen.getByText('RUNTIME_TIMER_REPOSITORY_MISSING')).toBeTruthy();
    expect(screen.getByText('Runtime deliveries')).toBeTruthy();
    expect(screen.getByText('4 total · 1 executed · 3 ownership probes')).toBeTruthy();
    expect(screen.getByText('Attempts 2–4 · Queued ×3')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open delivery attempt 1 in Hatchet' }).getAttribute('href')).toBe(
      'http://hatchet.test/tenants/tenant%2Fone/runs/hatchet-run-1',
    );
    expect(screen.queryByRole('link', { name: /attempts 2–4/i })).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});

function canceledTurn(): TurnRun {
  const attempts: TurnAttemptRun[] = [
    attempt(1, 'executed', 'running'),
    attempt(2, 'queued', 'completed'),
    attempt(3, 'queued', 'completed'),
    attempt(4, 'queued', 'completed'),
  ];
  return {
    ...attempts[0]!,
    id: 'turn:task-1:2',
    turnSeq: 2,
    status: 'canceled',
    severity: 'error',
    boundaryKind: 'await_child',
    attempts,
    error: { name: 'Error', message: 'RUNTIME_TIMER_REPOSITORY_MISSING' },
  };
}

function cognitiveTurn(): CognitiveTurnRun {
  return {
    id: 'cognition-2',
    rootTaskId: 'task-1',
    taskId: 'task-1',
    cognitionTurnSeq: 2,
    disposition: 'committed',
    cognition: {
      perception: { kind: 'perception', url: 'https://example.test' },
      intent: { kind: 'internal', intent: 'Continue' },
      transition: { kind: 'continue', result: { ok: true } },
      timings: { perceptionMs: 10, policyMs: 20, transitionMs: 5, totalMs: 35 },
    },
    llmCalls: [],
    toolCalls: [],
    childCalls: [],
    memoryOps: [],
  };
}

function attempt(
  attemptSeq: number,
  disposition: NonNullable<TurnAttemptRun['disposition']>,
  status: TurnAttemptRun['status']
): TurnAttemptRun {
  return {
    id: `attempt-${attemptSeq}`,
    attemptKey: `attempt-${attemptSeq}`,
    attemptSeq,
    rootTaskId: 'task-1',
    taskId: 'task-1',
    turnSeq: 2,
    operation: 'turn.segment',
    disposition,
    status,
    boundaryKind: 'await_child',
    startedAt: `2026-07-22T10:00:0${attemptSeq}.000Z`,
    finishedAt: `2026-07-22T10:00:0${attemptSeq}.500Z`,
    ...(attemptSeq === 1 ? { providerRunId: 'hatchet-run-1' } : {}),
  };
}
