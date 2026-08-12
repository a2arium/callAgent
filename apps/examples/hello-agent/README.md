# hello-agent

Minimal **APLRET** example agent generated from the canonical scaffold (`minimal` preset). It echoes user text through the loop using closed `Obs` / `Intent` unions and `env.inbox.current` in perception.

## Layout

- `agent.ts` — `createAgent` wiring (default export)
- `types.ts` — closed `Sensory`, `Obs`, execution types
- Module files — `attention`, `perception`, `learning`, `policy`, `shield`, `execution`, `transition`
- `agent-card.json` / `agent-runtime.json` — manifests
- `tests/golden.test.ts` — harness smoke test

## Build and run

From the repository root:

```bash
yarn workspace @a2arium/hello-agent build
yarn run:hello
```

The runner sends a JSON payload; perception reads `payload.value` as the user string (see `perception.ts`).

To scaffold a fresh copy elsewhere:

```bash
callagent create agent hello-agent --project ./my-agents --preset minimal
```
