import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Notice } from '../design/components/ui/notice';
import { Button } from '../design/components/ui/button';

type Props = {
  children: ReactNode;
};

type State = {
  error?: Error;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Operator dashboard panel crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Notice kind="error" title="Panel failed">
        <p>{this.state.error.message}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => this.setState({ error: undefined })}>
          Try again
        </Button>
      </Notice>
    );
  }
}
