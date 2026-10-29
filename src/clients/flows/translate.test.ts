import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import * as BusinessValues from "../../values/business.js";
import { Cents as GatewayCents } from "../../values/gateway.js";
import * as Ops from "../business/operations.js";
import { DirectoryEntry } from "../identity/schemas.js";
import { AnnouncementDraft } from "../notifications/schemas.js";
import { Actions } from "../soap-store/index.js";
import * as Translate from "./translate.js";

/**
 * APP-3 round trips. Each translation is checked in both directions, with the semantic equality it
 * claims: an assignment decodes back to an equal assignment (`Equal` on its fields, `Option` and
 * `DateTime` by value), and the wire form re-encodes to the same JSON. Lossy and one-way parts state
 * their loss and refuse what they cannot reverse.
 */

const day = (year: number, month: number, date: number) =>
  DateTime.makeUnsafe(Date.UTC(year, month - 1, date));

const item = (overrides: Partial<Record<string, unknown>> = {}) =>
  Schema.decodeUnknownSync(Translate.MonthEndItem)({
    period: "202610",
    account: "00012345",
    title: "Café Müller",
    amount: 123_450,
    due: Option.some(day(2026, 11, 15)),
    status: "open",
    ...overrides,
  });

const assignment = (
  overrides: Partial<Record<string, unknown>> = {},
): Translate.Assignment => ({ item: item(overrides), assignee: "alovelace" });

const toTask = Schema.encodeSync(Translate.AssignmentFromTask);
const toWire = Schema.encodeSync(Translate.AssignmentFromWire);
const fromWire = Schema.decodeUnknownSync(Translate.AssignmentFromWire);

/** The reason a decode refused its input. */
const refusal = <S extends Schema.Top>(schema: S, input: unknown): string => {
  const exit = Schema.decodeUnknownExit(schema as never)(input);
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit)
    ? (Cause.squash(exit.cause) as Error).message
    : "";
};

/** The reason an encode refused its input. */
const encodeRefusal = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): string => {
  const exit = Schema.encodeUnknownExit(schema as never)(input);
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit)
    ? (Cause.squash(exit.cause) as Error).message
    : "";
};

