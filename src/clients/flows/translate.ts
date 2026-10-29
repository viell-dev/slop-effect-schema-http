/**
 * APP-3: translation between services. A value decoded from one backend is encoded for another
 * through the target's own schema, so a change in the target's contract stops these translations
 * from compiling instead of sending something the target no longer accepts.
 *
 * The month-end saga reads items from the gateway's extract, assigns them to a directory user, and
 * writes them as business tasks. Each piece of that translation is stated here with its loss:
 *
 * - **Id spaces.** A gateway account number and a directory uid are identifiers elsewhere. Neither
 *   becomes a business identifier: the account is a visible `[00012345]` reference at the start of
 *   the task title, and the uid an `idp:<uid>` reference in the business's free-form assignee
 *   field. The business assigns its own task ids (`T-…`), and the branded types keep them apart.
 * - **Money to priority.** The business has four priorities and no amount field. The mapping from
 *   cents to priority is lossy, so the exact figure is also written into the task's notes, in the
 *   business's own dollar format; reading a task back recovers the amount from the notes and
 *   refuses a priority that disagrees with it.
 * - **An active flag recovered from status.** The extract carries a status (`open`, `paid`,
 *   `cancelled`), the business a `done` flag. Only an open item is active work; the flag is
 *   recovered from the status, and the status word is kept in the notes because the flag alone
 *   cannot tell paid from cancelled.
 * - **One-way.** The announcement is prose for people: rendering a saga summary into it works,
 *   and reading a summary back from an announcement fails with that reason.
 * - **Assignees.** Only an active directory entry can be assigned work; the translation takes the
 *   identity contract's `Assignee`, which decoding refuses for an inactive or missing user.
 * - **File to upload.** The gateway's download has a name, a modification time and a size. The
 *   store's upload has a name and content. The time is kept in the upload's name; the size is
 *   dropped, visibly, because the upload has nowhere to put it and the store counts its own.
 */
import {
  DateTime,
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as BusinessValues from "../../values/business.js";
import { Cents as GatewayCents } from "../../values/gateway.js";
import * as Ops from "../business/operations.js";
import type { ExtractItem } from "../gateway/extract.js";
import { AccountNumber, Period } from "../gateway/pipe.js";
import { type Assignee, Uid } from "../identity/schemas.js";
import { AnnouncementDraft } from "../notifications/schemas.js";
import type { StoreInput } from "../soap-store/actions.js";

const issue = (input: unknown, message: string) =>
  new SchemaIssue.InvalidValue({ message }, input);

const refuse = (input: unknown, message: string) =>
  Effect.fail(issue(input, message));

// ---------------------------------------------------------------------------------------------
// Id spaces
// ---------------------------------------------------------------------------------------------

/** A gateway account number, branded into the gateway's id space. */
export const Account = AccountNumber.pipe(Schema.brand("GatewayAccount"));
export type Account = typeof Account.Type;

/**
 * An extract title as the fixed-width file can hold it: at most 30 characters, without the padding
 * spaces the file adds, and not blank.
 */
export const ItemTitle = Schema.String.check(
  Schema.makeFilter((title: string) =>
    title.length === 0 || title.length > 30 || title.trim() !== title
      ? "an extract title is 1 to 30 characters without surrounding spaces"
      : undefined,
  ),
);

/** A business task title carrying the account as a visible reference: `[00012345] Café Müller`. */
export const ReferencedTitle = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ account: Account, title: ItemTitle }),
    SchemaTransformation.transformEffect({
      decode: (text: string) => {
        const match = /^\[(\d{8})\] (.*)$/.exec(text);
        return match === null
          ? refuse(
              text,
              "expected a title that starts with the gateway account, as [00012345]",
            )
          : Effect.succeed({ account: match[1]!, title: match[2]! });
      },
      encode: ({ account, title }) => Effect.succeed(`[${account}] ${title}`),
    }),
  ),
);

/**
 * A directory uid carried in the business's free-form assignee field as `idp:<uid>`. Business user
 * ids such as `u-ada` belong to another id space and are refused rather than read as a uid.
 */
