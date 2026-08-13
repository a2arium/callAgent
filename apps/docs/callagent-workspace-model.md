# The CallAgent workspace model

CallAgent has three ownership layers: **CallAgent** is the framework and
runtime distribution; an **agent project** is an independently buildable folder
containing one or more agents; a **CallAgent workspace** is the runnable
composition that selects agent sources and runs the runtime stack.

Keep reusable agent projects wherever they make sense for your organization.
Add their roots to a CallAgent workspace registry when they should refer to one
another by agent ID. The workspace does not copy agent code. It resolves the
selected composition once, then starts the runtime host, Hatchet worker, and
Observer with the same immutable descriptor and environment snapshot.

Use a local, project-pinned CLI for repeatable team behavior. A global CLI is
useful for creation commands, but it is convenience only and yields to the
workspace's installed CLI.
