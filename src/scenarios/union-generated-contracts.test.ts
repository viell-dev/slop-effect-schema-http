/**
 * EXT-37: consumer-authored coverage of generated fields through closed unions.
 * Acceptance: https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6727350120
 * Uses only the public API, the README's echo contract and observed physical wire records.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaGetter } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

type Group = "query" | "headers";
type GroupSchema = Schema.Top &
  Schema.ConstraintCodec<
    unknown,
    Readonly<Record<string, string>>,
    never,
    never
  >;
const secret = "hidden-edit";
const empty = function* (): Generator<readonly [string, string]> {};
const at = (origin: string) => Request.get(`${origin}/x`);
const wireName = (group: Group) =>
  group === "query" ? "page_size" : "X-Page-Size";
const fields = () => ({
  limit: Schema.optionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed("25")),
  ),
  other: Schema.optionalKey(Schema.String),
});
const renamed = (group: Group) =>
  Schema.Struct(fields()).pipe(Schema.encodeKeys({ limit: wireName(group) }));
const bind =
  (group: Group, schema: GroupSchema) =>
  <I, E, R>(
    self: Request.Request<I, E, R>,
  ): Request.Request<
    never,
    E | Schema.SchemaError | Request.InvalidRequest,
    R
  > =>
    group === "query"
      ? Request.query(schema)(self)
      : Request.headers(schema)(self);
const edit = (
  group: Group,
  kind: "set" | "append" | "remove",
  name = wireName(group),
) => {
  if (group === "query") {
    return kind === "set"
      ? Request.setQuery(name, secret)
      : kind === "append"
        ? Request.appendQuery(name, secret)
        : Request.removeQuery(name);
  }
  return kind === "set"
    ? Request.setHeader(name, secret)
    : kind === "append"
      ? Request.appendHeader(name, secret)
      : Request.removeHeader(name);
};
const input = (group: Group, value: unknown) => ({ [group]: value });
const run = <E>(
  build: (origin: string) => Request.Request<never, E>,
  value: unknown,
) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(
      build(backend.origin),
      Response.status(404, Body.text),
    )
      .execute(value as never)
      .pipe(
        Effect.provide(lane.fetchClient),
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (response) => ({ response }),
        }),
      );
    return { result, ledger: yield* backend.ledger };
  });
type Result = {
  readonly result: { readonly error: unknown } | { readonly response: string };
  readonly ledger: ReadonlyArray<Recorded>;
};
const refused = (result: Result, name: string) => {
  expect(result.ledger).toEqual([]);
  expect(result.result).toHaveProperty("error");
  const error = "error" in result.result ? result.result.error : undefined;
  expect(error).toBeInstanceOf(Request.InvalidRequest);
  expect(String(error)).toContain(JSON.stringify(name.toLowerCase()));
  expect(String(error)).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain(secret);
};
const sent = (
  result: Result,
  group: Group,
  entries: ReadonlyArray<readonly [string, string]>,
) => {
  expect(result.result).toEqual({ response: "Not Found" });
  expect(result.ledger).toHaveLength(1);
  const record = result.ledger[0]!;
  const target =
    group === "query" && entries.length
      ? `/x?${entries.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&")}`
      : "/x";
  expect(record.method).toBe("GET");
  expect(record.target).toBe(target);
  expect(record.head).toContain(`GET ${target} HTTP/1.1\r\n`);
  expect(record.body.byteLength).toBe(0);
  expect(headerValues(record.lines, "accept")).toEqual(["text/plain"]);
  if (group === "headers") {
    const names = new Set(["limit", "other", "x-page-size", "page_size"]);
    expect(
      record.lines.filter(([name]) => names.has(name.toLowerCase())).length,
    ).toBe(entries.length);
    for (const [name, value] of entries)
      expect(headerValues(record.lines, name)).toEqual([value]);
  }
};

describe(`generated fields through request unions (${lane.name})`, () => {
  for (const group of ["query", "headers"] as const) {
    for (const [kind, shape] of [
      ["set", "singleton"],
      ["append", "two members"],
      ["remove", "nested reversed"],
    ] as const) {
      it.live(
        `[EXT-37a] ${group}: a closed ${shape} union refuses a later ${kind} of a renamed generated field`,
        () =>
          Effect.gen(function* () {
            const member = renamed(group);
            const other = Schema.Struct({ different: Schema.String });
            const choice =
              shape === "singleton"
                ? Schema.Union([member])
                : shape === "two members"
                  ? Schema.Union([member, other])
                  : Schema.Union([other, Schema.Union([other, member])]);
            const value =
              kind === "append" ? (Object.create(null) as object) : {};
            const result = yield* run(
              (origin) =>
                at(origin).pipe(bind(group, choice), edit(group, kind)),
              input(group, value),
            );
            refused(result, wireName(group));
          }),
      );
    }

    it.live(
      `[EXT-37b] ${group}: an untransformed closed union protects an omitted exact-name field beside supplied input`,
      () =>
        Effect.gen(function* () {
          const choice = Schema.Union([
            Schema.Struct(fields()),
            Schema.Struct({ different: Schema.String }),
          ]);
          const result = yield* run(
            (origin) =>
              at(origin).pipe(bind(group, choice), edit(group, "set", "limit")),
            input(group, { other: "x" }),
          );
          refused(result, "limit");
        }),
    );

    it.live(
      `[EXT-37c] control: ${group} explicit decoded and encoded aliases choose the outgoing value`,
      () =>
        Effect.gen(function* () {
          for (const alias of ["limit", wireName(group)]) {
            const result = yield* run(
              (origin) =>
                at(origin).pipe(
                  bind(group, Schema.Union([renamed(group)])),
                  edit(group, "set"),
                ),
              input(group, { [alias]: "7" }),
            );
            sent(result, group, [[wireName(group), "7"]]);
          }
        }),
    );

    it.live(
      `[EXT-37d] control: ${group} pre-binding defaults and unbind retain their established behavior`,
      () =>
        Effect.gen(function* () {
          const choice = Schema.Union([renamed(group)]);
          const before = yield* run(
            (origin) =>
              at(origin).pipe(edit(group, "set"), bind(group, choice)),
            {},
          );
          sent(before, group, [[wireName(group), "25"]]);
          const unbound = yield* run(
            (origin) =>
              at(origin).pipe(
                bind(group, choice),
                Request.unbind(group),
                edit(group, "set"),
              ),
            {},
          );
          sent(unbound, group, [[wireName(group), secret]]);
        }),
    );

    it.live(
      `[EXT-37e] limit: a nonempty renamed ${group} union still replaces the later raw edit`,
      () =>
        Effect.gen(function* () {
          const result = yield* run(
            (origin) =>
              at(origin).pipe(
                bind(group, Schema.Union([renamed(group)])),
                edit(group, "set"),
              ),
            input(group, { other: "x" }),
          );
          sent(result, group, [
            [wireName(group), "25"],
            ["other", "x"],
          ]);
        }),
    );

    it.live(
      `[EXT-37f] limit: open, declared, suspended and class alternatives disable the empty ${group} extension`,
      () =>
        Effect.gen(function* () {
          const opaque = Schema.declare(
            (value): value is Readonly<Record<string, string>> =>
              typeof value === "object" && value !== null,
          );
          class Other extends Schema.Class<Other>(`Other-${group}`)({
            different: Schema.String,
          }) {}
          for (const alternative of [
            Schema.Record(Schema.String, Schema.String),
            opaque,
            Schema.suspend(() => Schema.Struct({ different: Schema.String })),
            Other,
          ]) {
            const choice = Schema.Union([renamed(group), alternative]);
            const result = yield* run(
              (origin) =>
                at(origin).pipe(bind(group, choice), edit(group, "set")),
              {},
            );
            sent(result, group, [[wireName(group), "25"]]);
          }
        }),
    );

    it.live(
      `[EXT-37g] control: ${group} unions require actual output and honor iterable entries`,
      () =>
        Effect.gen(function* () {
          const iterator = Schema.declare(
            (value): value is typeof empty => typeof value === "function",
          );
          const iterable = Schema.Struct({
            ...fields(),
            [Symbol.iterator]: iterator.pipe(
              Schema.withConstructorDefault(Effect.succeed(empty)),
            ),
          }).pipe(Schema.encodeKeys({ limit: wireName(group) }));
          const result = yield* run(
            (origin) =>
              at(origin).pipe(
                bind(group, Schema.Union([iterable])),
                edit(group, "remove"),
              ),
            {},
          );
          sent(result, group, []);
          const absent = Schema.Struct({
            limit: Schema.optionalKey(Schema.String),
          }).pipe(Schema.encodeKeys({ limit: wireName(group) }));
          const raw = yield* run(
            (origin) =>
              at(origin).pipe(
                bind(group, Schema.Union([absent])),
                edit(group, "set"),
              ),
            {},
          );
          sent(raw, group, [[wireName(group), secret]]);
        }),
    );

    it.live(
      `[EXT-37h] ${group}: generated-field refusal adds no constructor or field-codec callbacks`,
      () =>
        Effect.gen(function* () {
          const trace: string[] = [];
          const field = Schema.optionalKey(
            Schema.String.pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.transform((value) => {
                  trace.push(`decode:${value}`);
                  return value;
                }),
                encode: SchemaGetter.transform((value) => {
                  trace.push(`encode:${value}`);
                  return value;
                }),
              }),
            ),
          ).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                trace.push("default");
                return "25";
              }),
            ),
          );
          const choice = Schema.Union([
            Schema.Struct({ limit: field }).pipe(
              Schema.encodeKeys({ limit: wireName(group) }),
            ),
          ]);
          const ordinary = yield* run(
            (origin) => at(origin).pipe(bind(group, choice)),
            {},
          );
          sent(ordinary, group, [[wireName(group), "25"]]);
          const original = [...trace];
          expect(original).toContain("default");
          expect(original).toContain("encode:25");
          trace.length = 0;
          const result = yield* run(
            (origin) =>
              at(origin).pipe(bind(group, choice), edit(group, "remove")),
            {},
          );
          expect(trace).toEqual(original);
          refused(result, wireName(group));
        }),
    );

    it.live(
      `[EXT-37i] ${group}: raw name comparison preserves query spelling and folds header case`,
      () =>
        Effect.gen(function* () {
          const name = wireName(group).toUpperCase();
          const choice = Schema.Union([renamed(group)]);
          // An optional field explicitly allows the differently spelled query key.
          const schema =
            group === "query"
              ? Schema.Union([
                  Schema.Struct({
                    ...fields(),
                    PAGE_SIZE: Schema.optionalKey(Schema.String),
                  }).pipe(Schema.encodeKeys({ limit: wireName(group) })),
                ])
              : choice;
          const result = yield* run(
            (origin) =>
              at(origin).pipe(bind(group, schema), edit(group, "set", name)),
            {},
          );
          if (group === "headers") refused(result, wireName(group));
          else
            sent(result, group, [
              [wireName(group), "25"],
              [name, secret],
            ]);
        }),
    );

    it.live(
      `[EXT-37j] control: invalid ${group} input keeps its original schema failure and never dispatches`,
      () =>
        Effect.gen(function* () {
          const choice = Schema.Union([renamed(group)]);
          const result = yield* run(
            (origin) =>
              at(origin).pipe(bind(group, choice), edit(group, "set")),
            input(group, { limit: 123 }),
          );
          expect(result.ledger).toEqual([]);
          expect(result.result).toHaveProperty("error");
          const error =
            "error" in result.result ? result.result.error : undefined;
          expect(error).toMatchObject({ _tag: "SchemaError" });
          expect(String(error)).toContain('"limit"');
          expect(String(error)).not.toContain(secret);
        }),
    );
  }
});
