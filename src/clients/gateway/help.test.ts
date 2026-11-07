import { describe, expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import { HelpReply } from "./help.js";

const decode = Schema.decodeUnknownSync(HelpReply);
const decodeExit = Schema.decodeUnknownExit(HelpReply);
const encode = Schema.encodeSync(HelpReply);

const opening = {
  topic: "accounts",
  section: "opening",
  text: "Open an account from the File menu.",
};
const closing = {
  topic: "accounts",
  section: "closing",
  text: "Close an account at month end.",
};

describe("help replies", () => {
  it("[EXT-9e] HelpReply round-trips a whole topic, keeping the order of its lines", () => {
    const text =
      "OK|accounts|opening|Open an account from the File menu.\n" +
      "OK|accounts|closing|Close an account at month end.\n";
    const reply = { _tag: "Help", sections: [opening, closing] } as const;
    expect(decode(text)).toEqual(reply);
    expect(encode(reply)).toBe(text);
  });

  it("[EXT-9e] HelpReply round-trips one section and one ERROR line", () => {
    const section = "OK|accounts|closing|Close an account at month end.\n";
    const one = { _tag: "Help", sections: [closing] } as const;
    expect(decode(section)).toEqual(one);
    expect(encode(one)).toBe(section);

    const refusal = "ERROR|E_SECTION|no section closing?lang=de\n";
    const error = {
      _tag: "GatewayError",
      code: "E_SECTION",
      message: "no section closing?lang=de",
    } as const;
    expect(decode(refusal)).toEqual(error);
    expect(encode(error)).toBe(refusal);
  });

  for (const [name, text] of [
    ["no lines", ""],
    ["an empty line", "\n"],
    ["a last line without its LF", "OK|accounts|closing|Close."],
    ["a line ending in CRLF", "OK|accounts|closing|Close.\r\n"],
    ["a blank line after the section", "OK|accounts|closing|Close.\n\n"],
    ["a section line without its text", "OK|accounts|closing\n"],
    ["a section line with an extra field", "OK|accounts|closing|Close.|x\n"],
    ["a section line without a section", "OK|accounts||Close.\n"],
    ["a section line without a topic", "OK||closing|Close.\n"],
    ["a status other than OK", "ok|accounts|closing|Close.\n"],
    ["an ERROR line without a code", "ERROR||no section x\n"],
    ["an ERROR line without a message", "ERROR|E_SECTION\n"],
    ["an ERROR line with an extra field", "ERROR|E_SECTION|a|b\n"],
    ["two ERROR lines", "ERROR|E_TOPIC|a\nERROR|E_TOPIC|b\n"],
    ["a section after an ERROR line", "ERROR|E_TOPIC|a\nOK|a|b|c\n"],
    ["an ERROR line after a section", "OK|a|b|c\nERROR|E_TOPIC|a\n"],
  ] as const)
    it(`[EXT-9e] HelpReply refuses ${name}`, () => {
      expect(Exit.isFailure(decodeExit(text))).toBe(true);
    });
});
