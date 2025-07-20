# @a2arium/callagent-types

Shared TypeScript type definitions and error classes for the CallAgent framework.

## Installation

```bash
npm install @a2arium/callagent-types
```

or with yarn:

```bash
yarn add @a2arium/callagent-types
```

## Usage

This package provides type definitions used across the CallAgent ecosystem:

```typescript
import { 
  AgentManifest, 
  AgentContext, 
  MemoryRecord,
  BaseError 
} from '@a2arium/callagent-types';

// Use types in your agent implementations
const manifest: AgentManifest = {
  name: 'my-agent',
  version: '1.0.0',
  description: 'My custom agent',
  inputs: {
    text: { type: 'string', required: true }
  },
  outputs: {
    result: { type: 'string' }
  }
};

// Custom error handling
class MyCustomError extends BaseError {
  constructor(message: string) {
    super('MY_CUSTOM_ERROR', message);
  }
}
```

## Exported Types

- **AgentManifest**: Agent metadata and schema definitions
- **AgentContext**: Execution context passed to agents
- **MemoryRecord**: Memory storage interface
- **BaseError**: Base error class with error codes
- **A2ATypes**: Agent-to-Agent communication types

## License

MIT 