# Effect Schema HTTP and Warded: request-head suite

This root branch holds an integration suite that tests
[Effect Schema HTTP](https://github.com/viell-dev/slop-effect-schema-http) and
[Warded](https://github.com/viell-dev/slop-warded-router), served by the
[Warded Server](https://github.com/viell-dev/slop-warded-server), against each other over real
sockets: what the library can declare in a request head, and what Warded can match there.

It is separate from the library's `main` branch and never merges into it. The suite arrives through
pull requests into this branch.

Agents write and maintain this suite. Its code is not human-reviewed.
