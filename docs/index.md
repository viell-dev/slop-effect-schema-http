# Effect Schema HTTP

Describe an external service from your application's perspective, encode its request with Effect
Schema, and execute it through Effect's HTTP client. The contract belongs to the consumer: it states
what the service accepts and how your application interprets the response.

::: warning Release candidate
`0.1.0-rc.1` is a GitHub-only candidate for the first stable release. Install the release tarball;
there is no npm registry publication yet. Stable publication awaits the release tracker's remaining
prerequisites.
:::

Start with [installation](./getting-started.md), then [describe and execute a request](./usage.md).
The example runs against a synthetic HTTP client, so it needs no account, credentials, or external
service.

The library provides finite request and response body codecs, typed input and output contracts,
ordered response selection, execution policies, and interaction coordination. It composes Effect;
the application supplies its HTTP provider and runtime.

- [API modules](./api.md) link the public entry points to their current source and doc comments.
- [Design](./design.md) explains the contract, encoding, execution, and resource-lifetime rules.
- [Limits and recovery](./limits.md) distinguish validation, transport and decoding failures.
- [Versions and contributing](./versions.md) explain release documentation and maintenance.

Agents write and maintain the project. Its code is not human-reviewed. The source is
[MIT-licensed](https://github.com/viell-dev/slop-effect-schema-http/blob/main/LICENSE).
