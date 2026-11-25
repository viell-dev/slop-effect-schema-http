import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { proxyBase } from "../clients/browser/proxy.js";
import { outcome, wireCases } from "../clients/post-release-wire.js";

const params = new URLSearchParams(location.search);
const id = params.get("group");
const index = Number(params.get("case"));
const api = params.get("api");
const output = document.querySelector("#result")!;

if (id === null || !Object.hasOwn(wireCases, id) || api === null) {
  throw new Error("The wire probe requires a valid group, case and API origin");
}
const row = wireCases[id as keyof typeof wireCases][index];
if (row === undefined) throw new Error("Unknown wire probe case");

void Effect.runPromise(
  outcome(row.send, proxyBase(api)).pipe(Effect.provide(FetchHttpClient.layer)),
).then(
  (result) => {
    output.textContent = JSON.stringify(result);
  },
  (defect: unknown) => {
    output.textContent = JSON.stringify({
      tag: "Defect",
      message: String(defect),
    });
  },
);
