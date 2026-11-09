import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, flow, identity } from "effect";
import { HttpClient } from "effect/http";
import {
  api,
  Audit,
  compileOnly,
  type Failures,
  firstFive,
  found,
  getThings,
  gone,
  missing,
  NotFound,
  option,
  OptionPage,
  page,
  pagedThings,
  Problem,
  reply,
  retryTwice,
  search,
  type Services,
  type Success,
  Thing,
  thing,
  ThingOption,
  ThingPage,
  things,
  urlsOf,
  withoutPaging,
} from "../../test/operation.js";
import { json, synthetic } from "../../test/support.js";
import * as Interaction from "../concurrency/Interaction.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const idAndNameOnly = Request.setQuery({ limit: "all", fields: "id,name" });

const dropdownReply = () => json(200, page([option(1)]));

const firstOf = <T>(list: ReadonlyArray<T>) => list[0];

const dataOf = (value: typeof ThingPage.Type) => value.data;

const listThings = (pageNumber: number) =>
  getThings.pipe(Operation.mapRequest(Request.setQuery({ page: pageNumber })));

const inList = <I, A, E, R>(operation: Operation.Operation<I, A, E, R>) =>
  operation.pipe(Operation.map((value) => [value] as const));

const withTenant = <B, I, E, R, S, O, T>(
  operation: Operation.Derived<B, Request.Request<I, E, R>, S, O, T>,
) => operation.pipe(Operation.mapRequest(Request.setHeader("x-tenant", "a")));

describe("a contract's type", () => {
  it("refuses a conditional between two contracts, and takes one status", () => {
    const legacy = false as boolean;
    const either = legacy
      ? Response.status(200, Body.text)
      : Response.status(201, Body.text);
    compileOnly(() => {
      // @ts-expect-error each contract names its own case, so a union of them is not one contract
      Operation.make(Request.get("/"), either);
    });
    const chosen = Response.status(legacy ? 200 : 201, Body.text);
    expect(Operation.make(Request.get("/"), chosen).parts?.response).toBe(
      chosen,
    );
  });
});

describe("operations with no parts", () => {
  const local = Operation.fromEffect((id: number) =>
    Effect.succeed({ data: [id] }),
  ).pipe(Operation.map((value) => value.data));

  it.effect("map and mapEffect wrap them, as they always did", () =>
    Effect.gen(function* () {
      const failing = local.pipe(
        Operation.mapEffect((list) =>
          list.length > 1
            ? Effect.succeed(list)
            : Effect.fail("short" as const),
        ),
      );
      expect(yield* local.execute(7)).toEqual([7]);
      expect(yield* Effect.flip(failing.execute(7))).toBe("short");
      expect("parts" in local).toBe(false);
      expect("parts" in failing).toBe(false);
    }),
  );

  it("cannot be adjusted, and say so clearly past the types", () => {
    compileOnly(() => {
      // @ts-expect-error a value from fromEffect has no request to adjust
      local.pipe(Operation.mapRequest(firstFive));
      // @ts-expect-error nor a response
      local.pipe(Operation.mapResponse(Response.remove(200)));
      // @ts-expect-error nor options
      local.pipe(Operation.mapOptions(() => ({})));
      // @ts-expect-error nor a step to remove
      local.pipe(Operation.unmap);
    });
    const forced = Operation.unmap as (self: unknown) => unknown;
    expect(() => forced(local)).toThrow("no parts");
  });

  it.effect(
    "sealing with fromEffect keeps the types and removes the parts",
    () =>
      Effect.gen(function* () {
        const server = synthetic(reply);
        const sealed = Operation.fromEffect(getThings.execute);
        expect("parts" in sealed).toBe(false);
        expectTypeOf<Success<typeof sealed>>().toEqualTypeOf<
          Success<typeof getThings>
        >();
        expectTypeOf<Failures<typeof sealed>>().toEqualTypeOf<
          Failures<typeof getThings>
        >();
        compileOnly(() => {
          // @ts-expect-error sealing removes the parts
          sealed.pipe(Operation.mapRequest(firstFive));
        });
        expect(
          yield* sealed.execute(undefined).pipe(Effect.provide(server.layer)),
        ).toEqual(things);
        expect(
          yield* sealed
            .pipe(Operation.map((list) => list.length))
            .execute(undefined)
            .pipe(Effect.provide(server.layer)),
        ).toBe(2);
      }),
  );

  it("a plain annotation seals at compile time", () => {
    const annotated: Operation.Operation<undefined, unknown, unknown, unknown> =
      getThings;
    const asOptions = Response.replace(200, Body.jsonSchema(OptionPage));
    compileOnly(() => {
      // @ts-expect-error the annotation hides the parts
      annotated.pipe(Operation.mapRequest(firstFive));
      // @ts-expect-error a widened result is refused too
      annotated.pipe(Operation.mapResponse(asOptions));
    });
  });

  it.effect("an exported function offers part of a definition", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      yield* listThings(2)
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(urlsOf(server)).toEqual([
        "https://api.example.test/v1/things?page=2&limit=25",
      ]);
    }),
  );
});

