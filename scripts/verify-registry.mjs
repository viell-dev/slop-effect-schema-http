import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { verifyRegistry } from "./registry-verification.mjs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (process.env.GITHUB_ACTIONS === "true" && !process.env.GITHUB_REPOSITORY) {
  throw new Error("Missing GitHub repository");
}
await verifyRegistry(manifest, {
  repository:
    process.env.GITHUB_ACTIONS === "true"
      ? process.env.GITHUB_REPOSITORY
      : undefined,
});
console.log(
  `Registry bytes match qualified ${manifest.name}@${manifest.version}.`,
);
