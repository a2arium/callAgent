import type { TurnRun } from '../types';

export type SemanticFailure = {
  code?: string;
  message: string;
};

export type SemanticAttention = SemanticFailure & { kind: 'llm_failures' | 'goal_not_met' | 'transition_failure' };

export function semanticFailureFromTurns(turns: TurnRun[]): SemanticFailure | undefined {
  for (const turn of [...turns].reverse()) {
    const failure = semanticFailureFromTurn(turn);
    if (failure) return failure;
  }
  return undefined;
}

export function semanticFailureFromTurn(turn: TurnRun): SemanticFailure | undefined {
  return semanticFailureFromTransition(turn.cognition?.transition);
}

export function semanticAttentionFromTurns(turns: TurnRun[]): SemanticAttention | undefined {
  const llmFailures = turns.flatMap((turn) => turn.cognitiveTurns ?? []).filter((turn) =>
    turn.llmCalls.some((call) => isRecord(call) && call.terminalReason !== undefined && call.terminalReason !== 'completed')
  );
  if (llmFailures.length > 0) {
    const firstCall = llmFailures.flatMap((turn) => turn.llmCalls).find((call) => isRecord(call) && call.terminalReason !== undefined && call.terminalReason !== 'completed') as Record<string, unknown> | undefined;
    const reason = firstCall ? stringField(firstCall, 'errorCode') ?? stringField(firstCall, 'errorMessage') ?? 'Provider error detail was not captured' : 'Provider error detail was not captured';
    return { kind: 'llm_failures', message: `${llmFailures.length} turn${llmFailures.length === 1 ? '' : 's'} had failed LLM calls: ${reason}` };
  }
  const finalTransition = [...turns].reverse().map((turn) => turn.cognition?.transition).find(isRecord);
  const result = finalTransition ? recordField(finalTransition, 'result') : undefined;
  const goals = result?.goals;
  if (Array.isArray(goals) && goals.some((goal) => isRecord(goal) && ['not_found', 'failed', 'unmet'].includes(String(goal.status)))) {
    const failedGoal = goals.find((goal) => isRecord(goal) && ['not_found', 'failed', 'unmet'].includes(String(goal.status))) as Record<string, unknown>;
    return { kind: 'goal_not_met', message: stringField(failedGoal, 'evidence') ?? 'The final result reports an unfulfilled goal.' };
  }
  const failure = semanticFailureFromTurns(turns);
  return failure ? { ...failure, kind: 'transition_failure' } : undefined;
}

export function semanticFailureFromTransition(value: unknown): SemanticFailure | undefined {
  if (!isRecord(value)) return undefined;
  const result = recordField(value, 'result');
  if (result?.ok !== false) return undefined;
  const error = recordField(result, 'error');
  const code = error ? stringField(error, 'code') : undefined;
  const message = error ? stringField(error, 'message') : undefined;
  if (!message && !code) return { message: 'Transition reported semantic failure.' };
  return { ...(code ? { code } : {}), message: message ?? code ?? 'Transition reported semantic failure.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}
