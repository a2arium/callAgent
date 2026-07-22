// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnDetail, TurnTimeline } from './TurnTimeline';
import type { TurnAttemptRun, TurnRun } from '../../types';

afterEach(cleanup);

describe('TurnTimeline', () => {
  it('presents logical turns once and summarizes nested execution attempts', () => {
    const turn = canceledTurn();
    render(<TurnTimeline turns={[turn]} onSelect={vi.fn()} />);

    expect(screen.getByText('1 turn · 4 runtime deliveries')).toBeTruthy();
    expect(screen.getByText('Turn 2')).toBeTruthy();
    expect(screen.getByText('4 deliveries')).toBeTruthy();
    expect(screen.getByText('Error before cancellation')).toBeTruthy();
    expect(screen.queryByText('Turn ?')).toBeNull();
  });

  it('keeps cancelled lifecycle wording while exposing the error and compressed attempts', () => {
    render(<TurnDetail turn={canceledTurn()} onBack={vi.fn()} />);

    expect(screen.getByLabelText('Cancelled run')).toBeTruthy();
    expect(screen.getByText('RUNTIME_TIMER_REPOSITORY_MISSING')).toBeTruthy();
    expect(screen.getByText('Runtime deliveries')).toBeTruthy();
    expect(screen.getByText('4 total · 1 executed · 3 ownership probes')).toBeTruthy();
    expect(screen.getByText('Attempts 2–4 · Queued ×3')).toBeTruthy();
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
  };
}
