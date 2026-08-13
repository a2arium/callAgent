# Tutorial: compose independent agent projects

This tutorial creates two reusable **agent projects** and one runnable
**CallAgent workspace**. The agent projects can stay in different folders; the
workspace selects them as agent sources without copying them.

```bash
mkdir -p ~/Work/agents ~/Work/workspaces
cd ~/Work/agents
npm exec --yes --package=@a2arium/callagent-cli@0.1.0 -- \
  callagent create agent-project research-agents --with-agent researcher
npm exec --yes --package=@a2arium/callagent-cli@0.1.0 -- \
  callagent create agent-project writing-agents --with-agent writer

cd research-agents && npm install && npm run build
cd ../writing-agents && npm install && npm run build
```

Create the CallAgent workspace and compose both sources:

```bash
cd ~/Work/workspaces
npm exec --yes --package=@a2arium/callagent-cli@0.1.0 -- \
  callagent create workspace content-team \
  --agent-source ../../agents/research-agents \
  --agent-source ../../agents/writing-agents
cd content-team
cp .env.example .env
# Configure the database URL, Hatchet token, and Observer secret.
npm run infra:up
npm run db:setup
npm run validate
npm run start
```

`npm run start` starts the runtime host, Hatchet worker, and Observer. Open
`http://127.0.0.1:8790/operator` and confirm that both `researcher` and
`writer` appear. `infra:up` starts the packaged Hatchet/NATS profile; Postgres
is the external service configured by the workspace's `MEMORY_DATABASE_URL`.
Agent code dispatches to the other project through its normal agent ID; the
composition determines which IDs are available at runtime.

To add another agent to an existing agent project, run
`callagent create agent editor --project ~/Work/agents/writing-agents`, build
that project, and validate/restart the CallAgent workspace. To add or remove a
whole project, use `callagent workspace add-agent-source` or
`callagent workspace remove-agent-source` from the workspace.
