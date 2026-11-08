/**
 * EXT-36: independently authored wire coverage for annotated whole-union recovery.
 * Public acceptance: https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726559103
 * Uses the README's neutral echo contract; no backend or library implementation knowledge.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { bodyText, headerValues, type Recorded } from "../harness/lane.js";

type Group = "query" | "headers";
type Order = "union first" | "sibling first";
type GroupSchema = Schema.Top &
  Schema.ConstraintCodec<
    unknown,
    Readonly<Record<string, string>>,
    never,
    never
  >;
const secret = "hidden-union-value";
const B = Schema.Struct({ b: Schema.String });
const AC = Schema.Struct({ a: Schema.String, c: Schema.String });
const Choice = Schema.Union([B, AC]);
const HeaderB = Schema.Struct({ "X-B": Schema.String });
const HeaderAC = Schema.Struct({ "X-A": Schema.String, "X-C": Schema.String });
const HeaderChoice = Schema.Union([HeaderB, HeaderAC]);
const queryInput = { query: { a: "x /+", b: "y", c: "z" } };
const headerInput = { headers: { "X-A": "x /+", "X-B": "y", "X-C": "z" } };
const combined = {
  title: "Customer filters",
  description: "The application may combine account and category filters.",
};

const at = (origin: string) => Request.get(`${origin}/x`);

const build = (
  origin: string,
  group: Group,
  choice: GroupSchema,
  order: Order,
) => {
  if (group === "query") {
    return order === "union first"
      ? at(origin).pipe(Request.query(choice), Request.query(B))
      : at(origin).pipe(Request.query(B), Request.query(choice));
  }
  return order === "union first"
    ? at(origin).pipe(Request.headers(choice), Request.headers(HeaderB))
    : at(origin).pipe(Request.headers(HeaderB), Request.headers(choice));
};

const sent = <E>(
  request: (origin: string) => Request.Request<never, E>,
  input: unknown,
) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(
      request(backend.origin),
      Response.status(404, Body.text),
    )
      .execute(input as never)
      .pipe(
        Effect.provide(lane.fetchClient),
        Effect.tapError(() =>
          Effect.gen(function* () {
            expect(yield* backend.ledger).toEqual([]);
          }),
        ),
      );
    expect(result).toBe("Not Found");
    return yield* backend.ledger;
  });

const refused = <E>(
  request: (origin: string) => Request.Request<never, E>,
  input: unknown,
) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(
      request(backend.origin),
      Response.status(404, Body.text),
    )
      .execute(input as never)
      .pipe(
        Effect.provide(lane.fetchClient),
        Effect.match({
          onFailure: (error) => error,
          onSuccess: (value) => {
            expect(value).toBe("Not Found");
            return undefined;
          },
        }),
      );
    const ledger = yield* backend.ledger;
    expect(
      ledger.map((entry) => ({
        method: entry.method,
        target: entry.target,
        lines: entry.lines,
        body: bodyText(entry),
      })),
    ).toEqual([]);
    expect(result).toMatchObject({ _tag: "SchemaError" });
    expect(String(result)).not.toContain(secret);
    return String(result);
  });

const expectWire = (
  ledger: ReadonlyArray<Recorded>,
  group: Group,
  order: Order,
  a = "x /+",
) => {
  expect(ledger).toHaveLength(1);
  const entry = ledger[0]!;
  const target =
    group === "headers"
      ? "/x"
      : order === "union first"
        ? `/x?a=${encodeURIComponent(a)}&c=z&b=y`
        : `/x?b=y&a=${encodeURIComponent(a)}&c=z`;
  expect(entry.method).toBe("GET");
  expect(entry.target).toBe(target);
  expect(entry.head).toContain(`GET ${target} HTTP/1.1\r\n`);
  expect(entry.body.byteLength).toBe(0);
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  const fields = entry.lines.filter(([name]) => /^x-[abc]$/i.test(name));
  expect(fields).toHaveLength(group === "headers" ? 3 : 0);
  if (group === "headers") {
    expect(headerValues(entry.lines, "x-a")).toEqual([a]);
    expect(headerValues(entry.lines, "x-b")).toEqual(["y"]);
    expect(headerValues(entry.lines, "x-c")).toEqual(["z"]);
  }
};

describe(`annotations on request unions (${lane.name})`, () => {
  for (const group of ["query", "headers"] as const) {
    for (const [annotation, metadata, order] of [
      ["title", { title: "Customer filters" }, "union first"],
      [
        "description",
        { description: "Consumer-owned filter alternatives." },
        "sibling first",
      ],
      ["combined", combined, "union first"],
    ] as const) {
      it.live(
        `[EXT-36a] ${group}: ${annotation} annotations keep every field with ${order}`,
        () =>
          Effect.gen(function* () {
            const choice = (group === "query" ? Choice : HeaderChoice).annotate(
              metadata,
            );
            const ledger = yield* sent(
              (origin) => build(origin, group, choice, order),
              group === "query" ? queryInput : headerInput,
            );
            expectWire(ledger, group, order);
          }),
      );
    }

    for (const order of ["union first", "sibling first"] as const) {
      it.live(
        `[EXT-36b] control: a bare ${group} union already keeps every field with ${order}`,
        () =>
          Effect.gen(function* () {
            const ledger = yield* sent(
              (origin) =>
                build(
                  origin,
                  group,
                  group === "query" ? Choice : HeaderChoice,
                  order,
                ),
              group === "query" ? queryInput : headerInput,
            );
            expectWire(ledger, group, order);
          }),
      );
    }

    it.live(
      `[EXT-36c] control: a wider-first annotated ${group} union retains its successful trace`,
      () =>
        Effect.gen(function* () {
          const trace: string[] = [];
          const Checked = Schema.String.check(
            Schema.makeFilter((value) => {
              trace.push(value);
              return true;
            }),
          );
          const wide =
            group === "query"
              ? Schema.Struct({ a: Schema.String, c: Checked })
              : Schema.Struct({ "X-A": Schema.String, "X-C": Checked });
          const narrow = group === "query" ? B : HeaderB;
          const choice = Schema.Union([wide, narrow]).annotate(combined);
          const order = group === "query" ? "union first" : "sibling first";
          const ledger = yield* sent(
            (origin) => build(origin, group, choice, order),
            group === "query" ? queryInput : headerInput,
          );
          expectWire(ledger, group, order);
          expect(trace).toEqual(["z", "z", "z"]);
        }),
    );
  }

  it.live(
    "[EXT-36d] identifier and unfamiliar metadata do not prevent query recovery",
    () =>
      Effect.gen(function* () {
        const integrationMetadata = { owner: "consumer", revision: 7 };
        const choice = Choice.annotate({
          identifier: "ConsumerFilters",
          integrationMetadata,
        });
        expect(Schema.resolveAnnotations(choice)?.integrationMetadata).toBe(
          integrationMetadata,
        );
        const ledger = yield* sent(
          (origin) => build(origin, "query", choice, "sibling first"),
          queryInput,
        );
        expectWire(ledger, "query", "sibling first");
        expect(Schema.resolveAnnotations(choice)?.integrationMetadata).toBe(
          integrationMetadata,
        );
      }),
  );

  it.live(
    "[EXT-36e] annotated recovery keeps whole-union constructor priority for literal 01",
    () =>
      Effect.gen(function* () {
        const numeric = Schema.Struct({
          a: Schema.FiniteFromString,
          c: Schema.String,
        });
        const choice = Schema.Union([B, numeric, AC]).annotate(combined);
        const ledger = yield* sent(
          (origin) => build(origin, "query", choice, "union first"),
          { query: { a: "01", b: "y", c: "z" } },
        );
        expectWire(ledger, "query", "union first", "01");
      }),
  );

  it.live(
    "[EXT-36f] contradictory member fields remain refused by name without exposing values",
    () =>
      Effect.gen(function* () {
        const choice = Schema.Union([
          B,
          Schema.Struct({ a: Schema.String }),
          Schema.Struct({ c: Schema.String }),
        ]).annotate(combined);
        const error = yield* refused(
          (origin) => build(origin, "query", choice, "union first"),
          { query: { a: "x", b: "y", c: secret } },
        );
        expect(error).toContain('"c"');
      }),
  );

  it.live(
    "[EXT-36g] a rejected member value is not excused by an annotation or sibling",
    () =>
      Effect.gen(function* () {
        const checked = Schema.Struct({
          a: Schema.String,
          c: Schema.String.check(Schema.makeFilter((value) => value === "z")),
        });
        const choice = Schema.Union([B, checked]).annotate(combined);
        const error = yield* refused(
          (origin) => build(origin, "query", choice, "sibling first"),
          { query: { a: "x", b: "y", c: secret } },
        );
        expect(error).toContain('"c"');
      }),
  );

  it.live(
    "[EXT-36h] limit: a parent check still keeps annotated recovery unavailable",
    () =>
      Effect.gen(function* () {
        const choice = Choice.check(Schema.makeFilter(() => true)).annotate(
          combined,
        );
        const error = yield* refused(
          (origin) => build(origin, "query", choice, "union first"),
          { query: { a: secret, b: "y", c: "z" } },
        );
        expect(error).toContain('"a"');
      }),
  );

  it.live(
    "[EXT-36i] limit: a parent constructor default is not descriptive metadata",
    () =>
      Effect.gen(function* () {
        let defaults = 0;
        const choice = Choice.pipe(
          Schema.withConstructorDefault(
            Effect.sync(() => {
              defaults++;
              return { b: "default" };
            }),
          ),
        ).annotate(combined);
        const error = yield* refused(
          (origin) => build(origin, "query", choice, "sibling first"),
          { query: { a: secret, b: "y", c: "z" } },
        );
        expect(error).toContain('"a"');
        expect(defaults).toBe(0);
      }),
  );

  it.live(
    "[EXT-36j] control: an annotated oneOf union remains a refusal with no dispatch",
    () =>
      Effect.gen(function* () {
        const choice = Schema.Union([B, AC], { mode: "oneOf" }).annotate(
          combined,
        );
        yield* refused(
          (origin) => build(origin, "query", choice, "union first"),
          { query: { a: secret, b: "y", c: "z" } },
        );
      }),
  );

  it.live(
    "[EXT-36k] limit: annotated transformed members stay outside bounded recovery",
    () =>
      Effect.gen(function* () {
        const renamed = AC.pipe(Schema.encodeKeys({ a: "A", c: "C" }));
        const choice = Schema.Union([B, renamed]).annotate(combined);
        const error = yield* refused(
          (origin) => build(origin, "query", choice, "union first"),
          { query: { a: secret, b: "y", c: "z" } },
        );
        expect(error).toContain('"a"');
      }),
  );
});
