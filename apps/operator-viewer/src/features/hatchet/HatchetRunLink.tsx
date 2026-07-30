import { ExternalLink } from 'lucide-react';
import { hatchetRunUrl, type OperatorConfig } from '../../api/client';
import { Button } from '../../design/components/ui/button';

export function HatchetRunLink(props: {
  providerRunId: string;
  config: OperatorConfig;
  label: string;
  ariaLabel?: string;
  className?: string;
}): React.ReactElement {
  return (
    <Button asChild variant="outline" size="sm" className={props.className}>
      <a
        href={hatchetRunUrl(props.providerRunId, props.config)}
        target="_blank"
        rel="noreferrer"
        aria-label={props.ariaLabel ?? props.label}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {props.label}
      </a>
    </Button>
  );
}
