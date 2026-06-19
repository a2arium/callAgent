import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ThemeProvider } from './theme';

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
      <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
    </ThemeProvider>
  );
}
