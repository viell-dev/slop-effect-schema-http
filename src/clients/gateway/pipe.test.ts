import { describe, expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import { ErrorFromBytes, type GatewayError, reply } from "./pipe.js";
import { BalanceLine, SessionLine } from "./session.js";

const balance = reply(BalanceLine);
const refuses = (decoded: Exit.Exit<unknown, unknown>) =>
  expect(Exit.isFailure(decoded)).toBe(true);

describe("pipe replies", () => {
  it("[ERR-1c] an ERROR line's message is everything after its second |, in a pipe reply and from bytes", () => {
    for (const [text, code, message] of [
      [
        "ERROR|E_NOACCT|no such account 00099999\n",
        "E_NOACCT",
        "no such account 00099999",
      ],
      ["ERROR|E_TOPIC|no topic a|b\n", "E_TOPIC", "no topic a|b"],
      ["ERROR|E_SECTION|no section a|b||c\n", "E_SECTION", "no section a|b||c"],
      ["ERROR|E_SECTION|no section ä😀\n", "E_SECTION", "no section ä😀"],
      ["ERROR|E_SECTION|no section \ufffd\n", "E_SECTION", "no section \ufffd"],
    ] as const) {
      const error: GatewayError = { _tag: "GatewayError", code, message };
      expect(Schema.decodeUnknownSync(balance)(text)).toEqual(error);
      expect(Schema.encodeSync(balance)(error)).toBe(text);
      const bytes = new TextEncoder().encode(text);
      expect(Schema.decodeUnknownSync(ErrorFromBytes)(bytes)).toEqual(error);
      expect(Schema.encodeSync(ErrorFromBytes)(error)).toEqual(bytes);
    }
  });

  it("[ERR-1c] an OK line keeps exactly its fields, so a | in one is still refused", () => {
    for (const text of [
      "OK|00012345|123456|20261031|x\n",
      "OK|00012345|123456|2026|1031\n",
    ])
      refuses(Schema.decodeUnknownExit(balance)(text));
    refuses(Schema.decodeUnknownExit(reply(SessionLine))("OK|s3ss|on\n"));
  });
});
