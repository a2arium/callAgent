# Agent Asset Management

This guide explains how to manage assets (configuration files, images, data, etc.) when building agents with the CallAgent framework.

## The Simple Approach

Keep it simple! There are two main approaches:

### 1. Inline Manifests (Recommended for Simple Agents)

Put everything in your TypeScript code - no external files needed:

```typescript
import { createAgent } from '@callagent/core';

export default createAgent({
  // Inline manifest - no separate agent.json needed
  manifest: {
    name: 'my-agent',
    version: '1.0.0',
    description: 'A simple agent'
  },
  
  llmConfig: {
    provider: 'openai',
    modelAliasOrName: 'fast'
  },
  
  async handleTask(ctx) {
    await ctx.reply('Hello!');
    ctx.complete();
  }
}, import.meta.url);
```

**Build script:** Just TypeScript compilation
```json
{
  "scripts": {
    "build": "tsc"
  }
}
```

### 2. Manual Asset Copying (For Agents with External Files)

When you have `agent.json`, config files, or images:

```json
{
  "scripts": {
    "build": "tsc && copyfiles agent.json dist",
    "build:with-assets": "tsc && copyfiles agent.json dist && copyfiles -u 1 \"assets/**/*\" dist"
  }
}
```

**Why copyfiles?** Cross-platform compatibility (works on Windows, macOS, Linux)

## Examples by Complexity

### Simple Agent (No Assets)
```
hello-agent/
├── AgentModule.ts    # Uses inline manifest
├── tsconfig.json
└── package.json      # "build": "tsc"
```

### Agent with External Manifest (Single-Agent Folder)
```
memory-agent/
├── AgentModule.ts
├── agent.json        # External manifest (folder name must match agent name)
├── tsconfig.json
└── package.json      # "build": "tsc && copyfiles agent.json dist"
```

**Important:** External `agent.json` files can only be used when the folder name matches the agent name in the JSON. For multi-agent folders, only the main agent (matching folder name) can optionally use external JSON.

### Agent with Assets
```
complex-agent/
├── AgentModule.ts
├── agent.json
├── assets/
│   ├── images/logo.png
│   └── config/settings.json
├── tsconfig.json
└── package.json      # "build": "tsc && copyfiles agent.json dist && copyfiles -u 1 \"assets/**/*\" dist"
```

## Best Practices

1. **Start with inline manifests** - simplest approach
2. **Use copyfiles** - works cross-platform  
3. **Be explicit** - you can see exactly what gets copied
4. **Keep builds simple** - avoid overengineering

## Loading Assets at Runtime

Use `import.meta.url` for path resolution:

```typescript
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load config file
const configPath = path.join(__dirname, 'config', 'settings.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Load image
const imagePath = path.join(__dirname, 'images', 'logo.png');
const imageBuffer = fs.readFileSync(imagePath);
```

## Platform-Specific Commands

If you prefer native commands:

**Unix/macOS:**
```json
{
  "scripts": {
    "build": "tsc && cp agent.json dist/ && cp -r assets/ dist/"
  }
}
```

**Windows:**
```json
{
  "scripts": {
    "build": "tsc && copy agent.json dist\\ && xcopy assets dist\\assets\\ /E /I"
  }
}
```

**Cross-platform (recommended):**
```json
{
  "scripts": {
    "build": "tsc && copyfiles agent.json dist && copyfiles -u 1 \"assets/**/*\" dist"
  }
}
```

## Dependencies

Add `copyfiles` to your project:

```bash
yarn add -D copyfiles
```

That's it! Keep your build process simple and explicit. 