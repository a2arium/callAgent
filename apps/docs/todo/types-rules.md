# Type System Rules for Framework Development

*(Node.js + TypeScript — LLM-Optimized Edition)*

## Purpose

This document defines the **mandatory rules for designing typed APIs in this framework**.

The goals:

1. **TypeScript must prevent incorrect usage at compile time**
2. **Runtime behavior must match types**
3. **Framework APIs must be predictable and composable**
4. **Types must scale as the framework grows**
5. **LLMs must be able to generate correct code consistently**

This document defines **non-negotiable rules**.

If a design conflicts with these rules, **the design is wrong**.

---

# Core Philosophy

The framework follows one principle:

> **If code compiles, it should work.
> If it cannot work, it must not compile.**

Types are **part of the framework API contract**.

Breaking them is a **breaking change**.

---

# Rule 1 — Types Must Reflect Runtime Behavior

TypeScript types must **accurately model runtime behavior**.

Types must never:

* exaggerate capabilities
* hide possible states
* claim values that runtime cannot produce

Bad:

```ts
function getUser(id: string): Promise<any>
```

Good:

```ts
function getUser(id: string): Promise<User>
```

If runtime output depends on input, types must express that relationship.

Example:

```ts
function selectUser<T extends Select>(select: T): Promise<UserResult<T>>
```

Types must **model runtime transformations**.

---

# Rule 2 — Schemas Are the Single Source of Truth

Runtime validation and static typing must come from **one definition**.

Use **Zod schemas** as the authority.

```ts
const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
})

type User = z.infer<typeof UserSchema>
```

Benefits:

* runtime validation
* static typing
* zero duplication

Duplicating types and validators leads to drift and inconsistency. ([DEV Community][1])

Forbidden:

```ts
type User = {...}

validateUser(data)
```

---

# Rule 3 — Prefer Type Inference

Framework users should rarely write generics.

APIs must be designed so **TypeScript infers types automatically**.

Bad:

```ts
createRouter<UserContext, ErrorType>()
```

Good:

```ts
createRouter({
  users: userRouter
})
```

Inference reduces boilerplate and improves developer experience.

TypeScript is designed to infer types automatically in most cases. ([typescriptlang.org][2])

---

# Rule 4 — Illegal States Must Not Compile

Framework APIs must encode **constraints in the type system**.

Bad:

```ts
createServer({
  port: 3000
})
```

If `adapter` is required, the API must enforce it.

Good:

```ts
createServer({
  adapter: expressAdapter(),
  port: 3000
})
```

Use:

* discriminated unions
* conditional types
* branded types

Example:

```ts
type RuntimeConfig =
  | { runtime: "node"; port: number }
  | { runtime: "lambda"; handler: LambdaHandler }
```

Invalid states must fail at compile time.

---

# Rule 5 — `any` Is Forbidden in Public APIs

`any` disables the type system.

Never export `any`.

Bad:

```ts
function route(handler: any): any
```

Use instead:

```
unknown
generics
conditional types
```

Example:

```ts
function parse(input: unknown): ParsedData
```

---

# Rule 6 — APIs Must Guide IDE Autocomplete

Types should drive developer behavior through **autocomplete**.

Example:

```ts
router.get("/users", {
  query: UserQuerySchema,
  response: UserResponseSchema
})
```

IDE suggestions should include:

```
query
params
body
response
middleware
```

Types should guide the user toward the **correct usage path**.

---

# Rule 7 — Context Must Propagate Through the Type System

Framework pipelines often extend context.

Example pipeline:

```
middleware → route → handler
```

Context extensions must propagate.

Base context:

```ts
type Context = {
  requestId: string
}
```

Auth middleware:

```ts
type AuthContext = Context & {
  user: User
}
```

Handler:

```ts
(ctx: AuthContext) => {}
```

Intersection types allow combining multiple types safely. ([Wikipedia][3])

---

# Rule 8 — End-to-End Type Safety

Types must propagate across layers:

```
HTTP
↓
validation
↓
service
↓
database
↓
response
```

Never redefine types across layers.

Example:

```ts
const CreateUserSchema = z.object({
  email: z.string(),
})

type CreateUserInput = z.infer<typeof CreateUserSchema>
```

---

# Rule 9 — Database Types Come From Prisma

Prisma is the **database type authority**.

Correct:

```ts
import { Prisma } from "@prisma/client"

type User = Prisma.UserGetPayload<{
  select: { id: true; email: true }
}>
```

Never redefine DB types manually.

---

# Rule 10 — Public Types Must Be Separate

Framework types must be separated by stability level.

Structure:

```
src/internal/*
src/public-types/*
src/generated/*
```

Rules:

| Type         | Stability |
| ------------ | --------- |
| internal     | unstable  |
| generated    | derived   |
| public-types | stable    |

Only **public types** are exported.

---

# Rule 11 — Errors Must Be Typed

Never throw unstructured errors.

Define error unions.

```ts
type APIError =
  | { type: "ValidationError"; message: string }
  | { type: "AuthError"; message: string }
  | { type: "InternalError"; message: string }
```

API responses:

```ts
type APIResponse<T> =
  | { success: true; data: T }
  | { success: false; error: APIError }
```

---

# Rule 12 — Avoid Type-Level Overengineering

Types must be understandable.

Guideline hierarchy:

```
inference
↓
generics
↓
conditional types
↓
type-level programming
```

If a type requires explanation to understand, redesign it.

Overly complex generics reduce maintainability. ([DEV Community][1])

---

# Rule 13 — Types Must Be Tested

Framework APIs require **type tests**.

Example using `tsd`:

```ts
expectType<User>(result)
```

Compile-time assertions:

```ts
type Assert<T extends true> = T
```

Type tests prevent regressions.

---

# Rule 14 — Type Changes Are Breaking Changes

Types are part of the **public API contract**.

Changing:

* return types
* schema shapes
* context types

requires a **major version bump**.

---

# Rule 15 — Framework Types Must Support Two Modes

Framework APIs must support:

### Simple usage

```ts
createServer()
```

### Advanced usage

```ts
createServer<Context, ErrorShape, Metadata>()
```

Design principle:

```
simple case → minimal types
advanced case → full control
```

---

# Compiler Configuration (Mandatory)

`tsconfig.json` must enable strict mode.

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "exactOptionalPropertyTypes": true
  }
}
```

Strict compiler settings significantly improve type safety. ([KernelOps][4])

---

# Canonical Framework Patterns

### Validation

```
Zod schema
↓
z.infer
↓
shared type
```

### Database

```
Prisma schema
↓
Prisma types
↓
service layer
```

### API

```
schema → handler → typed response
```

### Context

```
middleware → context extension → handler
```

---

# Anti-Patterns (Forbidden)

Never introduce:

* `any` in public APIs
* duplicated type definitions
* runtime behavior not reflected in types
* overly complex generics
* hidden context mutations
* implicit `undefined` states
* undocumented types

---

# Final Principle

Types are not documentation.

Types are **executable contracts**.

> If it type-checks, it must work.
> If it cannot work, it must not compile.
 