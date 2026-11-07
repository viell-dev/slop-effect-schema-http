# Describe and execute a request

The [first example](./getting-started.md) created a user with POST. An application also needs to
change and remove users. This guide adds those actions, shares their URL configuration, adjusts a
definition for one use, and connects an operation to a real HTTP client.

## Define the consumer's contract

A **contract** states the input your application accepts and the output it expects from the service.
Reuse the parts shared by several actions: an API base, a user path and the returned user
representation.

Start a new ES module (`users.mts` for the Node example) with these imports and shared descriptions:

<<< ../examples/usage.ts#shared

`api` supplies the origin. `userId` declares a named path value, a number in your application and
URL text in the request. `userPath` places it in a path template, which converts the ID and escapes
it as a path value. `userBody` describes the user JSON your application understands. These are
ordinary reusable values, not an API-wide configuration object.

## Update a user with PATCH

Combine the shared path with a request body containing the changed name:

<<< ../examples/usage.ts#update

This operation takes one object: `path.userId` selects the user and `body.name` supplies the update.
In this service's contract, PATCH returns HTTP 200 with the updated user. Describe the status and
body your actual service returns; another service might return 204 with no body.

The pieces now have distinct roles:

| Piece                            | Role                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `Request.patch`                  | Choose the HTTP method                                  |
| `api` and `userPath`             | Build the URL from a shared base and the supplied ID    |
| `Request.body`                   | Encode the application's update as JSON                 |
| `Response.status(200, userBody)` | Select HTTP 200 and decode the updated user             |
| `Operation.make`                 | Combine these descriptions into an executable operation |

`Request.path` adds to the constructor's path, and here the template holds the whole path, so the
constructor starts with `""`. That gives `/users/42`, which joins to `https://api.example.test`. The
[Request guide](./modules/request.md#share-an-api-base-and-defaults) adds shared headers and [nested
resource paths](./modules/request.md#compose-nested-resource-paths).

### Understand the input type

`execute` infers its input from the request bindings. Your editor can show the required fields and
their types, and TypeScript checks calls against them. Extract the type when another function needs
to accept the same input:

<<< ../examples/usage.ts#input-type

The `&` combines the two required groups into one object. `path` and `body` are the library's
binding names; `userId` is the name given to `Request.pathValue`, and `name` comes from your schema.
`Schema.FiniteFromString` accepts a number here and encodes it to a string for the path. It also
accepts that string, because [an input takes either side of its
schema](./modules/request.md#a-schema-has-two-sides).

The name you give a path value is the name at the call site, so a call shows which ID is which. For
several path values, declare each one, place them in the template and call with
`path: { teamId: 7, userId: 42 }`. The [nested-path
example](./modules/request.md#compose-nested-resource-paths) shows a complete contract with several
IDs.

## Remove a user with DELETE

Reuse the same base and path while choosing a different method and response:

<<< ../examples/usage.ts#remove

There is no request body. `Body.empty` consumes the response without returning its contents, so the
result is `undefined`. A completed Effect tells the caller that the described deletion response was
received.

Together with the previous pages, these operations cover the resource's actions:

| Action | Request                      | Expected result                          |
| ------ | ---------------------------- | ---------------------------------------- |
| Read   | GET /users/42                | HTTP 200 and a user                      |
| Create | POST /users with a name      | HTTP 201 and a user with its assigned ID |
| Update | PATCH /users/:id with a name | HTTP 200 and the updated user            |
| Remove | DELETE /users/:id            | HTTP 204 with no body                    |

Each operation owns its request and response contract; only the common descriptions are shared.

## Adjust a definition where it is used

Write each common request once, near the integration. A definition describes the most common case,
not the only one, so a part of your application that needs something else derives a **variant**.
This definition lists 25 users:

<<< ../examples/usage.ts#list

A component that shows five holds that change in a variable and passes it to `Operation.mapRequest`:

<<< ../examples/usage.ts#adjust

`fewerUsers` is a new operation, and `listUsers` does not change. A request that asks for a
different shape gets a different shape, so a change of shape adjusts the response as well. Map once
per change:

<<< ../examples/usage.ts#adjust-shape

The [Operation guide](./modules/operation.md#define-once-adjust-where-it-is-used) covers everything
a variant can change, and [Recipes](./recipes.md#adjust-a-definition-for-one-component) shows a
complete component.

## Use an HTTP client for your service

`rename` and `remove` are **cold Effects**: constructing them sends nothing. Evaluate the one your
application needs, supplying an HTTP client. To run the rename with Fetch, first change the base URL
to your service, then provide Effect's Fetch layer:

<<< ../examples/usage.ts#fetch

A **layer** constructs dependencies needed by an Effect. `Effect.runPromise(overFetch)` runs the
PATCH request; inside an Effect program, use `yield* overFetch`. Each evaluation sends a new
operation. The deletion is a separate Effect and is not run by this code.

The [Operation guide](./modules/operation.md#supply-an-http-client) covers client setup in more
detail. In a browser, Fetch's credentials, CORS and redirect policies still apply.

### Run several steps with a generator

An operation that runs is an Effect, so a generator can run several in order. Inside `Effect.gen`,
`yield*` runs one and gives you its result. This keeps one user and removes its duplicate:

<<< ../examples/usage.ts#generator

`Effect.fn` gives a generator a name and parameters, for a function your application calls:

<<< ../examples/usage.ts#named-function

Generators are for running a plan. Building one stays with `.pipe`, because a `Request` is a plain
value and not an Effect. A generator also works in any callback that returns an Effect, as the
[Operation guide](./modules/operation.md#run-it-with-a-generator) shows.

## Extend the contract when needed

The default sends one attempt and decodes the first matching response case. Add features as the
service and application require them:

- [Request bindings](./modules/request.md#bind-application-input) add query and header input.
- [Body formats](./modules/body.md#choose-a-representation) cover text, bytes, forms and JSON.
- [Response alternatives](./modules/response.md#handle-several-outcomes) describe several outcomes,
  such as an updated user or a missing record.
- [Policy](./modules/policy.md) adds retries and timeouts when repeating the action is safe.
- [Interaction](./modules/interaction.md) coordinates shared or superseded work.

[Recipes](./recipes.md) combine these for everyday tasks, such as a list with a count header or an
upload after a create. Continue to the [module overview](./api.md) for the API. [Limits and
recovery](./limits.md) and [Design](./design.md) cover failure diagnosis and detailed behavior after
the module guides.
