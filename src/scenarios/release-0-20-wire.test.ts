import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaTransformation } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues } from "../harness/lane.js";

type JsonSchema = Schema.Top &
  Schema.ConstraintCodec<unknown, unknown, never, never>;

const exchange = <S extends JsonSchema>(schema: S, body: Request.Input<S>) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(
      Request.post(`${backend.origin}/x`).pipe(
        Request.body(Body.jsonSchema(schema)),
      ),
      Response.status(404, Body.text),
    )
      .execute({ body })
      .pipe(Effect.provide(lane.fetchClient), Effect.result);
    return { result, ledger: yield* backend.ledger };
  });

const sends = <S extends JsonSchema>(
  schema: S,
  input: Request.Input<NoInfer<S>>,
  json: string,
) =>
  Effect.gen(function* () {
    const { result, ledger } = yield* exchange(schema, input);
    expect(result).toMatchObject({ _tag: "Success", success: "Not Found" });
    expect(ledger).toHaveLength(1);
    const entry = ledger[0]!;
    expect({ method: entry.method, target: entry.target }).toEqual({
      method: "POST",
      target: "/x",
    });
    expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
    expect(headerValues(entry.lines, "content-type")).toEqual([
      "application/json",
    ]);
    expect(entry.body, new TextDecoder().decode(entry.body)).toEqual(
      new TextEncoder().encode(json),
    );
  });

const refuses = <S extends JsonSchema>(
  schema: S,
  input: unknown,
  path: string,
  message?: string,
) =>
  Effect.gen(function* () {
    // Refusal cases exercise the public runtime boundary, including JS callers.
    const { result, ledger } = yield* exchange(
      schema,
      input as Request.Input<S>,
    );
    expect(
      ledger.map(({ method, target, body }) => ({
        method,
        target,
        body: new TextDecoder().decode(body),
      })),
      String(result),
    ).toEqual([]);
    const error = result._tag === "Failure" ? result.failure : undefined;
    expect(Schema.isSchemaError(error), String(error)).toBe(true);
    const diagnostic = error instanceof Error ? error.message : String(error);
    expect(diagnostic).toContain(path);
    if (message !== undefined) {
      expect(diagnostic.replace(/\r?\n\s+/g, " ")).toContain(message);
    }
  });

const Fields = Schema.Struct({ a: Schema.optionalKey(Schema.String) });
const Payload = Schema.Struct({
  a: Schema.optionalKey(Schema.String),
  b: Schema.optionalKey(Schema.String),
});
const Held = Schema.OptionFromNullOr(Payload);
const some = Option.some({ a: "a", b: "keep" });
const none = Option.none();

for (const [label, field] of [
  ["struct", Fields],
  ["NullOr", Schema.NullOr(Fields)],
  ["OptionFromNullOr", Schema.OptionFromNullOr(Fields)],
] as const) {
  it.live(`[EXT-65] ${label} refuses a Date before rebuilding it`, () =>
    refuses(
      Schema.Struct({ held: field }),
      { held: new Date(0) },
      '["held"]',
      'The schema cannot keep this Date as an object at ["held"]',
    ),
  );
  it.live(`[EXT-65] ${label} refuses a Map before rebuilding it`, () =>
    refuses(
      Schema.Struct({ held: field }),
      { held: new Map([["a", "map"]]) },
      '["held"]',
    ),
  );
  for (const [inputLabel, held] of [
    ["plain object", { a: "keep" }],
    [
      "class instance",
      new (class {
        a = "keep";
      })(),
    ],
  ] as const) {
    it.live(`[EXT-65] ${label} keeps fields from a ${inputLabel}`, () =>
      sends(Schema.Struct({ held: field }), { held }, '{"held":{"a":"keep"}}'),
    );
  }
}

const Mixed = Schema.Struct({ held: Held, count: Schema.FiniteFromString });
it.live("[EXT-66] Some survives beside an encoded count", () =>
  sends(
    Mixed,
    { held: some, count: "2" },
    '{"held":{"a":"a","b":"keep"},"count":"2"}',
  ),
);
it.live("[EXT-66] None survives beside an encoded count", () =>
  sends(Mixed, { held: none, count: "2" }, '{"held":null,"count":"2"}'),
);

