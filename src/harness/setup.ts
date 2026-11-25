import { existsSync, readFileSync } from "node:fs";
import type { TestProject } from "vitest/node";
import { fileURLToPath } from "node:url";
import { hostSource } from "../../scripts/host-source.mjs";
import { startControl } from "./control.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The control server's URL. */
    readonly control: string;
    /** The host's certificate, which the Node lane trusts. */
    readonly certificate: string;
    /** The HTTPS port where the browser lane's Chromium uses HTTP/3. */
    readonly quicPort: number;
  }
}

const root = new URL("../../", import.meta.url);

/**
 * Stop the run, saying why. The error's stack is the reason alone: Vitest cannot print an error
 * thrown from a global setup whose stack it maps itself.
 */
const refuse = (reason: string): never => {
  const error = new Error(reason);
  error.stack = `Error: ${reason}`;
  throw error;
};

const read = (path: string, missing: string) => {
  const url = new URL(path, root);
  if (!existsSync(url)) refuse(missing);
  return readFileSync(url, "utf8");
};

/**
 * Global setup of both lanes: refuse a missing or stale library or host, so a run never reports
 * results for other commits than the ones it names, then start the control server.
 */
export default async function setup(project: TestProject) {
  const requested = (
    process.env["LIBRARY_REF"] ??
    (
      JSON.parse(read("refs.json", "refs.json is missing")) as {
        library: string;
      }
    ).library
  ).trim();
  const [commit = "", fetchedFor = ""] = read(
    ".library/REF",
    "The library source is missing. Run `npm run library` first.",
  ).split("\n");
  if (fetchedFor !== requested)
    refuse(
      `.library holds ${fetchedFor} (${commit}), not ${requested}. Run \`npm run library\`.`,
    );
  const built = JSON.parse(
    read(".host/BUILT", "The host is not built. Run `npm run host` first."),
  ) as Record<string, { version: string; commit: string } | string>;
  if (built["source"] !== hostSource(fileURLToPath(root)))
    refuse(
      "The host's sources changed since it was built. Run `npm run host`.",
    );
  console.log(`Testing viell-effect-schema-http at ${commit}`);
  for (const name of ["warded", "warded-server"]) {
    const { version, commit: at } = built[name] as {
      version: string;
      commit: string;
    };
    console.log(`Testing ${name} ${version} at ${at}`);
  }

  const control = await startControl(root);
  project.provide("control", control.url);
  project.provide(
    "certificate",
    read(".host/cert.pem", "The host has no certificate."),
  );
  return () => control.close();
}
