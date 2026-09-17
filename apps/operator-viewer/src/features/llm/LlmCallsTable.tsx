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
      <table className="min-w-[980px] text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Provider</th>
            <th className="px-3 py-2 text-left">Model</th>
            <th className="px-3 py-2 text-left">Outcome</th>
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
              <tr key={`${call.traceId ?? call.model ?? 'call'}-${index}`} className={callFailed(call) ? 'border-t border-rose-200 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20' : 'border-t border-border'}>
                <td className="px-3 py-2">{call.provider ?? 'Not captured'}</td>
                <td className="px-3 py-2">{call.model ?? 'Not captured'}</td>
                <td className="px-3 py-2">
                  <p className={callFailed(call) ? 'font-medium text-danger' : ''}>{outcomeLabel(call)}</p>
                  {callFailed(call) ? <FailureReason text={failureReason(call)} /> : null}
                </td>
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

function FailureReason(props: { text: string }): React.ReactElement {
  return (
    <details className="mt-1 max-w-[360px] text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none break-words [overflow-wrap:anywhere] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="details-closed:line-clamp-2">{props.text}</span>
        <span className="ml-1 text-primary">Show full error</span>
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-danger-border bg-danger-bg p-2 font-sans text-xs text-danger [overflow-wrap:anywhere]">{props.text}</pre>
    </details>
  );
}

function callFailed(call: LlmCallRun): boolean {
  return call.terminalReason === 'provider_error' || call.terminalReason === 'timeout' || call.terminalReason === 'cancelled';
}

function outcomeLabel(call: LlmCallRun): string {
  if (call.terminalReason === 'provider_error') return 'Provider error';
  if (call.terminalReason === 'timeout') return 'Timed out';
  if (call.terminalReason === 'cancelled') return 'Cancelled';
  return 'Completed';
}

function failureReason(call: LlmCallRun): string {
  return call.errorCode ?? call.errorMessage ?? 'Provider did not supply an error detail';
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