export const AssigneeReference = Ops.AssigneeId.pipe(
  Schema.decodeTo(
    Uid,
    SchemaTransformation.transformEffect({
      decode: (id: string) =>
        id.startsWith("idp:")
          ? Effect.succeed(id.slice("idp:".length))
          : refuse(
              id,
              "not a directory reference: only idp:<uid> names a directory user",
            ),
      encode: (uid: string) => Effect.succeed(`idp:${uid}`),
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Money, priority and status
// ---------------------------------------------------------------------------------------------

export const Status = Schema.Literals(["open", "paid", "cancelled"]);
export type Status = typeof Status.Type;

/** The active flag recovered from the extract's status: only an open item is work to do. */
export const isActive = (status: Status): boolean => status === "open";

export type Priority = typeof Ops.Priority.Type;

/**
 * The lossy mapping: $10,000.00 and more is urgent (1), $1,000.00 high (2), $100.00 normal (3),
 * anything less low (4). Many amounts share a priority; the notes keep the figure.
 */
export const priorityOf = (amount: GatewayCents): Priority =>
  amount >= 1_000_000 ? 1 : amount >= 100_000 ? 2 : amount >= 10_000 ? 3 : 4;

/** Gateway cents as business cents: both are integer cents, under different brands. */
export const toBusinessCents = (amount: GatewayCents): BusinessValues.Cents =>
  BusinessValues.Cents.make(amount);

const NotesFields = Schema.Struct({
  period: Period,
  amount: Schema.toType(GatewayCents),
  status: Status,
});

const encodeDollars = Schema.encodeEffect(BusinessValues.DollarString);
const decodeDollars = Schema.decodeEffect(BusinessValues.DollarString);

/**
 * The text field that makes the priority reversible and keeps the status word:
 * `Month-end 202610: $1,234.50 open`. The amount is written and read with the business's own
 * dollar format, so an unformatted figure such as `1234.50` is refused.
 */
export const MonthEndNotes = Schema.String.pipe(
  Schema.decodeTo(
    NotesFields,
    SchemaTransformation.transformEffect({
      decode: (text: string) => {
        const match = /^Month-end (\d{6}): (\S+) (open|paid|cancelled)$/.exec(
          text,
        );
        if (match === null)
          return refuse(
            text,
            "expected notes as `Month-end <YYYYMM>: <$amount> <status>`",
          );
        const [, period, figure, status] = match;
        return decodeDollars(figure!).pipe(
          Effect.mapError((error) => error.issue),
          Effect.flatMap((cents) =>
            cents < 0
              ? refuse(text, "an extract amount is never negative")
              : Effect.succeed({
                  period: period!,
                  amount: GatewayCents.make(cents),
                  status: status as Status,
                }),
          ),
        );
      },
      encode: ({ period, amount, status }) =>
        encodeDollars(toBusinessCents(amount)).pipe(
          Effect.mapError((error) => error.issue),
          Effect.map((figure) => `Month-end ${period}: ${figure} ${status}`),
        ),
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Items and tasks
// ---------------------------------------------------------------------------------------------

/** One extract item in the flows' terms: the gateway's values, under the gateway's brands. */
export const MonthEndItem = Schema.Struct({
  period: Period,
  account: Account,
  title: ItemTitle,
  amount: Schema.toType(GatewayCents),
  due: Schema.Option(Schema.DateTimeUtc),
  status: Status,
});
export type MonthEndItem = typeof MonthEndItem.Type;

/** An item and the directory user who will work on it, by uid. */
export const Assignment = Schema.Struct({ item: MonthEndItem, assignee: Uid });
export type Assignment = typeof Assignment.Type;

/** The item of an extract, refusing an account number or title the item cannot hold. */
export const itemOf = (
  period: string,
  item: ExtractItem,
): Effect.Effect<MonthEndItem, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(MonthEndItem)({
    period,
    account: item.account,
    title: item.title,
    amount: item.amount,
    due: item.due,
    status: item.status,
  });

/**
 * Assign an item. The assignee is the identity contract's `Assignee`, an entry decoding has already
 * found active; a `DirectoryEntry` that may be inactive does not type-check here.
 */
export const assign = (item: MonthEndItem, assignee: Assignee): Assignment => ({
  item,
  assignee: assignee.uid,
});

const encodeTitle = Schema.encodeSync(ReferencedTitle);
const encodeAssignee = Schema.encodeSync(AssigneeReference);

/** Midnight UTC: the gateway's dates are calendar dates. */
const isCalendarDate = (date: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(date) % 86_400_000 === 0;

/**
 * The business write model for an assignment, in the business contract's own type. The return
 * type is the target's schema type, so a field the business renames, retypes or adds stops this
 * from compiling.
 */
const toTask = (
  { item, assignee }: Assignment,
  notes: string,
): Ops.TaskReplacement => ({
  title: encodeTitle({ account: item.account, title: item.title }),
  assigneeId: encodeAssignee(assignee),
  priority: priorityOf(item.amount),
  ...(Option.isSome(item.due) ? { due: item.due.value } : {}),
  notes,
  done: !isActive(item.status),
});

const decodeTitle = Schema.decodeEffect(ReferencedTitle);
const decodeAssignee = Schema.decodeEffect(AssigneeReference);
const decodeNotes = Schema.decodeEffect(MonthEndNotes);
const encodeNotes = Schema.encodeEffect(MonthEndNotes);

const fromTask = (task: Ops.TaskReplacement) =>
  Effect.gen(function* () {
    const { account, title } = yield* decodeTitle(task.title);
    const assignee = yield* decodeAssignee(task.assigneeId);
    if (task.notes === undefined)
      return yield* refuse(
        task,
        "the notes are missing, so the amount behind the priority is unknown",
      );
    const notes = yield* decodeNotes(task.notes);
    const expected = priorityOf(notes.amount);
    if (task.priority !== expected)
      return yield* refuse(
        task,
        `priority ${task.priority} disagrees with the amount in the notes, which maps to ${expected}`,
      );
    if (task.done === isActive(notes.status))
      return yield* refuse(
        task,
        `done is ${task.done ? "Y" : "N"}, but the notes say the item is ${notes.status}`,
      );
    let due: Option.Option<DateTime.Utc> = Option.none();
    if (task.due !== undefined) {
      if (!DateTime.isUtc(task.due) || !isCalendarDate(task.due))
        return yield* refuse(
          task,
          "a due date from the extract is a calendar date at midnight UTC",
        );
      due = Option.some(task.due);
    }
    return {
      item: {
        period: notes.period,
        account,
        title,
        amount: notes.amount,
        due,
        status: notes.status,
      },
      assignee,
    };
  }).pipe(
    Effect.mapError((error) =>
      Schema.isSchemaError(error) ? error.issue : error,
    ),
  );

/**
 * An assignment as the business's write model (`TaskReplacement`), both directions. Decoding a task
 * the flows wrote recovers the assignment exactly; a task whose priority, flag or notes disagree,
 * or whose references point at another id space, is refused.
 */
export const AssignmentFromTask = Schema.toType(Ops.TaskReplacement).pipe(
  Schema.decodeTo(
    Assignment,
    SchemaTransformation.transformEffect({
      decode: (task: Ops.TaskReplacement) => fromTask(task),
      encode: (assignment: typeof Assignment.Encoded) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeEffect(Assignment)(
            assignment,
          ).pipe(Effect.mapError((error) => error.issue));
          if (
            Option.isSome(decoded.item.due) &&
            !isCalendarDate(decoded.item.due.value)
          )
            return yield* refuse(
              assignment,
              "a due date from the extract is a calendar date at midnight UTC",
            );
          const notes = yield* encodeNotes({
            period: decoded.item.period,
            amount: decoded.item.amount,
            status: decoded.item.status,
          }).pipe(Effect.mapError((error) => error.issue));
          return toTask(decoded, notes);
        }),
    }),
  ),
);

/** The same codec over the business's JSON wire form, encoded by the business's own schema. */
export const AssignmentFromWire = Ops.TaskReplacement.pipe(
  Schema.decodeTo(AssignmentFromTask),
);

/**
 * The task the saga creates for an active assignment: the write model without `done`, which the
 * service sets to `N` on creation. An inactive item is not work and is refused with that reason.
 */
export const newTask = (
  assignment: Assignment,
): Effect.Effect<Ops.NewTask, Schema.SchemaError> =>
  isActive(assignment.item.status)
    ? Effect.map(
        Schema.encodeEffect(AssignmentFromTask)(assignment),
        ({ done: _done, ...task }): Ops.NewTask => task,
      )
    : Effect.fail(
        new Schema.SchemaError(
          issue(
            assignment,
            `a ${assignment.item.status} item is not work: only open items become tasks`,
          ),
        ),
      );

// ---------------------------------------------------------------------------------------------
// One-way: the announcement
// ---------------------------------------------------------------------------------------------

export const Summary = Schema.Struct({
  period: Period,
  assignee: Uid,
  tasks: Schema.Array(Ops.TaskId),
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  archived: Schema.Struct({ id: Schema.String, name: Schema.String }),
  published: Schema.String,
});
export type Summary = typeof Summary.Type;

const ONE_WAY =
  "one-way: an announcement is prose for people and does not carry the task ids, so a summary cannot be read back from one";

/**
 * The saga's summary rendered as the notification service's announcement, in that service's own
 * draft type. Encoding renders; decoding fails with the reason, rather than parsing prose.
 */
export const AnnouncementFromSummary = Schema.toType(AnnouncementDraft).pipe(
  Schema.decodeTo(
    Summary,
    SchemaTransformation.transformEffect({
      decode: (draft: AnnouncementDraft) => refuse(draft, ONE_WAY),
      encode: (summary: typeof Summary.Encoded) =>
        Effect.succeed<AnnouncementDraft>({
          channel: "month-end",
          subject: `Month-end ${summary.period} closed`,
          body:
            `${summary.tasks.length} task(s) for idp:${summary.assignee} (${summary.tasks.join(", ") || "none"}); ` +
            `${summary.skipped} item(s) were not open. ` +
            `Extract archived as ${summary.archived.id} (${summary.archived.name}) and published as ${summary.published}.`,
        }),
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// File to upload
// ---------------------------------------------------------------------------------------------

/** The mainframe's download name, as the gateway's `Content-Disposition` gives it. */
export const DownloadName = Schema.String.check(
  Schema.isPattern(/^ME\d{6}\.DAT$/),
);

/** The download as the gateway describes it in its response headers. */
export const GatewayFile = Schema.Struct({
  name: DownloadName,
  modified: Schema.DateTimeUtc,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type GatewayFile = typeof GatewayFile.Type;

/** What an upload keeps of a download: its name and modification time, without the size. */
export const ArchivedFile = Schema.Struct({
  name: DownloadName,
  modified: Schema.DateTimeUtc,
});
export type ArchivedFile = typeof ArchivedFile.Type;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * The upload name: the download name with its modification time inserted, whole seconds in UTC,
 * `ME202610-20261101T021500Z.DAT`. A time with milliseconds is refused rather than truncated.
 */
export const UploadName = Schema.String.pipe(
  Schema.decodeTo(
    ArchivedFile,
    SchemaTransformation.transformEffect({
      decode: (text: string) => {
        const match =
          /^(ME\d{6})-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.DAT$/.exec(
            text,
          );
        if (match === null)
          return refuse(
            text,
            "expected an upload name as ME<YYYYMM>-<YYYYMMDD>T<HHMMSS>Z.DAT",
          );
        const [year, month, day, hour, minute, second] = match
          .slice(2)
          .map(Number) as [number, number, number, number, number, number];
        const millis = Date.UTC(year, month - 1, day, hour, minute, second);
        const date = new Date(millis);
        if (
          year < 1970 ||
          date.getUTCMonth() !== month - 1 ||
          date.getUTCDate() !== day ||
          hour > 23 ||
          minute > 59 ||
          second > 59
        )
          return refuse(text, "the time in the upload name is not a real time");
        return Effect.succeed({
          name: `${match[1]!}.DAT`,
          modified: DateTime.makeUnsafe(millis),
        });
      },
      encode: ({ name, modified }) => {
        const millis = DateTime.toEpochMillis(modified);
        if (millis % 1000 !== 0)
          return refuse(
            modified,
            "an upload name holds whole seconds; this time has milliseconds",
          );
        const date = new Date(millis);
        const stamp =
          `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
          `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
        return Effect.succeed(name.replace(/\.DAT$/, `-${stamp}.DAT`));
      },
    }),
  ),
);

/** The upload for a download, in the store's own input type. The size is dropped here. */
export const toUpload = (
  file: GatewayFile,
  content: Uint8Array,
): Effect.Effect<StoreInput, Schema.SchemaError> =>
  Effect.map(
    Schema.encodeEffect(UploadName)({
      name: file.name,
      modified: file.modified,
    }),
    (name): StoreInput => ({
      name,
      title: `Month-end extract ${file.name}`,
      contentType: "application/octet-stream",
      content,
    }),
  );

/** What an upload tells about its download: the name and time. The size is not recoverable. */
export const fromUpload = (
  upload: StoreInput,
): Effect.Effect<ArchivedFile, Schema.SchemaError> =>
  Schema.decodeEffect(UploadName)(upload.name);
