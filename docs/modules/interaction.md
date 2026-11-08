# Interaction

`Interaction` coordinates work for one user-facing interaction, such as a search field or a refresh
button. Calls with equal input share active work or reuse its most recent retained success. A call
with different input replaces active work. Your application decides what its interface displays.

## Start by reusing one result

Pass a function that returns an Effect. This local example counts how often that function runs:

<<< ../../examples/modules/interaction.ts#imports

<<< ../../examples/modules/interaction.ts#simple

`Effect.scoped` gives the interaction a lifetime. Leaving the scope closes it and releases its owned
work. Keep that scope alive for as long as the interaction should accept calls; acquiring one in a
scope that immediately ends gives you an already-closed interaction.

## Wrap an HTTP operation

Pass an operation's `execute` method to `Interaction.make`, for example
`Interaction.make(updateUser.execute)` from the [usage guide](../usage.md#update-a-user-with-patch).
The interaction then accepts the same input as the operation.

Provide `HttpClient` and other required services around **acquisition**. `Interaction.make` captures
them there; later calls to `run` use those captured services. Effect's [scope
guide](https://effect.website/docs/v4/resource-management/scope) explains how to attach the lifetime
to an application component or other managed resource.

## Request fresh work

Use `force` for an explicit refresh, even when the input is unchanged:

<<< ../../examples/modules/interaction.ts#refresh

It bypasses the retained success and replaces any active execution. It does not change the input
contract or how the function produces a result.

## Choose equality and retention

The default comparison is Effect's `Equal.equals`, which compares plain objects and arrays
structurally. Override it when your application's meaning of equal input differs. `retain` decides
which successful results are worth reusing:

<<< ../../examples/modules/interaction.ts#options

A result rejected by `retain` is still returned to its callers, and it drops an earlier retained
success for equal input, which it replaces. Failures are never retained. Disabling retention does
not disable sharing of an equal in-progress execution.

## Advanced coordination

### Active work and retained success

The interaction holds at most one active execution and one retained success:

| Call                                                     | Result                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Equal to active input                                    | Wait for the shared execution                                         |
| Equal to retained input, with no conflicting active work | Reuse the retained success                                            |
| Different from active input                              | Interrupt the old execution and start or reuse work for the new input |
| `{ force: true }`                                        | Start fresh work and bypass reuse                                     |

Failures, defects and interruptions leave the previous retained success in place. The interaction is
not a cache indexed by all earlier inputs; a new retained success replaces the old one.

### Cancellation and closing

Each execution belongs to the interaction, not to any individual waiter. Interrupting one waiter
does not cancel work another waiter shares. Replacing work with different input does interrupt the
old execution; its waiters receive that execution's outcome.

The `close` Effect permanently closes the interaction. It is also run when the acquiring scope ends.
Repeated calls to `close` are safe, and every caller waits for finalizers of all owned work,
including superseded executions. A later `run` fails with `Interaction.Closed`, whose `_tag` is
`"InteractionClosed"`.

Cancellation can wait for resource cleanup. Do not use a timeout or supersession as proof that a
remote write was never applied; that depends on the service.

See the [interaction contract](../design.md#interactions) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.6.2/src/concurrency/Interaction.ts)
for the exact lifetime and error types.
