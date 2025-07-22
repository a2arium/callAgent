# LLM Agent Example

This example demonstrates how to use an LLM (e.g., OpenAI, Anthropic) in a CallAgent agent. The agent takes a prompt, calls the LLM, and replies with the result.

## Running the Example

From the repository root:

```bash
yarn workspace @a2arium/llm-agent build
yarn run-agent apps/examples/llm-agent/dist/AgentModule.js '{"prompt": "Tell me a joke about AI."}'
```

## What It Demonstrates
- Accepting a prompt as input
- Calling an LLM from the agent
- Replying with the LLM's response 