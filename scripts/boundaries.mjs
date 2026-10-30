// Check the boundaries between backends and the consumer side: the imports, by resolving every
// import (static, type-only, re-export, dynamic and `require`) with the TypeScript parser, and the
// service pages, which the consumer side is written from instead of the backends' source. Runs in
// `npm run check`; Oxlint's no-restricted-imports rules flag the common cases in an editor, but
// match specifier text only, so this script is the enforced allowlist.
// `scripts/boundaries.test.mjs` runs it against generated fixture trees.
//
// - A backend (`src/backends/**`) may import only Node built-ins, modules inside `src/backends/`,
//   and `src/harness/server.ts` or `src/harness/route.ts`. Packages, the library, `#lane`, other
//   harness modules and the consumer side are refused, so a backend stays a black box reached only
//   over HTTP.
// - Consumer code and scenarios (`src/clients`, `src/values`, `src/formats`, `src/scenarios`, and
//   the single-page app in `src/app`) may not import a backend, a Node-side harness module or the
//   conformance tests: of the harness, only `src/harness/lane.ts` and the `#lane` alias are theirs.
//   Outside `*.node.test.ts` files they may not import Node built-ins either, because they also run
//   in a browser.
// - The conformance tests (`src/conformance`), which hold backends to recordings of real software,
//   are backend-side and Node-only: they reach backends over HTTP through the lane, and import
//   neither a backend, a Node-side harness module, nor consumer code.
// - Every backend entry point (`src/backends/<name>.ts` or `src/backends/<name>/index.ts`, the
//   files the harness loads by name) carries a `Service documentation: services/<page>.md` line,
//   except the harness's own `echo` helper. Every such line in a backend names an existing page,
//   with its exact spelling, so a link that works on Windows does not break on Linux.
//
// Each specifier is resolved before it is classified, in this order:
//
// - a relative or absolute specifier to a source file, the way TypeScript's NodeNext finds it;
// - `#lane` to the lane, which each Vitest project aliases to its own implementation, and
//   `viell-effect-schema-http` to the library under test;
// - a Node built-in to itself;
// - any other specifier through `tsconfig.json` `paths` and, for `#…`, `package.json` `imports`, to
//   every existing file or bare specifier that any condition or fallback names; a `#…` specifier
//   that resolves to nothing is refused rather than accepted;
// - what remains is a package, which must be a declared dependency.
//
// `tsconfig.packed.json`, the packed lane's configuration, must have tsconfig.json's aliases
// without the library's, so this one resolution holds for both.
//
// Usage: `node scripts/boundaries.mjs [root]`; the root defaults to this repository.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

const LIBRARY = "viell-effect-schema-http";
const LANE = "#lane";

const root = realpathSync.native(
  resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url))),
);
const src = join(root, "src");
const backends = join(src, "backends");
const harness = join(src, "harness");
const consumer = ["clients", "values", "formats", "scenarios", "app"].map(
  (name) => join(src, name),
);
const conformance = join(src, "conformance");
const backendHarness = new Set(
  ["server.ts", "route.ts"].map((name) => join(harness, name)),
);
const consumerHarness = new Set([join(harness, "lane.ts")]);

const show = (path) => relative(root, path).split(sep).join("/");
const inside = (directory, path) => path.startsWith(directory + sep);

const problems = [];

// The aliases and dependencies the specifiers are resolved against.
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const imports = manifest.imports ?? {};
const dependencies = new Set(
  [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ].flatMap((field) => Object.keys(manifest[field] ?? {})),
);
const tsconfig = ts.readConfigFile(
  join(root, "tsconfig.json"),
  ts.sys.readFile,
);
if (tsconfig.error !== undefined) {
  console.error(
    `tsconfig.json: ${ts.flattenDiagnosticMessageText(tsconfig.error.messageText, "\n")}`,
  );
  process.exit(1);
}
if (tsconfig.config.extends !== undefined)
  problems.push(
    "tsconfig.json: extends another configuration, whose paths this check does not follow",
  );
const compilerOptions = tsconfig.config.compilerOptions ?? {};
const paths = compilerOptions.paths ?? {};
const pathsBase = resolve(root, compilerOptions.baseUrl ?? ".");

// The packed lane type-checks with tsconfig.packed.json, which drops the library's alias so that
// `viell-effect-schema-http` resolves to the installed package. This check classifies the library
// before any alias, so it holds for both configurations only while every other alias is the same:
// read the packed one as TypeScript does, following `extends`, and refuse any other difference.
const packedConfig = join(root, "tsconfig.packed.json");
if (existsSync(packedConfig)) {
  const packed = ts.getParsedCommandLineOfConfigFile(packedConfig, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  const expected = Object.fromEntries(
    Object.entries(paths).filter(([key]) => key !== LIBRARY),
  );
  if (packed === undefined || packed.errors.length > 0)
    problems.push("tsconfig.packed.json: TypeScript cannot read it");
  else if (
    !isDeepStrictEqual(packed.options.paths ?? {}, expected) ||
    resolve(packed.options.baseUrl ?? packed.options.pathsBasePath ?? root) !==
      pathsBase
  )
    problems.push(
      `tsconfig.packed.json: its paths must be tsconfig.json's without ${LIBRARY}, from the same base`,
    );
}

const sources = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });

/** A specifier's text, or `null` when it is computed at run time. */
const literal = (node) =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;

/** Every module specifier in a file; `null` for a dynamic import computed at run time. */
const specifiers = (file) => {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    )
      found.push(literal(node.moduleSpecifier));
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      found.push(literal(node.moduleReference.expression));
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      found.push(literal(node.arguments[0]));
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      found.push(literal(node.argument.literal));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/**
 * The source file at an absolute path, the way TypeScript's NodeNext finds it, with its real path
 * and letter case, so neither a link nor a differently cased spelling escapes the directory tests.
 */
const sourceFile = (base) => {
  const found = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  return found === undefined ? undefined : realpathSync.native(found);
};

/**
 * The key of a `paths` or `imports` map that selects `specifier`, as TypeScript and Node choose it:
 * an exact key, or else the pattern with the longest prefix before its `*`; with the text `*` stands
 * for. Between patterns with equally long prefixes, Node's `imports` resolution prefers the longer
 * key (`longerKeyWins`); TypeScript's `paths` keeps the first.
 */
const select = (map, specifier, longerKeyWins = false) => {
  if (Object.hasOwn(map, specifier)) return { key: specifier, star: "" };
  let best;
  for (const key of Object.keys(map)) {
    const [prefix, suffix, ...more] = key.split("*");
    if (suffix === undefined || more.length > 0) continue;
    if (
      specifier.length < prefix.length + suffix.length ||
      !specifier.startsWith(prefix) ||
      !specifier.endsWith(suffix)
    )
      continue;
    if (
      best === undefined ||
      prefix.length > best.prefix ||
      (longerKeyWins &&
        prefix.length === best.prefix &&
        key.length > best.key.length)
    )
      best = {
        key,
        prefix: prefix.length,
        star: specifier.slice(prefix.length, specifier.length - suffix.length),
      };
  }
  return best;
};

/** Every string target of a `package.json` `imports` entry, across conditions and fallbacks. */
const leaves = (target) =>
  typeof target === "string"
    ? [target]
    : Array.isArray(target)
      ? target.flatMap(leaves)
      : typeof target === "object" && target !== null
        ? Object.values(target).flatMap(leaves)
        : [];

/** A bare specifier: the library, a Node built-in, or a declared package; or why it is none. */
const bare = (specifier) => {
  if (specifier === LIBRARY) return { kind: "library", name: specifier };
  if (isBuiltin(specifier)) return { kind: "builtin", name: specifier };
  const name = specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
  return dependencies.has(name)
    ? { kind: "package", name: specifier }
    : `${name} is not a declared dependency, a Node built-in, or an alias`;
};

/**
 * Everything a specifier in `from` can load: files, Node built-ins, packages, the library or the
 * lane. A string is the reason it resolves to nothing.
 */