const HandWritten = Schema.Struct({ value: Schema.optionalKey(Payload) }).pipe(
  Schema.decodeTo(
    Schema.Option(Payload),
    SchemaTransformation.transform({
      decode: ({ value }) => Option.fromUndefinedOr(value),
      encode: (value) =>
        Option.match(value, {
          onNone: () => ({}),
          onSome: (payload) => ({ value: payload }),
        }),
    }),
  ),
);
it.live(
  "[EXT-66] a hand-written codec writes Some beside an encoded count",
  () =>
    sends(
      Schema.Struct({ held: HandWritten, count: Schema.FiniteFromString }),
      { held: some, count: "2" },
      '{"held":{"value":{"a":"a","b":"keep"}},"count":"2"}',
    ),
);

it.live("[EXT-67] an invalid native Some is refused at its payload field", () =>
  refuses(
    Schema.Struct({ held: Held }),
    { held: Option.some({ a: 5, b: "keep" }) },
    '["held"]["value"]["a"]',
  ),
);
it.live(
  "[EXT-67] a hand-written codec refuses a wrapper whose payload it cannot write",
  () =>
    refuses(
      Schema.Struct({ held: HandWritten }),
      { held: Option.some({ a: 5, b: "keep" }) },
      '["held"]["value"]["a"]',
    ),
);
for (const [label, payload] of [
  ["Any", Schema.Any],
  ["ObjectKeyword", Schema.ObjectKeyword],
] as const) {
  it.live(
    `[EXT-67] ${label} does not take the wrapper of an invalid Some as its encoded payload`,
    () =>
      refuses(
        Schema.Struct({
          held: Schema.OptionFromNullOr(
            payload.check(Schema.makeFilter((value) => Option.isOption(value))),
          ),
        }),
        { held: Option.some({ b: "keep" }) },
        '["held"]',
      ),
  );
}

const Holder = Schema.Struct({ held: Held });
const RenamedField = Holder.pipe(Schema.encodeKeys({ held: "wire_held" }));
const RenamedSibling = Mixed.pipe(Schema.encodeKeys({ count: "wire_count" }));
const RenamedAncestor = Schema.Struct({ group: Holder }).pipe(
  Schema.encodeKeys({ group: "wire_group" }),
);
class Ticket extends Schema.Class<Ticket>("Ticket")({ held: Held }) {}
const RenamedClass = Ticket.pipe(Schema.encodeKeys({ held: "wire_held" }));
const RenamedList = Schema.Struct({ group: Schema.Array(Holder) }).pipe(
  Schema.encodeKeys({ group: "wire_group" }),
);

// Beside the sibling given under its wire name, `Payload`'s optional fields could read the `None`
// wrapper itself, so only the library's strict read takes the value. The refusal names the wrapper
// with the library's own message, not that read's excess-property error at `wire_count`.
// https://github.com/viell-dev/slop-effect-schema-http/issues/351
const wrapperRefused = {
  path: '["held"]',
  message:
    'The schema cannot keep this field with the rest of the value at ["held"]',
};
for (const [wrapper, held] of [
  ["Some", some],
  ["None", none],
] as const) {
  for (const [label, schema, input, decodedKey, wireKey, noneRefused] of [
    [
      "renamed field",
      RenamedField,
      { wire_held: held },
      "held",
      "wire_held",
      undefined,
    ],
    [
      "renamed sibling",
      RenamedSibling,
      { held, wire_count: "2" },
      "count",
      "wire_count",
      wrapperRefused,
    ],
    [
      "renamed ancestor",
      RenamedAncestor,
      { wire_group: { held } },
      "group",
      "wire_group",
      undefined,
    ],
    [
      "renamed class",
      RenamedClass,
      { wire_held: held },
      "held",
      "wire_held",
      undefined,
    ],
    [
      "list below a renamed ancestor",
      RenamedList,
      { wire_group: [{ held }] },
      "group",
      "wire_group",
      undefined,
    ],
  ] as const) {
    const expected =
      wrapper === "Some"
        ? { path: `["${decodedKey}"]`, message: undefined }
        : (noneRefused ?? { path: `["${wireKey}"]`, message: undefined });
    it.live(
      `[EXT-68] ${wrapper} on the encoded side refuses through a ${label}`,
      () => refuses(schema, input, expected.path, expected.message),
    );
  }
}

