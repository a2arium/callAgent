# @a2arium/callagent-utils

Shared utility functions and logging for the CallAgent framework.

## Installation

```bash
npm install @a2arium/callagent-utils
```

or with yarn:

```bash
yarn add @a2arium/callagent-utils
```

## Usage

### Logging

```typescript
import { logger } from '@a2arium/callagent-utils';

logger.info('Agent started');
logger.error('Something went wrong', { error: err });
logger.debug('Debug information', { data: someData });
```

### Utilities

```typescript
import { /* utility functions */ } from '@a2arium/callagent-utils';

// Use utility functions in your agents
```

## Features

- **Structured Logging**: Consistent logging across the framework
- **Utility Functions**: Common helper functions for agent development

## License

MIT 