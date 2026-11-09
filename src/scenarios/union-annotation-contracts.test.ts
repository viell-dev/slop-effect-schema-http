/**
 * EXT-36: independently authored wire coverage for annotated whole-union recovery.
 * Public acceptance: https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726559103
 * Parent-validation extension: https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6753221271
 * Uses the README's neutral echo contract; no backend or library implementation knowledge.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaAST } from "effect";
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
// Public inputs compile without a cast, including the separately bound sibling.
const completeQuery: Request.Input<typeof Choice> & Request.Input<typeof B> = {
  a: "x /+",
  b: "y",
  c: "z",
};
const completeHeaders: Request.Input<typeof HeaderChoice> &
  Request.Input<typeof HeaderB> = {
  "X-A": "x /+",
  "X-B": "y",
  "X-C": "z",
};
const queryInput = { query: completeQuery };
const headerInput = { headers: completeHeaders };
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

const sentTyped = <I, E>(
  request: (origin: string) => Request.Request<I, E>,
  input: I,
) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(
      request(backend.origin),
      Response.status(404, Body.text),
    )
      .execute(input)
      .pipe(
        Effect.provide(lane.fetchClient),
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const ledger = yield* backend.ledger;
            expect(ledger).toEqual([]);
            console.info(
              `Pre-dispatch refusal: ${String(error)}\nSocket ledger: ${JSON.stringify(ledger)}`,
            );
          }),
        ),
      );
    expect(result).toBe("Not Found");
    return yield* backend.ledger;
  });

const refusedTyped = <I, E>(
  request: (origin: string) => Request.Request<I, E>,
  input: I,
) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(
      request(backend.origin),
      Response.status(404, Body.text),
    )
      .execute(input)
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

// Historical scenarios deliberately erase the varying group schema in build().
const sent = <E>(
  request: (origin: string) => Request.Request<never, E>,
  input: unknown,
) => sentTyped(request, input as never);
const refused = <E>(
  request: (origin: string) => Request.Request<never, E>,
  input: unknown,
) => refusedTyped(request, input as never);

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

type ParentMetadata =
  "decoded" | "encoded" | "context" | "default" | "combined";
type ParentSchema = Schema.Codec<
  (typeof Choice)["Type"] | (typeof HeaderChoice)["Type"],
  (typeof Choice)["Encoded"] | (typeof HeaderChoice)["Encoded"]
>;
const parentChoice = <S extends Schema.Top & { readonly ast: SchemaAST.Union }>(
  choice: S,
  metadata: ParentMetadata,
  onDefault: () => void,
  accepts: (value: unknown) => boolean = () => true,
) => {
  const ast = choice.ast;
  const check = Schema.makeFilter(accepts, {
    expected: "a valid complete parent choice",
  });
  // Effect's public AST constructor exposes encoding-only checks without adding
  // a group transform. Retain the complete union and all its parent metadata.
  return Schema.make<Schema.Codec<S["Type"], S["Encoded"]>>(
    new SchemaAST.Union(
      ast.types,
      ast.options,
      combined,
      metadata === "decoded" || metadata === "combined" ? [check] : undefined,
      undefined,
      metadata === "context" ||
        metadata === "default" ||
        metadata === "combined"
        ? new SchemaAST.Context(
            false,
            false,
            metadata === "context"
              ? undefined
              : Effect.sync(() => {
                  onDefault();
                  return { b: "default", "X-B": "default" };
                }),
            { title: "Application filter group" },
          )
        : undefined,
      metadata === "encoded" || metadata === "combined" ? [check] : undefined,
    ),
  );
};
const hasSibling = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  ("b" in value || "X-B" in value);
const hasWideField = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  ("a" in value || "X-A" in value);

// Keep the new acceptance matrix on inferred operations, independently of the
// broad GroupSchema adapter used by the historical annotation tests above.
const parentSent = (group: Group, choice: ParentSchema) =>
  group === "query"
    ? sentTyped(
        (origin) => at(origin).pipe(Request.query(choice), Request.query(B)),
        queryInput,
      )
    : sentTyped(
        (origin) =>
          at(origin).pipe(Request.headers(choice), Request.headers(HeaderB)),
        headerInput,
      );
const parentRefused = (group: Group, choice: ParentSchema) =>
  group === "query"
    ? refusedTyped(
        (origin) => at(origin).pipe(Request.query(choice), Request.query(B)),
        queryInput,
      )
    : refusedTyped(
        (origin) =>
          at(origin).pipe(Request.headers(choice), Request.headers(HeaderB)),
        headerInput,
      );

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
    "[EXT-36h] a passing parent check retains every supplied query field",
    () =>
      Effect.gen(function* () {
        const choice = Choice.check(Schema.makeFilter(() => true)).annotate(
          combined,
        );
        const ledger = yield* sent(
          (origin) => build(origin, "query", choice, "union first"),
          queryInput,
        );
        expectWire(ledger, "query", "union first");
      }),
  );

  it.live(
    "[EXT-36i] a parent constructor default retains supplied query fields without running",
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
        const ledger = yield* sent(
          (origin) => build(origin, "query", choice, "sibling first"),
          queryInput,
        );
        expectWire(ledger, "query", "sibling first");
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

  for (const group of ["query", "headers"] as const) {
    for (const metadata of [
      "decoded",
      "encoded",
      "context",
      "default",
      "combined",
    ] as const) {
      it.live(
        `[EXT-36l] ${group}: ${metadata} parent metadata preserves all supplied fields`,
        () =>
          Effect.gen(function* () {
            let defaults = 0;
            let checks = 0;
            const choice = parentChoice(
              group === "query" ? Choice : HeaderChoice,
              metadata,
              () => defaults++,
              () => {
                checks++;
                return true;
              },
            );
            const ledger = yield* parentSent(group, choice).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  expect(defaults).toBe(0);
                }),
              ),
            );
            expectWire(ledger, group, "union first");
            if (
              metadata === "decoded" ||
              metadata === "encoded" ||
              metadata === "combined"
            )
              expect(checks).toBeGreaterThan(0);
          }),
      );

      it.live(
        `[EXT-36m] control: ${group} wider-first ${metadata} metadata retains its successful wire output`,
        () =>
          Effect.gen(function* () {
            let defaults = 0;
            const reordered =
              group === "query"
                ? Schema.Union([AC, B])
                : Schema.Union([HeaderAC, HeaderB]);
            const choice = parentChoice(reordered, metadata, () => defaults++);
            const ledger = yield* parentSent(group, choice);
            expectWire(ledger, group, "union first");
            expect(defaults).toBe(0);
          }),
      );
    }

    for (const side of ["decoded", "encoded"] as const) {
      it.live(
        `[EXT-36n] ${group}: the ${side} parent check still rejects the wider candidate missing its sibling`,
        () =>
          Effect.gen(function* () {
            const choice = parentChoice(
              group === "query" ? Choice : HeaderChoice,
              side,
              () => {
                throw new Error("a supplied parent must not need a default");
              },
              hasSibling,
            );
            yield* parentRefused(group, choice);
          }),
      );

      it.live(
        `[EXT-36o] limit: ${group} initial ${side} validation failure does not authorize recovery`,
        () =>
          Effect.gen(function* () {
            const choice = parentChoice(
              group === "query" ? Choice : HeaderChoice,
              side,
              () => {
                throw new Error("a supplied parent must not need a default");
              },
              hasWideField,
            );
            yield* parentRefused(group, choice);
          }),
      );
    }
  }
});
