/**
 * APP-2: the month-end saga, the one consumer that ties the five services together.
 *
 * 1. **Extract.** Download the period's fixed-width extract from the reporting gateway, with the
 *    session placed by the one credential source.
 * 2. **Translate.** Resolve the assignee through the directory, which refuses inactive users, and
 *    translate every open item into a business task (`translate.ts`). Paid and cancelled items are
 *    not work and are skipped.
 * 3. **Tasks.** Create the tasks in the business API.
 * 4. **Archive.** Re-encode the extract through the gateway's own fixed-width schema and store the
 *    bytes in the document store over SOAP (`StoreDocument`), under an upload name that keeps the
 *    file's time.
 * 5. **Publish.** Push the same bytes through the portal facade, the store's JSON-to-SOAP proxy.
 * 6. **Announce.** Fetch a CSRF token and post a signed announcement to the notification service.
 * 7. **Confirm.** Search the business API for the period and check that the hits are exactly the
 *    created tasks and read back to the items they were written from.
 *
 * **Compensation.** When any step fails or the saga is interrupted after tasks were created, the
 * created tasks are deleted, newest first, through the method-override tunnel, because the business
 * API's gateway strips `DELETE`. Compensation runs uninterruptibly and drains the list it deletes
 * from, so it happens once whichever way the saga ends. The stored documents are not compensated:
 * the store keeps every month-end extract as an archive, and the bytes are valid whatever happened
 * to the announcement.
 */
import { Data, Effect, Equal, Exit, type Ref, Schema } from "effect";
import type { Cookies } from "effect/http";
import * as Ops from "../business/operations.js";
import { Extract } from "../gateway/index.js";
import * as Notify from "../notifications/index.js";
import { Actions } from "../soap-store/index.js";
import * as Credentials from "./credentials.js";
import * as Portal from "./portal.js";
import * as Services from "./services.js";
import * as Translate from "./translate.js";

export interface Origins {
  readonly identity: string;
  /** The business API's origin; the saga uses its `/v2` operations. */
  readonly business: string;
  readonly gateway: string;
  readonly store: string;
  readonly portal: string;
  readonly notifications: string;
}

export interface Config {
  readonly origins: Origins;
  readonly credentials: Credentials.Source;
  /** The notification service's HMAC secret for announcements. */
  readonly signingSecret: string;
  /** How the notification service's XSRF cookie travels; see the notification contract. */
  readonly csrfCookie: "by-hand" | "transport";
  /** An explicit cookie jar for the XSRF cookie, where the transport keeps none. */
  readonly jar?: Ref.Ref<Cookies.Cookies> | undefined;
}

export interface Input {
  /** `YYYYMM`. */
  readonly period: string;
  /** The directory uid of the person the tasks are assigned to. */
  readonly assignee: string;
}

export type Step =
  | "extract"
  | "assignee"
  | "translate"
  | "tasks"
  | "archive"
  | "publish"
  | "announce"
  | "confirm";

/** What compensation did for one created task. */
export interface Compensated {
  readonly id: Ops.TaskId;
  readonly outcome: "deleted" | "missing" | "failed";
}

/** A step failed; `reason` is the step's own typed outcome or error, unchanged. */
export class StepFailed extends Data.TaggedError("StepFailed")<{
  readonly step: Step;
  readonly reason: unknown;
  readonly compensated: ReadonlyArray<Compensated>;
}> {}

class Failure extends Data.TaggedError("Failure")<{
  readonly step: Step;
  readonly reason: unknown;
}> {}

/** The saga's result. */
export interface Report {
  readonly period: string;
  readonly assignee: string;
  readonly tasks: ReadonlyArray<Ops.TaskId>;
  readonly skipped: ReadonlyArray<{
    readonly account: string;
    readonly status: Translate.Status;
  }>;
  readonly archived: { readonly id: string; readonly name: string };
  readonly published: { readonly id: string; readonly name: string };
  readonly announcement: string;
  /** The assignments read back from the search hits, in the order the tasks were created. */
  readonly confirmed: ReadonlyArray<Translate.Assignment>;
}

const at =
  (step: Step) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Failure, R> =>
    Effect.mapError(effect, (reason) => new Failure({ step, reason }));

const fail = (step: Step, reason: unknown) =>
  Effect.fail(new Failure({ step, reason }));

const encodeBytes = Schema.encodeEffect(Extract.MonthEndExtract);
const encodeAnnouncement = Schema.encodeEffect(
  Translate.AnnouncementFromSummary,
);
const decodeAssignment = Schema.decodeEffect(Translate.AssignmentFromTask);

/** The saga's search text: every task it writes carries it in the notes. */
export const searchText = (period: string) => `Month-end ${period}:`;

