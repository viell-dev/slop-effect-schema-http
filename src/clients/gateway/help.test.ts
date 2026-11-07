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

  for (const [name, text, code, message] of [
    [
      "one |",
      "ERROR|E_SECTION|no section a|b\n",
      "E_SECTION",
      "no section a|b",
    ],
    [
      "several |",
      "ERROR|E_SECTION|no section a|b|c\n",
      "E_SECTION",
      "no section a|b|c",
    ],
    [
      "| at its ends and side by side",
      "ERROR|E_SECTION||no section a||b|\n",
      "E_SECTION",
      "|no section a||b|",
    ],
    ["nothing but a |", "ERROR|E_TOPIC||\n", "E_TOPIC", "|"],
  ] as const)
    it(`[EXT-9p] HelpReply reads an ERROR message holding ${name} as everything after the second |, and round-trips it`, () => {
      const error = { _tag: "GatewayError", code, message } as const;
      expect(decode(text)).toEqual(error);
      expect(encode(error)).toBe(text);
    });

  it("[EXT-9p] HelpReply refuses to write a | in an ERROR code, or a line end in its message", () => {
    for (const error of [
      { code: "E_SECTION|x", message: "no section a" },
      { code: "E_SECTION", message: "no section a\nb" },
      { code: "E_SECTION", message: "no section a\r" },
    ])
      expect(() => encode({ _tag: "GatewayError", ...error })).toThrow(
        /a field holds a separator/,
      );
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
    ["an ERROR line without a code before a |", "ERROR||a|b\n"],
    [
      "an ERROR message cut by a line end, its rest on a line of its own",
      "ERROR|E_SECTION|no section a\nb\n",
    ],
    ["two ERROR lines", "ERROR|E_TOPIC|a\nERROR|E_TOPIC|b\n"],
    ["a section after an ERROR line", "ERROR|E_TOPIC|a\nOK|a|b|c\n"],
    ["an ERROR line after a section", "OK|a|b|c\nERROR|E_TOPIC|a\n"],
  ] as const)
    it(`[EXT-9e] HelpReply refuses ${name}`, () => {
      expect(Exit.isFailure(decodeExit(text))).toBe(true);
    });
});
