import { CopyableId } from '../../design/components/ui/copyable';
import { Notice } from '../../design/components/ui/notice';
import { formatNumber, formatRelative } from '../../design/format';
import type { MemoryOperationRun } from '../../types';

export function MemoryOpsTable(props: { operations: MemoryOperationRun[] }): React.ReactElement {
  if (props.operations.length === 0) {
    return <p className="text-sm text-muted-foreground">No memory operations were captured for this scope.</p>;
  }
  return (
    <div className="grid gap-3">
      <Notice kind="info" title="Read result not captured">
        The dashboard can show memory reads/writes/deletes and keys, but cannot confirm cache hit or miss yet.
      </Notice>
      <div className="overflow-auto rounded-lg border border-border">
        <table className="min-w-[760px] text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Operation</th>
              <th className="px-3 py-2 text-left">Turn</th>
              <th className="px-3 py-2 text-left">Backend</th>
              <th className="px-3 py-2 text-left">Keys</th>
              <th className="px-3 py-2 text-left">Key count</th>
              <th className="px-3 py-2 text-left">When</th>
            </tr>
          </thead>
          <tbody>
            {props.operations.map((op) => (
              <tr key={op.id} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{op.op}</td>
                <td className="px-3 py-2">{op.turnSeq ?? 'Not captured'}</td>
                <td className="px-3 py-2">{op.backend ?? 'Not captured'}</td>
                <td className="px-3 py-2">
                  {op.keys.length > 0 ? <CopyableId value={op.keys.join(', ')} label="memory keys" max={34} /> : 'Not captured'}
                </td>
                <td className="px-3 py-2">{formatNumber(op.keyCount)}</td>
                <td className="px-3 py-2">{formatRelative(op.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