export const make = (config: Config) => {
  const { origins, credentials } = config;
  const business = Credentials.business(credentials, `${origins.business}/v2`);
  const download = Services.extract(origins.gateway, credentials);
  const resolve = Services.assignee(origins.identity, credentials);
  const createTask = Ops.createTask(business);
  const deleteTask = Ops.deleteTask(business);
  const search = Ops.searchTasks(business);
  const store = Actions.operations(origins.store).storeDocument;
  const publish = Portal.publish(origins.portal);
  const notify = Notify.make({
    baseUrl: origins.notifications,
    token: Credentials.notifications(credentials),
    secret: config.signingSecret,
    csrfCookie: config.csrfCookie,
    jar: config.jar,
  });
  const announce = notify.announce();

  /** Delete what was created, newest first, exactly once: the list is drained as it is read. */
  const compensate = (created: Array<Ops.TaskId>) =>
    Effect.uninterruptible(
      Effect.suspend(() =>
        Effect.forEach(created.splice(0).toReversed(), (id) =>
          Effect.map(
            Effect.exit(deleteTask.execute({ path: id })),
            (exit): Compensated => ({
              id,
              outcome: Exit.isSuccess(exit)
                ? exit.value._tag === "Deleted"
                  ? "deleted"
                  : exit.value._tag === "NotFound"
                    ? "missing"
                    : "failed"
                : "failed",
            }),
          ),
        ),
      ),
    );

  const steps = (input: Input, created: Array<Ops.TaskId>) =>
    Effect.gen(function* () {
      // 1. Extract.
      const fetched = yield* at("extract")(
        download.execute({ period: input.period }),
      );
      if (fetched._tag !== "Extract") return yield* fail("extract", fetched);
      const { extract, file } = fetched.value;

      // 2. Translate, with the assignee resolved through the directory.
      const person = yield* at("assignee")(resolve.execute(input.assignee));
      const items = yield* at("translate")(
        Effect.forEach(extract.items, (item) =>
          Translate.itemOf(extract.period, item),
        ),
      );
      const active = items.filter((item) => Translate.isActive(item.status));
      const assignments = active.map((item) => Translate.assign(item, person));
      const drafts = yield* at("translate")(
        Effect.forEach(assignments, Translate.newTask),
      );

      // 3. Tasks.
      for (const body of drafts) {
        const result = yield* at("tasks")(createTask.execute({ body }));
        if (result._tag !== "Created") return yield* fail("tasks", result);
        created.push(result.value.id);
      }
      const tasks = [...created];

      // 4. Archive the re-encoded bytes over SOAP.
      const bytes = yield* at("archive")(encodeBytes(extract));
      const upload = yield* at("archive")(Translate.toUpload(file, bytes));
      const stored = yield* at("archive")(store.execute({ body: upload }));
      if (stored._tag !== "Stored") return yield* fail("archive", stored);

      // 5. Publish through the portal facade.
      const published = yield* at("publish")(publish.execute(upload));
      if (published._tag !== "Published")
        return yield* fail("publish", published);

      // 6. Announce.
      const draft = yield* at("announce")(
        encodeAnnouncement({
          period: input.period,
          assignee: person.uid,
          tasks,
          skipped: items.length - active.length,
          archived: { id: stored.id, name: upload.name },
          published: published.name,
        }),
      );
      const csrf = yield* at("announce")(notify.csrf.execute(undefined));
      const announced = yield* at("announce")(
        announce.execute({ csrf, announcement: draft }),
      );
      if (announced._tag !== "Announced")
        return yield* fail("announce", announced);

      // 7. Confirm through search.
      const found = yield* at("confirm")(
        search.execute({ query: { q: searchText(input.period) } }),
      );
      if (found._tag !== "Results") return yield* fail("confirm", found);
      const hits = new Map(found.value.hits.map((hit) => [hit.id, hit]));
      const confirmed: Array<Translate.Assignment> = [];
      for (const [index, id] of tasks.entries()) {
        const hit = hits.get(id);
        if (hit === undefined)
          return yield* fail("confirm", { _tag: "Missing", id });
        const assignment = yield* at("confirm")(
          decodeAssignment({
            title: hit.title,
            assigneeId: hit.assigneeId,
            priority: hit.priority,
            ...(hit.due === null ? {} : { due: hit.due }),
            ...(hit.notes === undefined ? {} : { notes: hit.notes }),
            done: hit.done,
          }),
        );
        // Equal compares the plain records structurally, and Option and DateTime by value.
        if (!Equal.equals(assignment, assignments[index]))
          return yield* fail("confirm", { _tag: "Changed", id, assignment });
        confirmed.push(assignment);
      }
      if (hits.size !== tasks.length)
        return yield* fail("confirm", {
          _tag: "Unexpected",
          ids: [...hits.keys()].filter((id) => !tasks.includes(id)),
        });

      return {
        period: input.period,
        assignee: person.uid,
        tasks,
        skipped: items
          .filter((item) => !Translate.isActive(item.status))
          .map((item) => ({ account: item.account, status: item.status })),
        archived: { id: stored.id, name: upload.name },
        published: { id: published.id, name: published.name },
        announcement: announced.value.id,
        confirmed,
      } satisfies Report;
    });

  /**
   * Run the saga. A failed step fails with {@link StepFailed}, after compensation, carrying what
   * compensation did. An interruption or a defect compensates as well, in a finalizer.
   */
  const run = (input: Input) =>
    Effect.suspend(() => {
      const created: Array<Ops.TaskId> = [];
      return steps(input, created).pipe(
        Effect.catch((failure: Failure) =>
          Effect.flatMap(compensate(created), (compensated) =>
            Effect.fail(
              new StepFailed({
                step: failure.step,
                reason: failure.reason,
                compensated,
              }),
            ),
          ),
        ),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.asVoid(compensate(created))
            : Effect.void,
        ),
      );
    });

  return { run };
};

export type Saga = ReturnType<typeof make>;