describe("flows translation (APP-3)", () => {
  it("[APP-3] an assignment round-trips through the business write model and its JSON wire form", () => {
    expect(toWire(assignment())).toEqual({
      title: "[00012345] Café Müller",
      assigneeId: "idp:alovelace",
      priority: 2,
      due: `/Date(${Date.UTC(2026, 10, 15)})/`,
      notes: "Month-end 202610: $1,234.50 open",
      done: "N",
    });
    const cases = [
      assignment(),
      assignment({ due: Option.none(), status: "paid" }),
      assignment({ status: "cancelled", amount: 0 }),
      assignment({ amount: 9_999, title: "x" }),
      assignment({ amount: 10_000, title: "A".repeat(30) }),
      assignment({ amount: 99_999 }),
      assignment({ amount: 100_000 }),
      assignment({ amount: 999_999 }),
      assignment({ amount: 1_000_000, account: "99999999" }),
      assignment({ amount: 99_999_999_999, due: Option.some(day(1970, 1, 1)) }),
    ];
    for (const value of cases) {
      const wire = toWire(value);
      // Through JSON text, as the service stores and serves it.
      const reread = fromWire(JSON.parse(JSON.stringify(wire)));
      expect(reread).toEqual(value);
      expect(toWire(reread)).toEqual(wire);
      expect(
        Schema.decodeSync(Translate.AssignmentFromTask)(toTask(value)),
      ).toEqual(value);
    }
  });

  it("[APP-3] ids from other services stay visible references and never become business ids", () => {
    const title = Schema.decodeSync(Translate.ReferencedTitle)(
      "[00012345] Café Müller",
    );
    expect(title).toEqual({ account: "00012345", title: "Café Müller" });
    expect(Schema.encodeSync(Translate.ReferencedTitle)(title)).toBe(
      "[00012345] Café Müller",
    );
    expect(refusal(Translate.ReferencedTitle, "Café Müller")).toContain(
      "starts with the gateway account",
    );
    expect(refusal(Translate.ReferencedTitle, "[1234567] Café")).toContain(
      "starts with the gateway account",
    );
    expect(refusal(Translate.ReferencedTitle, "[00012345]  Café")).toContain(
      "1 to 30 characters",
    );
    expect(
      refusal(Translate.ReferencedTitle, `[00012345] ${"x".repeat(31)}`),
    ).toContain("1 to 30 characters");

    expect(
      Schema.decodeSync(Translate.AssigneeReference)("idp:alovelace"),
    ).toBe("alovelace");
    expect(Schema.encodeSync(Translate.AssigneeReference)("alovelace")).toBe(
      "idp:alovelace",
    );
    // A business user id is another id space, not a uid without its prefix.
    expect(refusal(Translate.AssigneeReference, "u-ada")).toContain(
      "only idp:<uid> names a directory user",
    );
    expect(refusal(Translate.AssigneeReference, "idp:Ada")).not.toBe("");
    expect(refusal(Translate.AssigneeReference, "idp:")).not.toBe("");

    const account = item().account;
    const taskId = Schema.decodeSync(Ops.TaskId)("T-1001");
    // @ts-expect-error A gateway account is not a business task id.
    const asTask: Ops.TaskId = account;
    // @ts-expect-error A business task id is not a gateway account.
    const asAccount: Translate.Account = taskId;
    expect([asTask, asAccount]).toEqual(["00012345", "T-1001"]);
  });

  it("[APP-3] the money-to-priority mapping is lossy, and the figure in the notes makes it reversible", () => {
    const high = assignment({ amount: 123_450 });
    const alsoHigh = assignment({ amount: 100_000 });
    expect(toWire(high).priority).toBe(2);
    expect(toWire(alsoHigh).priority).toBe(2);
    // The priority alone loses the figure; the notes keep each amount apart.
    expect(toWire(high).notes).toBe("Month-end 202610: $1,234.50 open");
    expect(toWire(alsoHigh).notes).toBe("Month-end 202610: $1,000.00 open");
    expect(fromWire(toWire(alsoHigh)).item.amount).toBe(100_000);

    const wire = toWire(high);
    expect(
      refusal(Translate.AssignmentFromWire, { ...wire, priority: 1 }),
    ).toContain(
      "priority 1 disagrees with the amount in the notes, which maps to 2",
    );
    for (const figure of ["1234.50", "$1234.50", "$1,234.5", "-$12.00"])
      expect(
        refusal(Translate.AssignmentFromWire, {
          ...wire,
          notes: `Month-end 202610: ${figure} open`,
        }),
      ).not.toBe("");
    const { notes: _notes, ...withoutNotes } = wire;
    expect(refusal(Translate.AssignmentFromWire, withoutNotes)).toContain(
      "the notes are missing",
    );

    const notes = Schema.decodeSync(Translate.MonthEndNotes)(
      "Month-end 202610: $25,000.00 open",
    );
    expect(notes).toEqual({
      period: "202610",
      amount: 2_500_000,
      status: "open",
    });
    expect(Schema.encodeSync(Translate.MonthEndNotes)(notes)).toBe(
      "Month-end 202610: $25,000.00 open",
    );
    expect(
      refusal(Translate.MonthEndNotes, "Month-end 202610: $25,000.00 Open"),
    ).toContain("expected notes as");
    expect(
      refusal(Translate.MonthEndNotes, "month-end 202610: $25,000.00 open"),
    ).toContain("expected notes as");
    expect(
      refusal(Translate.MonthEndNotes, "Month-end 202613: $25,000.00 open"),
    ).not.toBe("");

    const amount = item().amount;
    // @ts-expect-error Gateway cents are not business cents: the brands differ.
    const unconverted: BusinessValues.Cents = amount;
    expect(Schema.encodeSync(BusinessValues.DollarString)(unconverted)).toBe(
      Schema.encodeSync(BusinessValues.DollarString)(
        Translate.toBusinessCents(amount),
      ),
    );
    expectTypeOf(amount).toEqualTypeOf<GatewayCents>();
  });

  it("[APP-3] the active flag is recovered from status, and the notes keep paid apart from cancelled", () => {
    expect(Translate.isActive("open")).toBe(true);
    expect(Translate.isActive("paid")).toBe(false);
    expect(Translate.isActive("cancelled")).toBe(false);
    const paid = toWire(assignment({ status: "paid" }));
    const cancelled = toWire(assignment({ status: "cancelled" }));
    // The flag is the same for both; only the notes tell them apart.
    expect([paid.done, cancelled.done]).toEqual(["Y", "Y"]);
    expect(fromWire(paid).item.status).toBe("paid");
    expect(fromWire(cancelled).item.status).toBe("cancelled");
    expect(
      refusal(Translate.AssignmentFromWire, { ...paid, done: "N" }),
    ).toContain("done is N, but the notes say the item is paid");
    const open = toWire(assignment());
    expect(
      refusal(Translate.AssignmentFromWire, { ...open, done: "Y" }),
    ).toContain("done is Y, but the notes say the item is open");

    // Only active items become new tasks; the service sets done itself.
    const created = Effect.runSync(Translate.newTask(assignment()));
    expect(created).not.toHaveProperty("done");
    expect(Schema.encodeSync(Ops.NewTask)(created)).toEqual({
      title: open.title,
      assigneeId: open.assigneeId,
      priority: open.priority,
      due: open.due,
      notes: open.notes,
    });
    const refused = Effect.runSync(
      Effect.flip(Translate.newTask(assignment({ status: "paid" }))),
    );
    expect(refused.message).toContain(
      "a paid item is not work: only open items become tasks",
    );
  });

  it("[APP-3] a due date is a calendar date: a time of day or a fixed offset is refused rather than shifted", () => {
    const wire = toWire(assignment());
    const noon = Date.UTC(2026, 10, 15, 12);
    expect(
      refusal(Translate.AssignmentFromWire, {
        ...wire,
        due: `/Date(${noon})/`,
      }),
    ).toContain("calendar date at midnight UTC");
    expect(
      refusal(Translate.AssignmentFromWire, {
        ...wire,
        due: `/Date(${Date.UTC(2026, 10, 15)}+0100)/`,
      }),
    ).toContain("calendar date at midnight UTC");
    expect(
      encodeRefusal(Translate.AssignmentFromTask, {
        ...assignment(),
        item: { ...item(), due: Option.some(DateTime.makeUnsafe(noon)) },
      }),
    ).toContain("calendar date at midnight UTC");
  });

  it("[APP-3] the announcement is one-way: a summary renders, and reading one back fails with the reason", () => {
    const summary = Schema.decodeUnknownSync(Translate.Summary)({
      period: "202610",
      assignee: "alovelace",
      tasks: ["T-1001", "T-1002"],
      skipped: 1,
      archived: { id: "DOC-000001", name: "ME202610-20261101T021500Z.DAT" },
      published: "portal.ME202610-20261101T021500Z.DAT",
    });
    const draft = Schema.encodeSync(Translate.AnnouncementFromSummary)(summary);
    expect(draft).toEqual({
      channel: "month-end",
      subject: "Month-end 202610 closed",
      body:
        "2 task(s) for idp:alovelace (T-1001, T-1002); 1 item(s) were not open. " +
        "Extract archived as DOC-000001 (ME202610-20261101T021500Z.DAT) and published as portal.ME202610-20261101T021500Z.DAT.",
    });
    // The rendered draft is valid for the notification service's own schema.
    expect(Schema.encodeSync(AnnouncementDraft)(draft)).toEqual(draft);
    expect(refusal(Translate.AnnouncementFromSummary, draft)).toContain(
      "one-way: an announcement is prose for people and does not carry the task ids",
    );
  });

  it("[APP-3] the upload keeps the file's time in its name and visibly drops the size", () => {
    const content = new TextEncoder().encode("HMONTHEND202610");
    const file: Translate.GatewayFile = {
      name: "ME202610.DAT",
      modified: DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 2, 15, 0)),
      size: 448,
    };
    const upload = Effect.runSync(Translate.toUpload(file, content));
    expect(upload).toEqual({
      name: "ME202610-20261101T021500Z.DAT",
      title: "Month-end extract ME202610.DAT",
      contentType: "application/octet-stream",
      content,
    });
    // The store's own input schema accepts it as is.
    expect(Schema.encodeSync(Actions.StoreInput)(upload).name).toBe(
      upload.name,
    );
    const back = Effect.runSync(Translate.fromUpload(upload));
    // Everything but the size comes back; the size has nowhere to live.
    expect(back).toEqual({ name: file.name, modified: file.modified });
    expect(back).not.toHaveProperty("size");
    expectTypeOf(back).not.toHaveProperty("size");
    expectTypeOf<Actions.StoreInput>().not.toHaveProperty("size");

    const name = Schema.decodeSync(Translate.UploadName)(
      "ME202610-20261101T021500Z.DAT",
    );
    expect(Schema.encodeSync(Translate.UploadName)(name)).toBe(
      "ME202610-20261101T021500Z.DAT",
    );
    expect(
      encodeRefusal(Translate.UploadName, {
        name: "ME202610.DAT",
        modified: DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 2, 15, 0, 250)),
      }),
    ).toContain("whole seconds");
    for (const text of [
      "ME202610.DAT",
      "me202610-20261101T021500Z.dat",
      "ME202610-20261101T021500.DAT",
      "ME202610-2026-11-01T02:15:00Z.DAT",
    ])
      expect(refusal(Translate.UploadName, text)).toContain(
        "expected an upload name",
      );
    for (const text of [
      "ME202610-20261301T021500Z.DAT",
      "ME202610-20260230T021500Z.DAT",
      "ME202610-20261101T241500Z.DAT",
    ])
      expect(refusal(Translate.UploadName, text)).toContain("not a real time");
  });

  it("[APP-3] encoding into the target's own schema makes drift a compile error", () => {
    const task = toTask(assignment());
    // The positive control: the business's own schema takes the translation's output.
    expect(Schema.encodeSync(Ops.TaskReplacement)(task)).toEqual(
      toWire(assignment()),
    );
    expectTypeOf(task).toEqualTypeOf<Ops.TaskReplacement>();

    // Three ways the business contract could drift, and one way the store's could.
    const Renamed = Schema.Struct({
      title: Schema.String,
      assignee: Ops.AssigneeId,
      priority: Ops.Priority,
      done: BusinessValues.YesNo,
    });
    const Named = Schema.Struct({
      ...Ops.TaskReplacement.fields,
      priority: Schema.Literals(["urgent", "high", "normal", "low"]),
    });
    const Extended = Schema.Struct({
      ...Ops.TaskReplacement.fields,
      project: Schema.NonEmptyString,
    });
    const Sized = Schema.Struct({
      ...Actions.StoreInput.fields,
      size: Schema.Int,
    });
    const Severe = Schema.Struct({
      ...AnnouncementDraft.fields,
      severity: Schema.Literals(["info", "warning"]),
    });
    expectTypeOf(task).not.toExtend<typeof Renamed.Type>();
    expectTypeOf(task).not.toExtend<typeof Named.Type>();
    expectTypeOf(task).not.toExtend<typeof Extended.Type>();

    const upload = Effect.runSync(
      Translate.toUpload(
        {
          name: "ME202610.DAT",
          modified: DateTime.makeUnsafe(0),
          size: 0,
        },
        new Uint8Array(),
      ),
    );
    const draft = Schema.encodeSync(Translate.AnnouncementFromSummary)(
      Schema.decodeUnknownSync(Translate.Summary)({
        period: "202610",
        assignee: "alovelace",
        tasks: [],
        skipped: 0,
        archived: { id: "DOC-000001", name: upload.name },
        published: `portal.${upload.name}`,
      }),
    );
    const entry = Schema.decodeUnknownSync(DirectoryEntry)({
      ACTIVE: "N",
      UID: "cbabbage",
      CN: "Charles Babbage",
      MAIL: "charles@identity.test",
      CREATETIMESTAMP: "20040315093100Z",
      MODIFYTIMESTAMP: "20121231235959Z",
    });

    // Never called: each line is a compile-time check that `pnpm check` verifies.
    const drifted = () => [
      // @ts-expect-error The business renamed assigneeId to assignee.
      Schema.encodeSync(Renamed)(task),
      // @ts-expect-error The business made priorities names.
      Schema.encodeSync(Named)(task),
      // @ts-expect-error The business added a required field the translation does not fill.
      Schema.encodeSync(Extended)(task),
      // @ts-expect-error A store that required a size would refuse the upload, which dropped it.
      Schema.encodeSync(Sized)(upload),
      // @ts-expect-error A required severity would refuse the rendered announcement.
      Schema.encodeSync(Severe)(draft),
      // @ts-expect-error A directory entry may be inactive; only an Assignee can be assigned work.
      Translate.assign(item(), entry),
    ];
    expect(typeof drifted).toBe("function");
  });
});