const jsonPayload = '{"a":"a","b":"keep"}';
it.live(
  "[EXT-68] the decoded name and the direct wire payload each send through a renamed field",
  () =>
    Effect.gen(function* () {
      yield* sends(
        RenamedField,
        { held: some },
        `{"wire_held":${jsonPayload}}`,
      );
      yield* sends(
        RenamedField,
        { wire_held: { a: "a", b: "keep" } },
        `{"wire_held":${jsonPayload}}`,
      );
    }),
);
it.live("[EXT-68] a decoded sibling lets the native Option send", () =>
  sends(
    RenamedSibling,
    { held: some, count: 2 },
    `{"held":${jsonPayload},"wire_count":"2"}`,
  ),
);
it.live("[EXT-68] a decoded ancestor lets its native Option send", () =>
  sends(
    RenamedAncestor,
    { group: { held: some } },
    `{"wire_group":{"held":${jsonPayload}}}`,
  ),
);
it.live(
  "[EXT-68] a class with the decoded field lets its native Option send",
  () =>
    sends(
      RenamedClass,
      new Ticket({ held: some }),
      `{"wire_held":${jsonPayload}}`,
    ),
);
it.live(
  "[EXT-68] a list below a decoded ancestor lets its native Option send",
  () =>
    sends(
      RenamedList,
      { group: [{ held: some }] },
      `{"wire_group":[{"held":${jsonPayload}}]}`,
    ),
);

const Owner = Schema.Struct({ owner: Schema.String });
const OwnerWithLimit = Schema.Struct({
  owner: Schema.String,
  limit: Schema.Number,
});
const Filter = Schema.Union([Owner, OwnerWithLimit]);
const draft = Option.some({ owner: "a", limit: 5, stray: "omit" });
const filterJson = '{"owner":"a","limit":5}';
for (const [name, codec] of [
  [
    "configured OptionFromOptionalNullOr",
    Schema.OptionFromOptionalNullOr(Filter, { onNoneEncoding: null }),
  ],
  [
    "union of Option codecs sharing Filter",
    Schema.Union([
      Schema.OptionFromNullOr(Filter),
      Schema.OptionFromUndefinedOr(Filter),
    ]),
  ],
] as const) {
  it.live(`[EXT-69] ${name} keeps limit and drops stray in a field`, () =>
    sends(
      Schema.Struct({ held: codec }),
      { held: draft },
      `{"held":${filterJson}}`,
    ),
  );
  it.live(`[EXT-69] ${name} keeps limit and drops stray in a list`, () =>
    sends(
      Schema.Struct({ held: Schema.Array(codec) }),
      { held: [draft] },
      `{"held":[${filterJson}]}`,
    ),
  );
  it.live(`[EXT-69] ${name} keeps limit and drops stray inside Some`, () =>
    sends(
      Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Struct({ inner: codec })),
      }),
      { held: Option.some({ inner: draft }) },
      `{"held":{"inner":${filterJson}}}`,
    ),
  );
}

const First = Schema.Struct({ a: Schema.optionalKey(Schema.String) });
const Defaulted = Schema.Struct({
  b: Schema.optionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed("default")),
  ),
});
for (const [order, members] of [
  ["optional first", [First, Defaulted]],
  ["defaulted first", [Defaulted, First]],
] as const) {
  it.live(
    `[EXT-70] fieldless oneOf refuses in either member order (${order})`,
    () =>
      refuses(
        Schema.Struct({ held: Schema.Union(members, { mode: "oneOf" }) }),
        { held: {} },
        '["held"]',
        "Expected exactly one member to match",
      ),
  );
}
it.live(
  "[EXT-70] anyOf writes its first fit when two members accept the input",
  () =>
    Effect.gen(function* () {
      const Encoded = Schema.Struct({
        held: First,
        count: Schema.FiniteFromString,
      });
      const Decoded = Schema.Struct({ held: First, count: Schema.Number });
      const input = { held: {}, count: "5" };
      yield* sends(
        Schema.Union([Encoded, Decoded], { mode: "anyOf" }),
        input,
        '{"held":{},"count":"5"}',
      );
      yield* sends(
        Schema.Union([Decoded, Encoded], { mode: "anyOf" }),
        input,
        '{"held":{},"count":5}',
      );
    }),
);

it.live("[EXT-71] a payload's own value survives unwrapping Some", () =>
  sends(
    Schema.Struct({
      held: Schema.OptionFromNullOr(
        Schema.Union([
          Schema.Struct({ value: Schema.Struct({ a: Schema.String }) }),
          Schema.Struct({ owner: Schema.String }),
        ]),
      ),
    }),
    { held: Option.some({ value: { a: "inner" }, a: "outer" }) },
    '{"held":{"value":{"a":"inner"}}}',
  ),
);

