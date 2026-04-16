# flow-reference-agent

**Non-trivial** reference layout: `flow.md` (YAML front matter), `selectors.ts`, `reducers.ts`, `normalizers/`, `effects/`, `prompts/`, `contracts/`, and tests (`golden`, `resume`, `failure`, `invariant`). Use it alongside [doc 14 — Agent repository layout](../../docs/14-agent_repository_layout_for_aplret.md).

Scaffolded with:

```bash
yarn create-agent --name flow-reference-agent --preset non-trivial --output apps/examples/flow-reference-agent \
  --uses-llm --uses-tools --uses-children --uses-plans
```

## Build

```bash
yarn workspace @a2arium/flow-reference-agent build
yarn workspace @a2arium/flow-reference-agent test
```