const targetsOf = (from, specifier) => {
  if (/^(\.{1,2}(\/|$)|\/)/.test(specifier)) {
    const path = sourceFile(resolve(dirname(from), specifier));
    return path === undefined ? "no such file" : [{ kind: "file", path }];
  }
  if (specifier === LANE) return [{ kind: "lane", name: LANE }];
  if (specifier === LIBRARY || isBuiltin(specifier)) return [bare(specifier)];
  let mapped = false;
  const targets = [];
  const viaPaths = select(paths, specifier);
  if (viaPaths !== undefined) {
    for (const pattern of [paths[viaPaths.key]].flat()) {
      const path = sourceFile(
        resolve(pathsBase, pattern.replaceAll("*", viaPaths.star)),
      );
      if (path !== undefined) targets.push({ kind: "file", path });
    }
    // TypeScript falls back to package lookup when no `paths` candidate exists, so an unresolved
    // mapping decides nothing for a bare specifier; a `#…` specifier is still settled below.
    if (targets.length > 0) mapped = true;
  }
  const viaImports = specifier.startsWith("#")
    ? select(imports, specifier, true)
    : undefined;
  if (viaImports !== undefined) {
    mapped = true;
    for (const leaf of leaves(imports[viaImports.key])) {
      const target = leaf.replaceAll("*", viaImports.star);
      if (target.startsWith("./")) {
        const path = sourceFile(resolve(root, target));
        if (path !== undefined) targets.push({ kind: "file", path });
      } else if (!/^[./#]/.test(target)) {
        const kind = bare(target);
        if (typeof kind !== "string") targets.push(kind);
      }
    }
  }
  if (mapped)
    return targets.length > 0
      ? targets
      : "its alias names no existing file or package";
  if (specifier.startsWith("#"))
    return "neither package.json imports nor tsconfig.json paths maps it";
  const kind = bare(specifier);
  return typeof kind === "string" ? kind : [kind];
};

let checked = 0;

/**
 * Resolve each import of `file` and report the refused ones. `rule` receives each target and
 * returns undefined when the import is allowed, or the reason it is refused.
 */
const check = (file, rule) => {
  for (const specifier of specifiers(file)) {
    checked++;
    if (specifier === null) {
      problems.push(
        `${show(file)}: a dynamic import with a computed specifier cannot be checked`,
      );
      continue;
    }
    const targets = targetsOf(file, specifier);
    if (typeof targets === "string") {
      problems.push(`${show(file)}: cannot resolve ${specifier}: ${targets}`);
      continue;
    }
    for (const target of targets) {
      const reason = rule(target);
      if (reason === undefined) continue;
      const shown = target.kind === "file" ? show(target.path) : target.name;
      problems.push(
        `${show(file)}: imports ${specifier}${shown === specifier ? "" : ` (${shown})`}: ${reason}`,
      );
    }
  }
};

const backendFiles = sources(backends);
for (const file of backendFiles)
  check(file, (target) =>
    target.kind === "builtin" ||
    (target.kind === "file" &&
      (inside(backends, target.path) || backendHarness.has(target.path)))
      ? undefined
      : "a backend may import only Node built-ins, src/backends/, and src/harness/server.ts or route.ts",
  );

const consumerFiles = consumer.flatMap((directory) => sources(directory));
for (const file of consumerFiles) {
  const nodeOnly = file.endsWith(".node.test.ts");
  check(file, (target) => {
    if (target.kind === "builtin")
      return nodeOnly
        ? undefined
        : "a Node built-in, but this code also runs in a browser";
    if (target.kind !== "file") return undefined;
    if (inside(backends, target.path))
      return "consumer code reaches backends only over HTTP";
    if (inside(harness, target.path) && !consumerHarness.has(target.path))
      return "consumer code may use only src/harness/lane.ts and #lane of the harness";
    if (inside(conformance, target.path))
      return "the conformance tests are backend-side";
    return undefined;
  });
}

const conformanceFiles = existsSync(conformance) ? sources(conformance) : [];
for (const file of conformanceFiles)
  check(file, (target) => {
    if (target.kind !== "file") return undefined;
    if (inside(backends, target.path))
      return "conformance tests reach backends only over HTTP";
    if (inside(harness, target.path) && !consumerHarness.has(target.path))
      return "conformance tests may use only src/harness/lane.ts and #lane of the harness";
    if (consumer.some((directory) => inside(directory, target.path)))
      return "conformance tests are backend-side and share nothing with the consumer side";
    return undefined;
  });

// The service pages. A backend file may link several; an entry point must link at least one.
const SERVICE_LINK = /Service documentation: services\/([^\s/`'"]+\.md)/g;
const HARNESS_BACKENDS = new Set(["echo"]);
const servicesDirectory = join(root, "services");
const pages = new Set(
  existsSync(servicesDirectory)
    ? readdirSync(servicesDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    : [],
);
const entryPoints = readdirSync(backends, { withFileTypes: true }).flatMap(
  (entry) => {
    if (entry.isDirectory()) {
      const index = join(backends, entry.name, "index.ts");
      return existsSync(index) && !HARNESS_BACKENDS.has(entry.name)
        ? [realpathSync.native(index)]
        : [];
    }
    const name = entry.name.replace(/\.ts$/, "");
    return entry.name.endsWith(".ts") && !HARNESS_BACKENDS.has(name)
      ? [realpathSync.native(join(backends, entry.name))]
      : [];
  },
);
let linked = 0;
for (const file of backendFiles) {
  const links = [...readFileSync(file, "utf8").matchAll(SERVICE_LINK)].map(
    (match) => match[1],
  );
  for (const page of links)
    if (!pages.has(page))
      problems.push(
        `${show(file)}: links services/${page}, which does not exist`,
      );
  if (entryPoints.includes(realpathSync.native(file))) {
    if (links.length === 0)
      problems.push(
        `${show(file)}: links no service page; add a "Service documentation: services/<page>.md" line`,
      );
    else linked++;
  }
}

console.log(
  `boundaries: ${checked} imports in ${backendFiles.length} backend, ${consumerFiles.length} consumer and ${conformanceFiles.length} conformance files; ${linked} of ${entryPoints.length} backends link a service page`,
);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