it.live(
  "[EXT-72] a stated limit survives in a tagged payload nested in Some and a list",
  () => {
    const Narrow = Schema.Struct({
      kind: Schema.Literal("filter"),
      owner: Schema.String,
    });
    const Wide = Schema.Struct({ ...Narrow.fields, limit: Schema.Number });
    const Tagged = Schema.Union([Narrow, Wide]);
    return sends(
      Schema.Struct({
        held: Schema.OptionFromNullOr(
          Schema.Struct({
            rows: Schema.Array(Schema.OptionFromNullOr(Tagged)),
          }),
        ),
      }),
      {
        held: Option.some({
          rows: [
            Option.some({ kind: "filter" as const, owner: "a", limit: 5 }),
          ],
        }),
      },
      '{"held":{"rows":[{"kind":"filter","owner":"a","limit":5}]}}',
    );
  },
);

const RenamedLimit = Schema.Struct({ limit: Schema.FiniteFromString }).pipe(
  Schema.encodeKeys({ limit: "page_size" }),
);
it.live("[EXT-73] a conflicting alias names both spellings", () =>
  refuses(
    RenamedLimit,
    { limit: 5, page_size: "6" },
    '["page_size"]',
    'This field is given under both "limit" and "page_size"; give it under one name',
  ),
);
it.live(
  "[EXT-73] an invalid decoded name reports its own validation error",
  () =>
    refuses(
      RenamedLimit,
      { limit: "x" },
      '["limit"]',
      'Expected number at ["limit"]',
    ),
);
it.live(
  "[EXT-73] a wire-named value reports its own error beside an unstated key",
  () =>
    refuses(
      RenamedLimit,
      { page_size: "many", stray: "1" },
      '["page_size"]',
      'Expected a finite number at ["page_size"]',
    ),
);

it.live(
  "[EXT-74] a visible Some drops a key stated only by a different tag",
  () => {
    const Tagged = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("owner"), owner: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("capped"), limit: Schema.Number }),
    ]);
    const held = Option.some({ kind: "owner" as const, owner: "a", limit: 5 });
    return sends(
      Schema.Struct({ held: Schema.OptionFromNullOr(Tagged) }),
      { held },
      '{"held":{"kind":"owner","owner":"a"}}',
    );
  },
);

it.live(
  "[EXT-75] a renamed configured Option keeps a wider list member beside a class instance",
  () => {
    class Marker extends Schema.Class<Marker>("Marker")({ id: Schema.String }) {
      readonly reads = 1;
    }
    const MarkerOrPlain = Schema.Union([Fields, Marker]);
    const HeldRows = Schema.OptionFromOptionalNullOr(Schema.Array(Filter), {
      onNoneEncoding: null,
    });
    const RequestBody = Schema.Struct({
      marker: MarkerOrPlain,
      held: HeldRows,
    }).pipe(Schema.encodeKeys({ held: "wire_held" }));
    return sends(
      RequestBody,
      {
        marker: new Marker({ id: "m" }),
        held: Option.some([{ owner: "a", limit: 5 }]),
      },
      `{"marker":{"id":"m"},"wire_held":[${filterJson}]}`,
    );
  },
);

for (const mode of ["anyOf", "oneOf"] as const) {
  const BodyWithOpaque = Schema.Struct({
    f: Schema.Union([Schema.Struct({ c: Schema.String }), Schema.Unknown], {
      mode,
    }),
    o: Schema.Option(Schema.Struct({ a: Schema.String })),
  });
  for (const [label, opaque] of [
    ["clean", { a: "x" }],
    ["with an unstated key", { a: "x", extra: 1 }],
  ] as const) {
    it.live(
      `[EXT-76] ${mode} writes an all-undefined field beside an opaque Option ${label}`,
      () =>
        sends(
          BodyWithOpaque,
          { f: { limit: undefined }, o: Option.some(opaque) },
          '{"f":{},"o":{"_tag":"Some","value":{"a":"x"}}}',
        ),
    );
  }
}

it.live(
  "[EXT-77] a class with renamed keys writes through its own member beside a narrower struct",
  () => {
    class Counted extends Schema.Class<Counted>("Counted")({
      a: Schema.String,
    }) {
      readonly reads = 1;
    }
    const RenamedCounted = Counted.pipe(Schema.encodeKeys({ a: "A" }));
    const LimitOnly = Schema.Struct({
      limit: Schema.optionalKey(Schema.Number),
    });
    return sends(
      Schema.Struct({
        item: Schema.Union([LimitOnly, RenamedCounted]),
      }),
      { item: new Counted({ a: "item" }) },
      '{"item":{"A":"item"}}',
    );
  },
);
