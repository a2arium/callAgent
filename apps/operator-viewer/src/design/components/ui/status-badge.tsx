import { cn } from '../../../lib/utils';
import { statusTokens, type RuntimeStatus } from '../../tokens';

export function StatusBadge(props: {
  status: RuntimeStatus;
  derived?: boolean;
  label?: string;
  className?: string;
}): React.ReactElement {
  const token = statusTokens[props.status] ?? statusTokens.unknown;
  const Icon = token.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        token.shape === 'dashed' ? 'border-dashed' : '',
        token.shape === 'double' ? 'border-2' : '',
        token.className,
        props.className
      )}
      aria-label={`${token.srLabel}${props.derived ? ' (derived)' : ''}`}
      title={`${props.label ?? token.label}${props.derived ? ' (derived)' : ''}`}
    >
      <Icon aria-hidden="true" className={cn('h-3.5 w-3.5', props.status === 'running' ? 'animate-spin' : '')} />
      {props.label ?? token.label}
      {props.derived ? <span className="sr-only">Derived</span> : null}
    </span>
  );
}
