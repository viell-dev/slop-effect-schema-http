# Recipes

A service's conventions are its own, so these recipes are starting points and not library policy.
Copy one, change it to fit your service, and leave out what your service does not need. Each uses
only the public API, and the project's checks compile and run its code, including its failure cases.

The recipes hold each change in a named variable and use a generator where an operation runs. That
is a style and not a rule; the [Operation guide](./modules/operation.md#choose-a-style) shows the
others. Paths follow the [slash convention](./modules/request.md#add-to-a-path).

## Adjust a definition for one component

A definition describes the most common request, and each component adjusts it for its own case.
Write the definitions once, near the integration.
[`Response.tag`](./modules/response.md#add-an-alternative) names each outcome, so a caller can tell
them apart:

<<< ../examples/recipes/adjust-a-definition.ts#define

A dropdown needs the same endpoint without paging, and only two fields of each thing. Name each
change, then apply them to the definition:

<<< ../examples/recipes/adjust-a-definition.ts#adjust

`getThings` does not change. The request and the response change together, because a request that
asks for a different shape gets a different shape. The variant's result is the `Found` list of
options or the `Missing` case, and the whole `Thing` has left its type.

Running an operation is an Effect, so a generator can run the variant beside other operations. A
declared 404 is a result and not a failure, so each result is checked by its `_tag`:

<<< ../examples/recipes/adjust-a-definition.ts#run

The [Operation guide](./modules/operation.md#define-once-adjust-where-it-is-used) covers what a
variant can change, including the options and a mapped result.

## A vocabulary for one API

Every service has its own way of writing paging, sorting and embedding. Give those conventions names
once, as ordinary functions that return request transforms:

<<< ../examples/recipes/api-vocabulary.ts#vocabulary

A component then speaks the service's language:

<<< ../examples/recipes/api-vocabulary.ts#use

To reuse a combination, define it with `flow` and give it a name:

<<< ../examples/recipes/api-vocabulary.ts#compose

Where each call supplies the values, make the vocabulary typed. Schemas stack, so each one is its
own reusable transform:

<<< ../examples/recipes/api-vocabulary.ts#typed

Use a raw field for a default a variant may change, and a schema for what each call supplies. The
two work together: under `Paging`, `paged(0, 25)` is a default, so the caller's `page` replaces it
and `size` keeps it. A default has to fit the schema, so `sorted("price")` on `searchThings`
compiles, and then fails with `Request.InvalidRequest` when the request is prepared. The Request
guide explains [what a schema allows](./modules/request.md#a-schema-states-the-shape-of-its-group).

## Shared error cases

A service usually reports errors the same way everywhere. A response contract is an ordinary value,
so write those cases once:

<<< ../examples/recipes/shared-errors.ts#cases

Add them after each operation's own cases, because the first matching case wins:

<<< ../examples/recipes/shared-errors.ts#use

Both operations now return `Found`, `Missing` or `Forbidden`. To treat the last two as failures, map
every operation with one named function:

<<< ../examples/recipes/shared-errors.ts#fail

`requireOrder` succeeds with the order and fails with `ApiProblem`. An operation that should not
have a shared case can drop it, and a 403 then fails with `UnexpectedResponse`:

<<< ../examples/recipes/shared-errors.ts#drop

## A list with a count header and an empty response

Some services send rows with the total in a header, and HTTP 204 when there are none. Read both into
one value:

<<< ../examples/recipes/counted-list.ts#decoders

`Body.decoder` receives the response, so it can read a header and then the body. Passing
`rows.mediaType` keeps the automatic `Accept` header. `noRows` gives the same shape for the empty
answer:

<<< ../examples/recipes/counted-list.ts#operation

The count goes through a schema because a header is text a server can get wrong. A count that is
missing, fractional, negative or not a number fails with `Response.DecodeError`, not with a wrong
total.

In a browser, a cross-origin response hides this header unless CORS exposes it, so the service has
to list it in `Access-Control-Expose-Headers`. Without that, the count looks missing and the decoder
fails.

## An ID from `Location`, falling back to the body

A service may report a new resource's ID in a `Location` header, in the JSON body, or in either:

<<< ../examples/recipes/id-from-location.ts#decoder

When the header wins, `Body.empty.decode` reads the unused body to its end, so the response finishes
normally rather than being cut off when the attempt ends. Use the decoder like any other:

<<< ../examples/recipes/id-from-location.ts#operation

`lastSegment` is this service's rule. A `Location` that ends in a slash or carries a query needs a
rule of its own. A `Location` the schema cannot read fails with `Response.DecodeError`, and so does
a body with no ID.

## Per-request Fetch options

Effect's Fetch client reads extra options from the `FetchHttpClient.RequestInit` service. Provide it
around one operation's Effect to set options for that execution:

<<< ../examples/recipes/fetch-options.ts#options

<<< ../examples/recipes/fetch-options.ts#program

`freshPrices` goes out with `cache: "no-store"`. `anyPrices` does not, because the service only
reaches the Effect it was provided to. The client fills in some fields itself:

| Field in `RequestInit`                       | What happens                      |
| -------------------------------------------- | --------------------------------- |
| `method`, `body`, `signal`, `duplex`         | The client's value replaces yours |
| `headers`                                    | Merged, and the request's own win |
| Any other, such as `cache` and `credentials` | Passed to `fetch`                 |

Provide the service around the whole program to set a default. A value provided closer to an
operation replaces that default rather than merging with it, so repeat what should stay. Another
HTTP client does not read this service.

## Create, then upload

When a second request depends on the first, they are not one step. By the time the second runs, the
server has committed the first, and interruption cannot undo it. Keep the steps explicit, so a
failure says what already exists.

Put retries on the step that is safe to repeat. In this service, `uploadContent` replaces the
content, so it has a policy. Repeating `createDocument` can create a second document, so it has
none:

<<< ../examples/recipes/create-then-upload.ts#operations

The steps then run in order, and a failure of the second keeps what the first returned:

<<< ../examples/recipes/create-then-upload.ts#steps

| Failure               | What is known                                                                |
| --------------------- | ---------------------------------------------------------------------------- |
| From `createDocument` | No document was confirmed, though a transport error does not rule one out    |
| `UploadFailed`        | The document exists under `documentId`, and its content may not have arrived |

After `UploadFailed`, finish the upload instead of starting again:

<<< ../examples/recipes/create-then-upload.ts#resume

Do not retry `createThenUpload` as a whole, because each retry creates another document.

## Find the API when the application starts

Some applications only learn their server when they start, such as a self-hosted product or one with
several regions. Keep the definitions plain, and read the location from a service:

<<< ../examples/recipes/find-the-api.ts#service

`listOrders` now needs `ApiBase`, and leaving it out is a compile error. A `Ref` holds a value that
can change, so the location can move without touching a definition.

To find the server, ask each candidate in turn and take the first one that answers correctly:

<<< ../examples/recipes/find-the-api.ts#discover

`Effect.firstSuccessOf` stops at the first success, and the layer builds the service from it. The
probe's `attemptTimeout` stops a silent server from holding up the start, and its response schema
refuses a parked domain's page or another service.

Send credentials only to servers your application trusts. A candidate such as `api.<current domain>`
is whatever domain the build was served from, so it can be a server you do not control.

### Move to another server

A base from an Effect is read once per evaluation, so changing the `Ref` moves every later call:

<<< ../examples/recipes/find-the-api.ts#move

A base stays fixed for one evaluation, including its retries. To move during a call, keep the
request relative and let `transformClient` choose by [attempt
number](./modules/operation.md#client-middleware):

<<< ../examples/recipes/find-the-api.ts#within-a-call

Use this for reads. Moving a write can repeat it, because a transport failure does not prove the
first server did not apply it.

### Do not keep a failed discovery

`Effect.cached` keeps whatever the first run produced, including a failure, so a server that comes
back is never tried again. The layer above has no such problem, because a failed build stops the
program and keeps nothing. If discovery runs on demand instead, forget a failure so the next call
tries again:

<<< ../examples/recipes/find-the-api.ts#cached

## Browser requests to another origin

Effect's client adds `b3` and `traceparent` trace headers to each request by default. In a browser,
those headers make a cross-origin request need a CORS preflight. If the server does not list them in
`Access-Control-Allow-Headers`, the browser refuses the request, and it fails as a transport
failure, so a working server looks down.

Turn the headers off for one operation:

<<< ../examples/recipes/cross-origin.ts#provide

Or for a whole browser application:

<<< ../examples/recipes/cross-origin.ts#layer

This removes only the headers, and Effect still creates its client span. To carry traces across that
boundary, allow both headers on the server instead. Node has no preflight, so this affects browsers
only. See the [browser limits](./design.md#in-a-browser).

## A second level of URL prefix

`Request.baseUrl` replaces a base, so a second level of prefix needs `Request.mapBaseUrl`. It works
on a definition you only have as a value:

<<< ../examples/recipes/second-prefix.ts#prefix

The same function can change a prefix:

<<< ../examples/recipes/second-prefix.ts#change

The function runs when the request is prepared, so it also works on a [base from an
Effect](./modules/request.md#supply-the-base-when-the-request-runs).
