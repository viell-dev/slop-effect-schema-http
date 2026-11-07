/**
 * What Berth's answers and bookings look like, from its service page. Nothing here transforms a
 * value: a booking reads the same on both sides, so each schema's work is refusing what the page
 * says cannot happen.
 */
import { Schema } from "effect";

/** One to 64 ASCII letters, digits and hyphens. */
export const RepeatKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/),
);

/** The region, a hyphen and a six-digit count from 1. */
export const BookingId = Schema.String.check(Schema.isPattern(/^.+-\d{6}$/));

/** What a client sends to book a slot: three non-empty strings. */
export const BookingDraft = Schema.Struct({
  vessel: Schema.NonEmptyString,
  terminal: Schema.NonEmptyString,
  slot: Schema.NonEmptyString,
});
export type BookingDraft = typeof BookingDraft.Type;

/** A committed booking. `key` is `null` for a booking made without a repeat key. */
export const Booking = Schema.Struct({
  ...BookingDraft.fields,
  id: BookingId,
  region: Schema.NonEmptyString,
  key: Schema.NullOr(RepeatKey),
  replayed: Schema.Boolean,
});
export type Booking = typeof Booking.Type;

/** Every booking committed in one region, in commit order. */
export const BookingList = Schema.Struct({
  region: Schema.NonEmptyString,
  bookings: Schema.Array(Booking),
});

/**
 * The answer that tells an integrator a host is really Berth. Its `service` is the point: a parked
 * page and another company's health check both answer 200.
 */
export const Health = Schema.Struct({
  service: Schema.Literal("berth"),
  region: Schema.NonEmptyString,
  status: Schema.Literal("ok"),
});

/** A terminal's open slots. */
export const Availability = Schema.Struct({
  terminal: Schema.NonEmptyString,
  open: Schema.Array(Schema.String),
});

/** Every JSON refusal the page lists. */
export const Problem = Schema.Struct({
  error: Schema.Literals([
    "invalid_booking",
    "invalid_key",
    "key_reused",
    "not_found",
    "unknown_key",
  ]),
});

/** A whole manifest: `line 001` to `line 100`, each ending in a line feed. */
export const manifestText = Array.from(
  { length: 100 },
  (_, index) => `line ${String(index + 1).padStart(3, "0")}\n`,
).join("");

/**
 * The check a report needs before it trusts a manifest, because an answer with no framing that stops
 * half-way looks whole to every client (EXT-23g). It counts lines and leaves their numbers to the
 * test that compares them with {@link manifestText}.
 */
export const Manifest = Schema.String.check(
  Schema.isPattern(/^(?:line \d{3}\n){100}$/),
);
