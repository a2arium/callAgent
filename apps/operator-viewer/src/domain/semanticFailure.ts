import type { TurnRun } from '../types';

export type SemanticFailure = {
  code?: string;
  message: string;
};

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
