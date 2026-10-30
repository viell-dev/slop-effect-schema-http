# Recorded responses (`replay`)

Not a service of its own: the replay backend answers with responses that real server software
wrote, recorded byte for byte under [recordings/](../recordings/README.md). A consumer test that
decodes a replayed response decodes that software's bytes, not the suite's imitation of them. The
recordings, the software and versions behind them, and how they are made are described in
[recordings/README.md](../recordings/README.md); each set's `manifest.json` lists its exchanges.

## Answers

Each start serves the exchanges its options list. A request is answered by the first listed
exchange, not yet used, whose recorded request has the same method and request target, compared
byte for byte (the target includes its query). Headers and bodies of requests are not compared;
assert them from the ledger. A request no unused exchange matches gets `404` with a plain-text line
naming its method and target.

The answer is the recorded response: its status code and reason phrase, its header lines with their
spelling, order and values, and its body bytes. Two things come from the suite's HTTP server instead
of the recording:

- **Framing.** A recorded chunked body is sent chunked again, but its chunk sizes are the server's,
  not the recorded ones. A recorded `Content-Length` body is sent as recorded.
- **Connection management.** A recording without a `Connection` line gets the server's own
  `Connection: keep-alive` and `Keep-Alive` lines, as every backend's replies do; one with a
  `Connection` line keeps it.

The recorded `Date` is sent as recorded, so it names the day of the recording.

## Test options

Start it with `lane.backend("replay", options)`. Options are plain JSON.

- `exchanges` (required): the exchanges to serve, each as `"<set>/<name>"`, such as
  `"httpd-digest/challenge"`; the names are those in the set's `manifest.json`.
- `reuse`: when `true`, an exchange answers every matching request instead of only the first.
  Defaults to `false`.

For example, `{ "exchanges": ["httpd-digest/challenge", "httpd-digest/accepted"] }` answers the
first `GET /admin/audit.cgi?period=202610` with httpd's 401 challenge and the second with the
authorized reply, whatever `Authorization` the second carries.
