import { ExternalLink } from 'lucide-react';
import { opikTraceUrl, type OperatorConfig } from '../../api/client';
import { Button } from '../../design/components/ui/button';
import { formatCost, formatDuration, formatNumber } from '../../design/format';
import type { LlmCallRun } from '../../types';

export function LlmCallsTable(props: {
  calls: LlmCallRun[];
  config: OperatorConfig;
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
            const traceUrl = call.traceId ? opikTraceUrl(call.traceId, call.spanId, props.config) : undefined;
            return (
              <tr key={`${call.traceId ?? call.model ?? 'call'}-${index}`} className="border-t border-border">
                <td className="px-3 py-2">{call.provider ?? 'Not captured'}</td>
                <td className="px-3 py-2">{call.model ?? 'Not captured'}</td>
                <td className="px-3 py-2">{formatNumber(call.totalTokens ?? tokenTotal(call))}</td>
                <td className="px-3 py-2">{formatCost(call.costUsd ?? call.cost)}</td>
                <td className="px-3 py-2">{formatDuration(call.durationMs)}</td>
                <td className="px-3 py-2">{contractStatus(call)}</td>
                <td className="px-3 py-2">
                  {traceUrl ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={traceUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open
                      </a>
                    </Button>
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
