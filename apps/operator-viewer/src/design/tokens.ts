import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Loader2,
  type LucideIcon,
} from 'lucide-react';

export type RuntimeStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'stuck'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial'
  | 'unknown';

export type AttentionStatus = 'normal' | 'warning' | 'critical' | 'partial' | 'missing';

export type StatusToken = {
  id: RuntimeStatus;
  label: string;
  icon: LucideIcon;
  shape: 'solid' | 'dashed' | 'double';
  className: string;
  srLabel: string;
};

export const statusTokens: Record<RuntimeStatus, StatusToken> = {
  queued: {
    id: 'queued',
    label: 'Queued',
    icon: Clock3,
    shape: 'dashed',
    className: 'border-border bg-surface-muted text-muted-foreground',
    srLabel: 'Queued run',
  },
  running: {
    id: 'running',
    label: 'Running',
    icon: Loader2,
    shape: 'solid',
    className: 'border-info-border bg-info-bg text-info',
    srLabel: 'Running run',
  },
  waiting: {
    id: 'waiting',
    label: 'Waiting',
    icon: Clock3,
    shape: 'dashed',
    className: 'border-warning-border bg-warning-bg text-warning',
    srLabel: 'Waiting run',
  },
  stuck: {
    id: 'stuck',
    label: 'Stuck',
    icon: AlertTriangle,
    shape: 'double',
    className: 'border-warning-border bg-warning-bg text-warning',
    srLabel: 'Derived stuck waiting run',
  },
  completed: {
    id: 'completed',
    label: 'Completed',
    icon: CheckCircle2,
    shape: 'solid',
    className: 'border-success-border bg-success-bg text-success',
    srLabel: 'Completed run',
  },
  failed: {
    id: 'failed',
    label: 'Failed',
    icon: AlertTriangle,
    shape: 'solid',
    className: 'border-danger-border bg-danger-bg text-danger',
    srLabel: 'Failed run',
  },
  cancelled: {
    id: 'cancelled',
    label: 'Cancelled',
    icon: Ban,
    shape: 'solid',
    className: 'border-border bg-surface-muted text-muted-foreground',
    srLabel: 'Cancelled run',
  },
  partial: {
    id: 'partial',
    label: 'Partial data',
    icon: AlertTriangle,
    shape: 'dashed',
    className: 'border-primary/35 bg-accent text-accent-foreground',
    srLabel: 'Partial data',
  },
  unknown: {
    id: 'unknown',
    label: 'Unknown',
    icon: CircleHelp,
    shape: 'dashed',
    className: 'border-border bg-surface-muted text-muted-foreground',
    srLabel: 'Unknown status',
  },
};

export const attentionClasses: Record<AttentionStatus, string> = {
  normal: 'border-border bg-card',
  warning: 'border-warning-border bg-warning-bg',
  critical: 'border-danger-border bg-danger-bg',
  partial: 'border-primary/35 bg-accent',
  missing: 'border-dashed border-border bg-surface-muted',
};