describe("reading and using a variant", () => {
  it("reads a part with operation.parts", () => {
    const request = Request.get("/things").pipe(api);
    const response = Response.status(200, Body.jsonSchema(ThingPage));
    const options = { policy: retryTwice };
    const operation = Operation.make(request, response, options);
    expect(operation.parts?.request).toBe(request);
    expect(operation.parts?.response).toBe(response);
    expect(operation.parts?.options).toBe(options);
    expect(operation.parts?.step).toBeUndefined();

    const mapped = operation.pipe(Operation.map((value) => value.total));
    expect(mapped.parts?.request).toBe(request);
    expect(mapped.parts?.step).toBeDefined();
    expect(mapped.pipe(Operation.unmap).parts?.step).toBeUndefined();
    expect(pagedThings.parts?.options).toBeUndefined();
  });

  it.effect("stays an Operation for code that knows nothing of parts", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const variant = getThings.pipe(Operation.mapRequest(firstFive));
      const plain: Operation.Operation<
        undefined,
        Success<typeof variant>,
        Failures<typeof variant>,
        HttpClient.HttpClient
      > = variant;
      expect(
        yield* Operation.execute(plain, undefined).pipe(
          Effect.provide(server.layer),
        ),
      ).toEqual(things);
      expect(
        yield* variant.pipe(
          Operation.execute(undefined),
          Effect.provide(server.layer),
        ),
      ).toEqual(things);
    }),
  );

  it.effect("works in an interaction", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const variant = getThings.pipe(Operation.mapRequest(firstFive));
      const result = yield* Effect.gen(function* () {
        const interaction = yield* Interaction.make(variant.execute);
        return yield* interaction.run(undefined);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
      expect(result).toEqual(things);
    }),
  );
});

