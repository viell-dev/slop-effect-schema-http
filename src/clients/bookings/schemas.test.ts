import { describe, expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import {
  Availability,
  Booking,
  BookingDraft,
  BookingId,
  BookingList,
  Health,
  Manifest,
  manifestText,
  Problem,
  RepeatKey,
} from "./schemas.js";

const codec = (schema: Schema.Top) =>
  Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>;

const refused = (schema: Schema.Top, wire: unknown) =>
  expect(Exit.isFailure(Schema.decodeUnknownExit(codec(schema))(wire))).toBe(
    true,
  );

const roundTrips = (schema: Schema.Top, wire: unknown) =>
  expect(
    Schema.encodeUnknownSync(codec(schema))(
      Schema.decodeUnknownSync(codec(schema))(wire),
    ),
  ).toEqual(wire);

const draft = {
  vessel: "MV Aurora",
  terminal: "rotterdam",
  slot: "2026-11-07T06:00",
};

const booking = {
  id: "eu-000001",
  region: "eu",
  ...draft,
  key: null,
  replayed: false,
};

describe("the bookings contracts", () => {
  it("[EXT-24a] the page's own examples round-trip through their schemas", () => {
    roundTrips(BookingDraft, draft);
    roundTrips(Booking, booking);
    roundTrips(Booking, { ...booking, key: "a-Key-1", replayed: true });
    roundTrips(BookingList, { region: "eu", bookings: [booking] });
    roundTrips(BookingList, { region: "eu", bookings: [] });
    roundTrips(Health, { service: "berth", region: "eu", status: "ok" });
    roundTrips(Availability, {
      terminal: "rotterdam",
      open: ["06:00", "07:00", "08:00", "09:00"],
    });
    roundTrips(Problem, { error: "key_reused" });
    roundTrips(Manifest, manifestText);
  });

  it("[EXT-24a] a draft needs three non-empty strings", () => {
    refused(BookingDraft, { ...draft, vessel: "" });
    refused(BookingDraft, { vessel: "MV Aurora", terminal: "rotterdam" });
    refused(BookingDraft, { ...draft, slot: 7 });
  });

  it("[EXT-24f] a repeat key is one to 64 letters, digits and hyphens", () => {
    roundTrips(RepeatKey, "a");
    roundTrips(RepeatKey, "A-1".padEnd(64, "x"));
    refused(RepeatKey, "");
    refused(RepeatKey, "x".repeat(65));
    refused(RepeatKey, "with space");
    refused(RepeatKey, "under_score");
    refused(RepeatKey, "käse");
  });

  it("[EXT-24d] an id is a region, a hyphen and six digits", () => {
    roundTrips(BookingId, "eu-000001");
    refused(BookingId, "eu-1");
    refused(BookingId, "000001");
    refused(BookingId, "eu-0000001x");
  });

  it("[EXT-24a] a booking without a key says null, and anything else must be a key", () => {
    refused(Booking, { ...booking, key: "" });
    refused(Booking, { ...booking, key: undefined });
    refused(Booking, { ...booking, replayed: "false" });
  });

  it("[EXT-28d] health refuses what a parked page or another service would say", () => {
    refused(Health, { service: "tides", status: "ok" });
    refused(Health, { service: "tides", region: "eu", status: "ok" });
    refused(Health, { service: "berth", status: "ok" });
    refused(Health, { service: "berth", region: "eu", status: "down" });
  });

  it("[EXT-23g] the manifest check refuses a cut, a short count and a stray line", () => {
    refused(Manifest, manifestText.slice(0, 450));
    refused(Manifest, manifestText.slice(0, -1));
    refused(Manifest, `${manifestText}line 101\n`);
    refused(Manifest, manifestText.replace("line 050", "line 05"));
    expect(new TextEncoder().encode(manifestText)).toHaveLength(900);
    expect(manifestText.startsWith("line 001\nline 002\n")).toBe(true);
    expect(manifestText.endsWith("line 100\n")).toBe(true);
  });

  it("[EXT-24m] a refusal names one of the page's errors", () => {
    refused(Problem, { error: "other" });
    refused(Problem, {});
  });
});
