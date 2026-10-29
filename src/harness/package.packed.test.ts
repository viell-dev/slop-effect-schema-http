// Runs only in the packed project (`npm run packed:test`), where `npm run library:pack` has
// installed the packed library into node_modules, and only `tsconfig.packed.json` type-checks it:
// the subpath imports below resolve only through the installed package's `exports` map. It needs
// Node to locate the installed files with Node's own resolver.
import { createRequire } from "node:module";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Library from "viell-effect-schema-http";
import type * as Body from "viell-effect-schema-http/Body";
import type * as Interaction from "viell-effect-schema-http/Interaction";
import type * as Operation from "viell-effect-schema-http/Operation";
import type * as Policy from "viell-effect-schema-http/Policy";
import type * as Request from "viell-effect-schema-http/Request";
import type * as Response from "viell-effect-schema-http/Response";
import type * as Transport from "viell-effect-schema-http/Transport";
import type * as UrlEncoding from "viell-effect-schema-http/UrlEncoding";

const LIBRARY = "viell-effect-schema-http";
const require = createRequire(import.meta.url);

/** The modules the suite uses: each is a namespace of the root and its own subpath export. */
const modules = [
  "Body",
  "Interaction",
  "Operation",
  "Policy",
  "Request",
  "Response",
  "Transport",
  "UrlEncoding",
];

/** The installed package.json, read through the package's own `./package.json` export. */
const manifest: { name: string; exports: Record<string, unknown> } = require(
  `${LIBRARY}/package.json`,
);
const listed = Object.keys(manifest.exports);

const root: Record<string, unknown> = Library;

describe(`${LIBRARY} as packed and installed`, () => {
  it("resolves from node_modules, and the suite's imports load that copy", async () => {
    const main = require.resolve(LIBRARY);
    expect(main.split(sep).join("/")).toContain(
      `/node_modules/${LIBRARY}/dist/`,
    );
    expect(await import(pathToFileURL(main).href)).toBe(Library);
  });

  it("exports the root, its package.json and one subpath per module the suite uses", () => {
    expect(manifest.name).toBe(LIBRARY);
    expect(Object.keys(Library).toSorted()).toEqual(modules);
    expect(listed.toSorted()).toEqual(
      [".", "./package.json", ...modules.map((name) => `./${name}`)].toSorted(),
    );
  });

  it.each(listed)(
    "the listed export %s loads at run time as what the suite expects",
    async (subpath) => {
      const specifier = `${LIBRARY}${subpath.slice(1)}`;
      if (subpath === ".") {
        expect(await import(specifier)).toBe(Library);
        return;
      }
      if (subpath === "./package.json") {
        expect(require(specifier)).toBe(manifest);
        return;
      }
      const name = subpath.slice(2);
      expect(modules).toContain(name);
      const loaded: Record<string, unknown> = await import(specifier);
      // The subpath is the very module the root re-exports, not a second copy of it.
      expect(loaded).toBe(root[name]);
      expect(Object.keys(loaded).length).toBeGreaterThan(0);
    },
  );

  it("declares each subpath export as the root's namespace", () => {
    expectTypeOf<typeof Body>().toEqualTypeOf<typeof Library.Body>();
    expectTypeOf<typeof Interaction>().toEqualTypeOf<
      typeof Library.Interaction
    >();
    expectTypeOf<typeof Operation>().toEqualTypeOf<typeof Library.Operation>();
    expectTypeOf<typeof Policy>().toEqualTypeOf<typeof Library.Policy>();
    expectTypeOf<typeof Request>().toEqualTypeOf<typeof Library.Request>();
    expectTypeOf<typeof Response>().toEqualTypeOf<typeof Library.Response>();
    expectTypeOf<typeof Transport>().toEqualTypeOf<typeof Library.Transport>();
    expectTypeOf<typeof UrlEncoding>().toEqualTypeOf<
      typeof Library.UrlEncoding
    >();
  });
});
