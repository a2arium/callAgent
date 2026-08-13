import { formatCost, formatDuration, formatNumber } from '../../design/format';
import type { LlmCallRun, TurnRun } from '../../types';

export function CostSummary(props: {
  costUsd?: number;
  llmCalls: LlmCallRun[];
  turns: TurnRun[];
}): React.ReactElement {
  const totalTokens = props.llmCalls.reduce((sum, call) => sum + (call.totalTokens ?? (call.inputTokens ?? 0) + (call.outputTokens ?? 0)), 0);
  const totalLatency = props.llmCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  const cards = [
    ['Known cost', formatCost(props.costUsd)],
    ['LLM calls', formatNumber(props.llmCalls.length)],
    ['Tokens', totalTokens > 0 ? formatNumber(totalTokens) : 'Not captured'],
    ['LLM latency', totalLatency > 0 ? formatDuration(totalLatency) : 'Not captured'],
    ['Turns', formatNumber(props.turns.reduce((count, turn) => count + (turn.cognitiveTurns?.filter((item) => item.disposition !== 'superseded').length ?? 0), 0))],
    ['Segments', formatNumber(props.turns.length)],
  ] as const;
  return (
    <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {cards.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border bg-background/50 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 truncate font-mono text-sm">{value}</p>
        </div>
      ))}
    </section>
  );
}
