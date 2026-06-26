import { CopyableId } from '../../design/components/ui/copyable';
import { formatCost, formatDuration, formatNumber } from '../../design/format';
import type { LlmCallRun } from '../../types';

export function LlmCallsTable(props: {
  calls: LlmCallRun[];
}): React.ReactElement {
  if (props.calls.length === 0) {
    return <p className="text-sm text-muted-foreground">No LLM calls were captured for this scope.</p>;
  }
  return (
    <div className="overflow-auto rounded-lg border border-border">
      <table className="min-w-[850px] text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Provider</th>
            <th className="px-3 py-2 text-left">Model</th>
            <th className="px-3 py-2 text-left">Tokens</th>
            <th className="px-3 py-2 text-left">Cost</th>
            <th className="px-3 py-2 text-left">Latency</th>
            <th className="px-3 py-2 text-left">Contract</th>
            <th className="px-3 py-2 text-left">Trace</th>
          </tr>
        </thead>
        <tbody>
          {props.calls.map((call, index) => {
            return (
              <tr key={`${call.traceId ?? call.model ?? 'call'}-${index}`} className="border-t border-border">
                <td className="px-3 py-2">{call.provider ?? 'Not captured'}</td>
                <td className="px-3 py-2">{call.model ?? 'Not captured'}</td>
                <td className="px-3 py-2">{formatNumber(call.totalTokens ?? tokenTotal(call))}</td>
                <td className="px-3 py-2">{formatCost(call.costUsd ?? call.cost)}</td>
                <td className="px-3 py-2">{formatDuration(call.durationMs)}</td>
                <td className="px-3 py-2">{contractStatus(call)}</td>
                <td className="px-3 py-2">
                  {call.traceId ? (
                    <div className="grid gap-1">
                      <CopyableId value={call.traceId} label="trace ID" max={14} />
                      {call.spanId ? <CopyableId value={call.spanId} label="span ID" max={14} /> : null}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">Not captured</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function tokenTotal(call: LlmCallRun): number | undefined {
  const input = call.inputTokens ?? 0;
  const output = call.outputTokens ?? 0;
  const total = input + output;
  return total > 0 ? total : undefined;
}

function contractStatus(call: LlmCallRun): string {
  if (call.outputContractStatus) return call.outputContractStatus;
  if (call.hasOutputContract === true) return 'Contract status not captured';
  if (call.hasOutputContract === false) return 'No contract';
  return 'Not captured';
}
