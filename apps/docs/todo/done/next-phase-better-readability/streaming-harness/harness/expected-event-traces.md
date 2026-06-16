# Expected Event Traces

This file records high-level expected traces before concrete golden files exist.

## Simple Reply

```text
0 task.status(state=submitted, terminal=false, public)
1 task.status(state=working, terminal=false, public)
2 artifact.delta(artifactId=response, index=0, append=false, public)
3 artifact.done(artifactId=response, index=0, public)
4 task.status(state=completed, terminal=true, public)
```

Public projection is identical to canonical projection for this scenario.
Debug projection may include trace summaries, but no debug event is required.

## Incremental Artifact

```text
0 task.status(state=submitted, terminal=false, public)
1 task.status(state=working, terminal=false, public)
2 artifact.delta(artifactId=response, index=0, append=false, text="Hel", public)
3 artifact.delta(artifactId=response, index=0, append=true, text="lo", public)
4 artifact.done(artifactId=response, index=0, public)
5 task.status(state=completed, terminal=true, public)
```

Required assertion: event 4 must not close the stream. Only event 5 closes it.

## Input Required

```text
0 task.status(state=submitted, terminal=false, public)
1 task.status(state=working, terminal=false, public)
2 artifact.delta(artifactId=prompt, index=0, append=false, public)
3 artifact.done(artifactId=prompt, index=0, public)
4 input.required(token=tok-1, public)
5 task.status(state=input-required, terminal=false, public)
...resume...
6 task.status(state=working, terminal=false, public)
7 artifact.delta(artifactId=response, index=0, append=false, public)
8 artifact.done(artifactId=response, index=0, public)
9 task.status(state=completed, terminal=true, public)
```

Required assertions:

- `input.required` includes a token.
- `task.status(input-required)` does not close the stream.
- Resume output uses later sequence numbers and does not replay earlier prompt
  events unless reconnect/replay explicitly asks for them.

## Async Tool

```text
0 task.status(state=submitted, terminal=false, public)
1 task.status(state=working, terminal=false, public)
2 tool.started(token=tool-search-1, toolName=search, debug)
3 thought.added(thoughtId=thought-1, private)
4 tool.completed(token=tool-search-1, toolName=search, status=completed, debug)
5 artifact.delta(artifactId=response, index=0, append=false, public)
6 artifact.done(artifactId=response, index=0, public)
7 task.status(state=completed, terminal=true, public)
```

Required assertions:

- Public projection excludes events 2, 3, and 4.
- Debug projection includes events 2 and 4, but excludes private event 3.
- Chat projection only sees typing, message, and completed events.

## Child Agent

```text
task.status(working)
child.started(debug)
child.message(public-or-debug)
child.completed(debug)
artifact.delta(parent-response)
artifact.done(parent-response)
task.status(completed, terminal)
```
