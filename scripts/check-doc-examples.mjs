import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

// Check the public documentation against the package consumers actually import.
// Files are virtual: this never writes examples into the working tree or executes network code.
const read = (file) => readFileSync(file, "utf8");
const manifest = JSON.parse(read("package.json"));
const examples = new Map();
const origins = new Map();
const addExample = (code, origin) => {
  const file = resolve(`examples/__documentation_${examples.size}.mts`);
  examples.set(file, code);
  origins.set(file, origin);
};
const exportsOf = (file) => {
  const source = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements
    .filter(
      (node) =>
        ts.isExportDeclaration(node) ||
        node.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ),
    )
    .flatMap((node) => {
      const names = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map((entry) =>
            entry.name.getText(source),
          )
        : ts.isExportDeclaration(node)
          ? ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map((entry) =>
                entry.name.getText(source),
              )
            : [node.exportClause.name.getText(source)]
          : [node.name.getText(source)];
      return names.map((name) => ({
        name,
        docs: node.jsDoc ?? [],
        members: membersOf(node),
        source,
      }));
    });
};
const membersOf = (node) =>
  ts.isInterfaceDeclaration(node)
    ? node.members
    : ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)
      ? node.type.members
      : [];
// A compile-error type's one member has the message as its name, so that name is its documentation.
const isMessage = (member) =>
  member.name && ts.isStringLiteral(member.name) && /\s/.test(member.name.text);
const summary = (docs) =>
  docs
    .map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? "")
    .join("\n")
    .trim();
const documentation = (docs) =>
  docs.map((doc) => ({
    summary: ts.getTextOfJSDocComment(doc.comment),
    tags: Array.from(doc.tags ?? [], (tag) => ({
      name: tag.tagName.text,
      comment: ts.getTextOfJSDocComment(tag.comment),
    })),
  }));
let declarations = 0;
let documentedMembers = 0;
const publicSources = [];
for (const target of Object.values(manifest.exports)) {
  if (typeof target !== "object" || !target.types) continue;
  const sourceFile = target.types
    .replace("./dist/", "src/")
    .replace(/\.d\.ts$/, ".ts");
  publicSources.push(sourceFile);
  const built = new Map(
    exportsOf(target.types).map((entry) => [entry.name, entry]),
  );
  for (const { name, docs, members, source } of exportsOf(sourceFile)) {
    const origin = `${sourceFile}:${name}`;
    assert.ok(summary(docs), `Missing public API summary: ${origin}`);
    for (const member of members) {
      if (isMessage(member)) continue;
      assert.ok(
        summary(member.jsDoc ?? []),
        `Missing public API member summary: ${origin}.${member.name?.getText(source)}`,
      );
      documentedMembers++;
    }
    assert.deepEqual(
      documentation(built.get(name)?.docs ?? []),
      documentation(docs),
      `Rebuild: published declaration documentation disagrees with ${origin}`,
    );
    for (const doc of docs) {
      for (const tag of doc.tags ?? []) {
        if (tag.tagName.text !== "example") continue;
        const text = ts.getTextOfJSDocComment(tag.comment) ?? "";
        const code = /^```ts\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
        assert.ok(
          code,
          `Use one complete TypeScript block per @example: ${origin}`,
        );
        addExample(code[1], origin);
      }
    }
    declarations++;
  }
}

// Site snippets imported from examples/ already have runtime checks. Check standalone
// TypeScript fences in all tracked Markdown as well (README and the API/design guides).
const markdown = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .trim()
  .split("\n");
// Fences that may hold a code example. Shell and data fences, such as sh, json or yaml, cannot.
const exampleFence =
  /^(?:tsx?|mts|cts|typescript\w*|jsx?|mjs|cjs|javascript\w*)\b/i;
// The example fences the compiler does not see, by file and info string, along with any fence that
// has no language. Say why each is here: an entry in this list is an example nothing checks.
const skippedFences = {
  // The 0.1 side of each before-and-after. That API is gone, so this code cannot compile.
  "docs/release-notes/0.2.md: ts [0.1]": 16,
  // The 0.2 side of each before-and-after, which behaves differently on purpose.
  "docs/release-notes/0.3.md: ts [0.2]": 4,
};
const fencesIn = (content) => {
  const fences = [];
  let open;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const fence = /^([\s>]*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && fence?.[2].startsWith(open.marker) && !fence[3].trim()) {
      fences.push(open);
      open = undefined;
    } else if (open) {
      open.code += `${line.slice(open.indent)}\n`;
    } else if (fence) {
      open = {
        line: index + 1,
        indent: fence[1].length,
        marker: fence[2],
        info: fence[3].trim(),
        code: "",
      };
    }
  }
  return fences;
};
const skipped = {};
for (const file of markdown) {
  for (const { line, info, code } of fencesIn(read(file))) {
    if (info === "ts" || info === "typescript") {
      addExample(code, `${file}:${line}`);
    } else if (!info || exampleFence.test(info)) {
      const key = `${file}: ${info || "(no language)"}`;
      skipped[key] = (skipped[key] ?? 0) + 1;
    }
  }
}
assert.deepEqual(
  skipped,
  skippedFences,
  "A Markdown fence escapes the example checks: write TypeScript as a plain ts fence, name the language of anything else, or list it in skippedFences with the reason",
);

const config = ts.readConfigFile("tsconfig.examples.json", ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  process.cwd(),
);

// {@link} targets, which the compiler itself leaves unresolved without complaint.
const sources = ts.createProgram(publicSources, parsed.options);
const checker = sources.getTypeChecker();
let resolvedLinks = 0;
const linksIn = (comment) =>
  typeof comment === "object"
    ? Array.from(comment ?? []).filter((part) => part.name !== undefined)
    : [];
const visitLinks = (node, source) => {
  for (const doc of node.jsDoc ?? []) {
    for (const comment of [
      doc.comment,
      ...(doc.tags ?? []).map((t) => t.comment),
    ]) {
      for (const link of linksIn(comment)) {
        if (link.text.startsWith("://")) continue; // {@link https://…} parses as a name.
        const { line } = source.getLineAndCharacterOfPosition(link.pos);
        assert.ok(
          checker.getSymbolAtLocation(link.name),
          `Unresolved {@link ${link.name.getText(source)}}: ${relative(".", source.fileName)}:${line + 1}`,
        );
        resolvedLinks++;
      }
    }
  }
  ts.forEachChild(node, (child) => visitLinks(child, source));
};
for (const source of sources.getSourceFiles()) {
  if (!source.isDeclarationFile) visitLinks(source, source);
}

const host = ts.createCompilerHost(parsed.options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (
  file,
  languageVersion,
  onError,
  shouldCreateNewSourceFile,
) => {
  const text = examples.get(resolve(file));
  return text === undefined
    ? originalGetSourceFile(
        file,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      )
    : ts.createSourceFile(file, text, languageVersion, true);
};
const program = ts.createProgram([...examples.keys()], parsed.options, host);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length > 0) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => origins.get(resolve(file)) ?? file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Documentation checked: ${declarations} public summaries in source/declarations, ${documentedMembers} interface members and ${resolvedLinks} {@link} targets; ${examples.size} strict TypeScript examples.`,
  );
}
