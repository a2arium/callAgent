import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ArtifactModalProvider } from '../features/inspector/JsonPreview';
import { ThemeProvider } from './theme';
import { AuthGate } from './auth';

export function Providers(props: { children: React.ReactNode }): React.ReactElement {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <AuthGate><ArtifactModalProvider>{props.children}</ArtifactModalProvider></AuthGate>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