describe("ways to write a variant", () => {
  const dropdownUrl =
    "https://api.example.test/v1/things?limit=all&fields=id%2Cname";
  const asOptions = Response.replace(200, Body.jsonSchema(OptionPage));

  it.effect("names each transform and maps once per change", () =>
    Effect.gen(function* () {
      const server = synthetic(dropdownReply);
      const thingOptions = pagedThings.pipe(
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapResponse(asOptions),
        Operation.map((value) => value.data),
      );
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expect(urlsOf(server)).toEqual([dropdownUrl]);
      expectTypeOf<Success<typeof thingOptions>>().toEqualTypeOf<
        ReadonlyArray<typeof ThingOption.Type>
      >();
    }),
  );

  it.effect("goes through unmap from a mapped definition", () =>
    Effect.gen(function* () {
      const server = synthetic(dropdownReply);
      const thingOptions = getThings.pipe(
        Operation.unmap,
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
        Operation.mapResponse(asOptions),
        Operation.map((value) => value.data),
      );
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expect(urlsOf(server)).toEqual([dropdownUrl]);
    }),
  );

  it.effect("reuses one generic mapping before and after a new shape", () =>
    Effect.gen(function* () {
      const dataOrNotFound = <D>(
        result:
          | Response.Tagged<"Found", { readonly data: D }>
          | Response.Tagged<"Missing", typeof Problem.Type>,
      ) =>
        result._tag === "Found"
          ? Effect.succeed(result.value.data)
          : Effect.fail(new NotFound({ detail: result.value.detail }));

      const definition = Operation.make(
        Request.get("/things?page=1&limit=25").pipe(api),
        found.pipe(Response.orElse(missing)),
      ).pipe(Operation.mapEffect(dataOrNotFound));

      const taggedOptions = Response.replace(
        200,
        Response.tag("Found", Body.jsonSchema(OptionPage)),
      );
      const thingOptions = definition.pipe(
        Operation.unmap,
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapResponse(taggedOptions),
        Operation.mapEffect(dataOrNotFound),
      );

      const server = synthetic(dropdownReply);
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expectTypeOf<Success<typeof thingOptions>>().toEqualTypeOf<
        ReadonlyArray<typeof ThingOption.Type>
      >();
      expectTypeOf<NotFound>().toExtend<Failures<typeof thingOptions>>();

      const notFound = synthetic(gone);
      expect(
        yield* Effect.flip(
          thingOptions.execute(undefined).pipe(Effect.provide(notFound.layer)),
        ),
      ).toBeInstanceOf(NotFound);
    }),
  );

  it.effect(
    "defines one composed function with flow, or a named function",
    () =>
      Effect.gen(function* () {
        const composed = flow(withoutPaging, idAndNameOnly);
        const named = <I, E, R>(request: Request.Request<I, E, R>) =>
          request.pipe(withoutPaging, idAndNameOnly);
        for (const variant of [
          pagedThings.pipe(Operation.mapRequest(composed)),
          pagedThings.pipe(Operation.mapRequest(named)),
        ]) {
          const server = synthetic(reply);
          yield* variant.execute(undefined).pipe(Effect.provide(server.layer));
          expect(urlsOf(server)).toEqual([dropdownUrl]);
        }
      }),
  );

  it.effect("composes maps with flow, which stays adjustable", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const toCount = flow(
        Operation.map((value: typeof ThingPage.Type) => value.data),
        Operation.map((list) => list.length),
      );
      const composed = pagedThings.pipe(toCount);
      const variant = composed.pipe(Operation.mapRequest(firstFive));
      expect(
        yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe(2);
      expectTypeOf<Success<typeof variant>>().toEqualTypeOf<number>();
    }),
  );

  it.effect("takes a generic function in map", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const firstThing = getThings.pipe(Operation.map(firstOf));
      expect(
        yield* firstThing
          .pipe(Operation.mapRequest(firstFive))
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual(thing(1));
      expectTypeOf<Success<typeof firstThing>>().toEqualTypeOf<
        typeof Thing.Type | undefined
      >();
    }),
  );

  it.effect("holds a map in a variable", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const toData = Operation.map(
        (value: typeof ThingPage.Type) => value.data,
      );
      const held = pagedThings.pipe(toData);
      const variant = held.pipe(Operation.mapRequest(firstFive));
      expect(
        yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(things);
    }),
  );

  it("holds a mapOptions that does not read the options in a variable", () => {
    const noRetries = Operation.mapOptions(() => ({ policy: Policy.none }));
    const variant = pagedThings.pipe(noRetries);
    expect(variant.parts?.options?.policy).toBe(Policy.none);
    expectTypeOf<
      Services<typeof variant>
    >().toEqualTypeOf<HttpClient.HttpClient>();
  });

  it.effect("flows once the first function names the operation", () =>
    Effect.gen(function* () {
      const forDropdown = flow(
        identity<typeof getThings>,
        Operation.unmap,
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
        Operation.mapResponse(asOptions),
        Operation.map((value) => value.data),
      );
      const server = synthetic(dropdownReply);
      expect(
        yield* forDropdown(getThings)
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expect(urlsOf(server)).toEqual([dropdownUrl]);
      expectTypeOf<Success<ReturnType<typeof forDropdown>>>().toEqualTypeOf<
        ReadonlyArray<typeof ThingOption.Type>
      >();
    }),
  );

  it("keeps the fit rule in a flow that names the operation", () => {
    compileOnly(() => {
      flow(
        identity<typeof getThings>,
        // @ts-expect-error the mapping was not written for this response
        Operation.mapResponse(asOptions),
      );
    });
  });

  it("names the operation in a function, which addresses cases as pipe does", () => {
    const withoutServer = (operation: typeof search) =>
      operation.pipe(
        Operation.mapRequest(firstFive),
        Operation.mapResponse(Response.remove("server")),
      );
    expectTypeOf<Success<ReturnType<typeof withoutServer>>>().toEqualTypeOf<
      Success<typeof search>
    >();
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/125
  it("refuses flow over the adjustment functions with no operation", () => {
    const unwrapped = Operation.map(dataOf);
    const noServer = Response.remove("server");
    compileOnly(() => {
      // @ts-expect-error the mapping needs a result the flow does not know yet
      flow(Operation.mapRequest(firstFive), unwrapped);
      // @ts-expect-error the same after unmap, and the response has no known cases
      flow(Operation.unmap, Operation.mapResponse(asOptions), unwrapped);
      // @ts-expect-error there are no options yet to spread
      flow(Operation.mapOptions((o) => ({ ...o, policy: retryTwice })));
      // @ts-expect-error a key and the fit rule need a known operation
      flow(Operation.mapRequest(firstFive), Operation.mapResponse(noServer));
    });
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/125
  it("cannot address a case from a function generic in the cases", () => {
    compileOnly(
      <A, E, R, C extends Response.AnyCase>(
        response: Response.Response<A, E, R, C>,
      ) => {
        // @ts-expect-error a key needs a known contract
        response.pipe(Response.remove(404));
      },
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/125
  it("needs the pipe around a generic transform to infer its types", () => {
    const held = Operation.mapRequest(firstFive);
    const variant = pagedThings.pipe(held);
    expectTypeOf<Services<typeof variant>>().toEqualTypeOf<unknown>();

    const inPipe = pagedThings.pipe(Operation.mapRequest(firstFive));
    expectTypeOf<
      Services<typeof inPipe>
    >().toEqualTypeOf<HttpClient.HttpClient>();

    compileOnly(() => {
      // @ts-expect-error held on its own, the transform has no contract to read keys from
      Operation.mapResponse(asOptions);
    });
  });

  it.effect("writes an arrow function in place", () =>
    Effect.gen(function* () {
      const server = synthetic(dropdownReply);
      const thingOptions = pagedThings.pipe(
        Operation.mapRequest((request) =>
          request.pipe(withoutPaging, idAndNameOnly),
        ),
        Operation.mapResponse((response) => response.pipe(asOptions)),
      );
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual(page([option(1)]));
      expect(urlsOf(server)).toEqual([dropdownUrl]);
    }),
  );

  it.effect("uses Effect.gen in mapEffect", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const counted = getThings.pipe(
        Operation.mapEffect((list) =>
          Effect.gen(function* () {
            const size = yield* Effect.succeed(list.length);
            return size * 2;
          }),
        ),
        Operation.mapRequest(firstFive),
      );
      expect(
        yield* counted.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe(4);
      expectTypeOf<Success<typeof counted>>().toEqualTypeOf<number>();
    }),
  );

  it.effect("uses Effect.fn in mapEffect", () =>
    Effect.gen(function* () {
      const counts: Array<number> = [];
      const server = synthetic(reply);
      const audit = Effect.fn("audit")(function* (
        list: ReadonlyArray<typeof Thing.Type>,
      ) {
        const service = yield* Audit;
        yield* service.record(list.length);
        return list.length;
      });
      const audited = getThings.pipe(
        Operation.mapEffect(audit),
        Operation.mapRequest(firstFive),
      );
      expectTypeOf<Audit>().toExtend<Services<typeof audited>>();
      expect(
        yield* audited.execute(undefined).pipe(
          Effect.provide(server.layer),
          Effect.provideService(Audit, {
            record: (count) => Effect.sync(() => void counts.push(count)),
          }),
        ),
      ).toBe(2);
      expect(counts).toEqual([2]);
    }),
  );

  it.effect("runs a generic helper over the plain type", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const helped = inList(getThings);
      expect(
        yield* helped.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual([things]);
      expectTypeOf<Success<typeof helped>>().toEqualTypeOf<
        readonly [Success<typeof getThings>]
      >();
      compileOnly(() => {
        // @ts-expect-error the plain parameter hides the parts, and the result stays plain
        helped.pipe(Operation.mapRequest(firstFive));
      });
    }),
  );

  it.effect(
    "runs a generic helper over the parts, which stays adjustable",
    () =>
      Effect.gen(function* () {
        const server = synthetic(reply);
        const tenanted = withTenant(getThings).pipe(
          Operation.mapRequest(firstFive),
        );
        expect(
          yield* tenanted.execute(undefined).pipe(Effect.provide(server.layer)),
        ).toEqual(things);
        expect(server.exchanges[0]?.request.headers["x-tenant"]).toBe("a");
      }),
  );
});
