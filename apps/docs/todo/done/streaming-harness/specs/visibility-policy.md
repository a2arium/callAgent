# Visibility Policy Spec

## Levels

| Visibility | Audience | Default Delivery |
|---|---|---|
| `public` | End users and normal clients | Yes |
| `debug` | Developer/debug clients | Opt-in |
| `private` | Runtime/internal only | No |

## Redaction Rules

- Public events must not include full tool args by default.
- Public events must not include internal thoughts by default.
- Public events must not include raw prompts unless explicitly authored for the user.
- Debug events may include previews, ids, names, and compact summaries.
- Private events may include raw internals but must not cross adapter boundaries
  unless explicitly enabled in a trusted local harness.

