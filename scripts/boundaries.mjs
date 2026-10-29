// Check the import boundaries between backends and the consumer side by resolving every import
// (static, type-only, re-export, dynamic and `require`) with the TypeScript parser. Runs in
// `pnpm check`; Oxlint's no-restricted-imports rules flag the common cases in an editor, but match
// specifier text only, so this script is the enforced allowlist.
//
// - A backend (`src/backends/**`) may import only Node built-ins, modules inside `src/backends/`,
//   and `src/harness/server.ts` or `src/harness/route.ts`. Packages, other harness modules and the
//   consumer side are refused, so a backend stays a black box reached only over HTTP.
// - Consumer code and scenarios (`src/clients`, `src/values`, `src/formats`, `src/scenarios`) may
//   not import a backend or a Node-side harness module: of the harness, only `src/harness/lane.ts`
//   and the `#lane` alias are theirs. Outside `*.node.test.ts` files they may not import Node
//   built-ins either, because they also run in a browser.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const backends = join(src, "backends");
const harness = join(src, "harness");
const consumer = ["clients", "values", "formats", "scenarios"].map((name) =>
  join(src, name),
);
const backendHarness = new Set(
  ["server.ts", "route.ts"].map((name) => join(harness, name)),
);
const consumerHarness = new Set([join(harness, "lane.ts")]);

const show = (path) => relative(root, path).split(sep).join("/");
const inside = (directory, path) => path.startsWith(directory + sep);

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

/** A relative or absolute specifier as a source file, the way TypeScript's NodeNext finds it. */
const resolveFile = (from, specifier) => {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
};

const problems = [];
let checked = 0;

/**
 * Classify each import of `file` and report the refused ones. `allow` receives the resolved file,
 * or `undefined` for a package, and returns undefined when the import is allowed or the reason.
 */
const check = (file, allow, builtins) => {
  for (const specifier of specifiers(file)) {
    checked++;
    if (specifier === null) {
      problems.push(
        `${show(file)}: a dynamic import with a computed specifier cannot be checked`,
      );
      continue;
    }
    if (isBuiltin(specifier)) {
      if (!builtins)
        problems.push(
          `${show(file)}: imports the Node built-in ${specifier}, but this code also runs in a browser`,
        );
      continue;
    }
    const relativeOrAbsolute = /^(\.{1,2}(\/|$)|\/)/.test(specifier);
    const target = relativeOrAbsolute
      ? resolveFile(file, specifier)
      : undefined;
    if (relativeOrAbsolute && target === undefined) {
      problems.push(`${show(file)}: cannot resolve ${specifier}`);
      continue;
    }
    const reason = allow(target);
    if (reason !== undefined)
      problems.push(
        `${show(file)}: imports ${specifier}${target === undefined ? "" : ` (${show(target)})`}: ${reason}`,
      );
  }
};

const backendFiles = sources(backends);
for (const file of backendFiles)
  check(
    file,
    (target) =>
      target !== undefined &&
      (inside(backends, target) || backendHarness.has(target))
        ? undefined
        : "a backend may import only Node built-ins, src/backends/, and src/harness/server.ts or route.ts",
    true,
  );

const consumerFiles = consumer.flatMap((directory) => sources(directory));
for (const file of consumerFiles)
  check(
    file,
    (target) => {
      if (target === undefined) return undefined;
      if (inside(backends, target))
        return "consumer code reaches backends only over HTTP";
      if (inside(harness, target) && !consumerHarness.has(target))
        return "consumer code may use only src/harness/lane.ts and #lane of the harness";
      return undefined;
    },
    file.endsWith(".node.test.ts"),
  );

console.log(
  `boundaries: ${checked} imports in ${backendFiles.length} backend and ${consumerFiles.length} consumer files`,
);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
