# Fix request: `callllm` declaration emit and module resolution

**Audience:** `callllm` maintainers  
**From:** A2arium CallAgent (`@a2arium/callagent-core`) — consumer of `callllm` as a dependency  
**Date:** 2026-03-30  

## Summary

The published ESM declaration graph under `dist/esm` is **not self-consistent**: several emitted `.d.ts` files import `../core/streaming/types.ts` (and similar paths), but **`dist/esm/core/streaming/types.*` is not emitted** at all. TypeScript consumers that fully resolve dependency declarations (for example **`tsd`**, or any check run **without** `skipLibCheck`) therefore fail with “Cannot find module …/types.ts”.

The main `tsc` build of our monorepo succeeds because we use `skipLibCheck: true`, which avoids validating transitive `.d.ts` bodies — but that hides a real packaging bug in `callllm`’s shipped types.

## Consumer impact

- Any project that imports from `callllm` and runs strict declaration validation on the **full** graph (type tests, some IDE diagnostics, alternate bundlers) may hit hard resolution errors even when runtime `import` works.
- Framework code re-exports or references types that trace back to `callllm` (e.g. `UniversalChatResponse`), so **public API type tests** cannot run cleanly without fixing upstream declarations.

## Reproduction

1. Depend on `callllm` (workspace `portal:` or npm install — same `dist` layout).
2. Add a minimal `tsd` test file that imports a type from **your** package that transitively imports from `'callllm'` (in our case `ILLMCaller` pulls in `UniversalChatResponse`, `LLMCaller`, etc.).
3. Run `tsd` on that file.

**Example errors** (actual output from our workspace):

```text
../../../callllm/dist/esm/adapters/types.d.ts:2:33
✖ Cannot find module ../core/streaming/types.ts or its corresponding type declarations.

../../../callllm/dist/esm/core/streaming/processors/UsageTrackingProcessor.d.ts:1:51
✖ Cannot find module ../types.ts or its corresponding type declarations.

../../../callllm/dist/esm/interfaces/UniversalInterfaces.d.ts:2:35
✖ Cannot find module ../core/streaming/types.ts or its corresponding type declarations.
```

## Root cause (technical)

### 1. Missing emitted module for streaming types

In **source**, streaming chunk types appear to live only in:

- `src/core/streaming/types.d.ts`

There is **no** corresponding emitted artifact under:

- `dist/esm/core/streaming/types.d.ts`
- `dist/esm/core/streaming/types.js`

Confirmed: after `yarn tsc` in `callllm`, `yarn tsc --listEmittedFiles` shows many files under `dist/esm/core/streaming/`, but **nothing** for `streaming/types`.

Meanwhile, emitted declarations still reference that module, e.g. `dist/esm/interfaces/UniversalInterfaces.d.ts`:

```ts
import type { ToolCallChunk } from '../core/streaming/types.ts';
```

So the **public type graph references a module that is absent from the published `dist` tree**.

### 2. `.ts` extensions inside emitted `.d.ts`

Emitted declaration files use specifiers like `'./core/caller/LLMCaller.ts'` and `'../core/streaming/types.ts'`, while shipped files are `*.js` / `*.d.ts`. That is fragile under `moduleResolution: "nodenEXT"` / strict tooling, even if some consumers accidentally “get away with it” via `skipLibCheck` or looser resolution.

**Request:** emit declarations that match Node ESM / TypeScript 5 `nodenext` expectations (typically **`.js` specifiers in emitted `.d.ts`**, consistent with the compiler’s `rewriteRelativeImportExtensions` story for outputs consumers actually load).

## Requested fixes

Please treat the following as acceptance criteria for closing this issue.

1. **Ship `streaming/types` in `dist`**
   - Ensure `dist/esm/core/streaming/types.d.ts` (and the corresponding runtime module if anything imports it at runtime) exists after build.
   - Practical approach: replace the standalone-input-only pattern with a normal **`.ts` source file** (e.g. `types.ts` containing `export type …`) so it is always emitted; or adjust the build to **copy / emit** the declaration module explicitly if you must keep `.d.ts`-only input.

2. **Validate the published type graph locally**
   - Add a CI step that typechecks a tiny consumer project **with `skipLibCheck: false`**, or run `tsd`/[`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) against the packed tarball, so missing modules cannot regress.

3. **Align declaration import specifiers with published files**
   - After (1), prefer emitted `.d.ts` `import`/`export` paths that resolve to files that **actually exist** in `dist` (and match your `exports` map). If the compiler is still emitting `.ts` extensions in `.d.ts`, consider adjusting `compilerOptions` / emit so consumer resolution matches `Node16`/`NodeNext` guidance.

## Verification (for `callllm` PR)

- [ ] `ls dist/esm/core/streaming/types.d.ts` succeeds after `yarn build`.
- [ ] No `.d.ts` under `dist/esm` imports a path with **no** matching file in `dist`.
- [ ] Optional but strong: `npx attw` (or equivalent) reports no resolution errors for the `"types"` entry.

## Contact / context

This request was written while integrating structured LLM output contracts in CallAgent. Our type-level tests import types that depend on `callllm`; fixing the above removes false failures unrelated to our framework logic.

If you want a minimal repro repository, we can provide a tiny package that only depends on `callllm` and runs `tsd` — failures should match the errors above until `types` is emitted and paths are consistent.
