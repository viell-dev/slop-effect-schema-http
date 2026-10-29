import type { TestProject } from "vitest/node";
import { startControl } from "./control.js";

/** Browser project global setup: start the control server and hand its URL to the tests. */
export default async function setup(project: TestProject) {
  const control = await startControl();
  project.provide("control", control.url);
  return () => control.close();
}
