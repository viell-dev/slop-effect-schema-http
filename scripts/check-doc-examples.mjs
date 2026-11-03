import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
      return names.map((name) => ({ name, docs: node.jsDoc ?? [] }));
    });
};
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
for (const target of Object.values(manifest.exports)) {
  if (typeof target !== "object" || !target.types) continue;
  const sourceFile = target.types
    .replace("./dist/", "src/")
    .replace(/\.d\.ts$/, ".ts");
  const built = new Map(
    exportsOf(target.types).map((entry) => [entry.name, entry]),
  );
  for (const { name, docs } of exportsOf(sourceFile)) {
    const origin = `${sourceFile}:${name}`;
    assert.ok(summary(docs), `Missing public API summary: ${origin}`);
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
for (const file of markdown) {
  const content = read(file);
  for (const match of content.matchAll(
    /^```(?:ts|typescript)\s*\r?\n([\s\S]*?)^```\s*$/gm,
  )) {
    addExample(
      match[1],
      `${file}:${content.slice(0, match.index).split("\n").length}`,
    );
  }
}

const config = ts.readConfigFile("tsconfig.examples.json", ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  process.cwd(),
);
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
    `Documentation checked: ${declarations} public summaries in source/declarations; ${examples.size} strict TypeScript examples.`,
  );
}
