import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../../lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList(props: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>): React.ReactElement {
  return (
    <TabsPrimitive.List
      {...props}
      className={cn('inline-flex h-9 items-center justify-center rounded-md bg-surface-muted p-1 text-muted-foreground', props.className)}
    />
  );
}

export function TabsTrigger(props: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>): React.ReactElement {
  return (
    <TabsPrimitive.Trigger
      {...props}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:text-sm data-[state=active]:bg-card data-[state=active]:text-accent-foreground data-[state=active]:shadow-sm',
        props.className
      )}
    />
  );
}

export function TabsContent(props: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>): React.ReactElement {
  return (
    <TabsPrimitive.Content
      {...props}
      className={cn('mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', props.className)}
    />
  );
}
