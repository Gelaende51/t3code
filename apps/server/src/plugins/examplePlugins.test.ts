import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  contributionStatusSourceKey,
  EnvironmentId,
  type PluginInstallationId,
  PluginEventPage,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ContributionStatusStore from "@t3tools/provider-core/server/ContributionStatusStore";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import { PLUGIN_EVENTS_HANDLER } from "./pluginIpcFraming.ts";
import * as PluginNotifications from "./PluginNotifications.ts";
import * as PluginSettings from "./PluginSettings.ts";
import * as PluginStatus from "./PluginStatus.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import * as PluginTools from "./PluginTools.ts";

// The example plugins under examples/plugins, run exactly as a user would install them.
const EXAMPLES_DIR = `${import.meta.dirname}/../../../../examples/plugins`;
// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;

const environmentId = EnvironmentId.make("environment:examples");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePage = Schema.decodeUnknownSync(PluginEventPage);

/** A secret store in memory; the examples declare no secrets. */
const secretStore = () => {
  const entries = new Map<string, Uint8Array>();
  return ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(entries.get(name))),
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    create: (name, value) => Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = entries.get(name) ?? new Uint8Array(bytes);
        entries.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void entries.delete(name)),
  });
};

/** The plugin services one server start runs, with a real supervisor and child processes. */
const start = Effect.fn("start")(function* () {
  const supervisor = yield* PluginSupervisor.make({
    heapLimitMb: 64,
    activationTimeout: "10 seconds",
    stopGrace: "1 second",
  }).pipe(Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]));
  const catalog = yield* PluginCatalog.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
  );
  const store = yield* ContributionStatusStore.make();
  yield* PluginStatus.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(ContributionStatusStore.ContributionStatusStore, store),
  );
  const notifications = yield* PluginNotifications.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
  );
  const settings = yield* PluginSettings.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
    Effect.provideService(ServerSecretStore, secretStore()),
  );
  const tools = yield* PluginTools.make.pipe(
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
  );

  /** Copies an example to a scoped directory, then adds, approves and enables it. */
  const install = Effect.fn("install")(function* (example: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-example-" }),
      example,
    );
    yield* fs.copy(path.join(EXAMPLES_DIR, example), directory);
    const { installation } = yield* catalog.add({ directory });
    assert.strictEqual(installation.problem, null);
    const installationId = installation.installationId;
    yield* catalog.consent({ installationId, digest: installation.source!.digest });
    yield* catalog.enable({ installationId });
    return installationId;
  });

  /**
   * Delivers turn events to a plugin as the event feed would: `run.finalized` with
   * `outcome`, or `run.finalization-failed` with `operation`.
   */
  const finishTurns = (
    installationId: PluginInstallationId,
    turns: ReadonlyArray<
      { readonly threadId: ThreadId; readonly title: string } & (
        | { readonly outcome: string }
        | { readonly operation: string }
      )
    >,
    idPrefix = "event",
  ) => {
    const events = turns.map((turn, index) => ({
      ...("outcome" in turn
        ? { type: "run.finalized", outcome: turn.outcome }
        : { type: "run.finalization-failed", operation: turn.operation }),
      deliveryId: `${idPrefix}-${index}`,
      sequence: index,
      occurredAt: "2026-10-04T00:00:00.000Z",
      environmentId,
      threadId: turn.threadId,
      runId: `run-${index}`,
      thread: { projectId: "project-a", title: turn.title },
    }));
    // Checks the page is exactly what the feed sends.
    decodePage({ events });
    return catalog.invoke(installationId, PLUGIN_EVENTS_HANDLER, { events });
  };

  return { catalog, store, notifications, settings, tools, install, finishTurns };
});

/** `thread: source item=text (tone)` per plugin status, in snapshot order. */
const statuses = (store: ContributionStatusStore.ContributionStatusStoreShape) =>
  store.snapshot.pipe(
    Effect.map((snapshot) =>
      snapshot.entries.flatMap((entry) =>
        entry.items.map(
          (item) =>
            `${entry.threadId}: ${contributionStatusSourceKey(entry.source)} ${item.key}=${item.text} (${item.tone ?? "neutral"})`,
        ),
      ),
    ),
  );

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory), Effect.scoped);

it.layer(NodeServices.layer)("example plugins", (it) => {
  describe("turn-notifier", () => {
    it.effect("preserves each turn outcome when long thread names are truncated", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications } = yield* start();
          const installationId = yield* install("turn-notifier");
          const title = "x".repeat(100);
          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title, outcome: "completed" },
            { threadId: THREAD_A, title, outcome: "failed" },
            { threadId: THREAD_A, title, outcome: "interrupted" },
            { threadId: THREAD_A, title, outcome: "cancelled" },
            { threadId: THREAD_A, title, operation: "capture-checkpoint" },
          ]);
          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ title }) => title.split(": ")[0]),
            ["finished", "failed", "was interrupted", "was cancelled", "Finishing the turn failed"],
          );
          assert.isTrue(frame.notifications.every(({ title }) => title.length <= 80));
        }),
      ),
    );

    it.effect("notifies once per finished turn, naming the thread and the outcome", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications } = yield* start();
          const installationId = yield* install("turn-notifier");
          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "Fix login", outcome: "completed" },
            { threadId: THREAD_B, title: "Upgrade deps", outcome: "failed" },
          ]);
          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ pluginId, title, tone, threadId }) => ({
              pluginId,
              title,
              tone,
              threadId,
            })),
            [
              {
                pluginId: "example.turn-notifier",
                title: "finished: Fix login",
                tone: "success",
                threadId: THREAD_A,
              },
              {
                pluginId: "example.turn-notifier",
                title: "failed: Upgrade deps",
                tone: "error",
                threadId: THREAD_B,
              },
            ],
          );
        }),
      ),
    );

    it.effect("notifies when finishing a turn fails, naming the failed step", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications } = yield* start();
          const installationId = yield* install("turn-notifier");
          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "Fix login", operation: "capture-checkpoint" },
          ]);
          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ title, body, tone, threadId }) => ({
              title,
              body,
              tone,
              threadId,
            })),
            [
              {
                title: "Finishing the turn failed: Fix login",
                body: "Saving the checkpoint failed.",
                tone: "warning",
                threadId: THREAD_A,
              },
            ],
          );
        }),
      ),
    );
  });

  describe("todo-count", () => {
    it.effect("offers agents a tool that counts TODO and FIXME comments by file", () =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { install, tools } = yield* start();
          yield* install("todo-count");
          const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-todo-project-" });
          yield* fs.makeDirectory(path.join(project, "src"));
          yield* fs.makeDirectory(path.join(project, "node_modules"));
          yield* fs.writeFileString(
            path.join(project, "src", "a.ts"),
            "// TODO: one\n// FIXME: two\n// TODOS is not a marker\n",
          );
          yield* fs.writeFileString(path.join(project, "b.md"), "TODO: three\n");
          yield* fs.writeFileString(path.join(project, "node_modules", "c.js"), "// TODO skip\n");

          // The agent's path: the declared schema is checked before the plugin runs.
          const grants = yield* tools.grants;
          const listed = yield* tools.list(grants);
          assert.deepStrictEqual(
            listed.tools.map((tool) => tool.tool),
            ["example.todo-count/count_todos"],
          );
          const context = { environmentId, threadId: THREAD_A };
          const result = yield* tools.call(grants, {
            tool: "example.todo-count/count_todos",
            input: { directory: project, top: 5 },
            context,
          });
          assert.deepStrictEqual(result, {
            total: 3,
            filesScanned: 2,
            truncated: false,
            files: [
              { path: path.join("src", "a.ts"), count: 2 },
              { path: "b.md", count: 1 },
            ],
          });
          const invalid = yield* tools
            .call(grants, {
              tool: "example.todo-count/count_todos",
              input: { top: 5 },
              context,
            })
            .pipe(Effect.flip);
          assert.strictEqual(invalid.reason, "invalid-input");
          const relative = yield* tools
            .call(grants, {
              tool: "example.todo-count/count_todos",
              input: { directory: "src" },
              context,
            })
            .pipe(Effect.flip);
          assert.strictEqual(relative.reason, "failed");
          assert.include(relative.message, "absolute directory path");
        }),
      ),
    );
  });

  describe("goal-command", () => {
    it.effect("captures the next message as the goal, injects it, and gates approvals", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, install, settings, store } = yield* start();
          const installationId = yield* install("goal-command");
          const source = toJson(["plugin", "example.goal"]);
          const target = {
            kind: "thread",
            threadId: THREAD_A,
            projectId: "project-a",
            cwd: "/work/project-a",
            branch: "main",
          };
          const approvalContext = {
            environmentId,
            projectId: "project-a",
            threadId: THREAD_A,
            runId: "run-1",
            provider: "codex",
          };
          const enrich = (text: string) =>
            catalog.invoke(installationId, "t3.transform.enrich", {
              environmentId,
              projectId: "project-a",
              threadId: THREAD_A,
              runId: "run-1",
              cwd: "/work/project-a",
              message: { text, truncated: false },
            });
          const decide = (kind: string, subject: string) =>
            catalog.invoke(installationId, "t3.approval.decide", {
              requestId: `request-${kind}-${subject.length}`,
              kind,
              prompt: "Allow this?",
              subject,
              context: approvalContext,
            });
          const contextOf = (result: Schema.Json) =>
            (result as { context: ReadonlyArray<{ title: string; text: string }> }).context;

          assert.deepStrictEqual(
            yield* catalog.invoke(installationId, "action:goal", { action: "goal", target }),
            { message: "Describe the goal in your next message." },
          );
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-a: ${source} goal=Goal: describe it in your next message (warning)`,
          ]);

          const captured = contextOf(yield* enrich("Ship the login rewrite"));
          assert.strictEqual(captured[0]?.title, "Thread goal");
          assert.match(captured[0]?.text ?? "", /Ship the login rewrite/);
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-a: ${source} goal=Goal: Ship the login rewrite (info)`,
          ]);

          const later = contextOf(yield* enrich("Check the tests"));
          assert.match(later[0]?.text ?? "", /Ship the login rewrite/);

          assert.deepStrictEqual(yield* decide("file-change", "src/login.ts"), null);
          const outside = (yield* decide("file-change", "/tmp/outside.ts")) as {
            decision: string;
            reason: string;
          };
          assert.strictEqual(outside.decision, "deny");
          assert.include(outside.reason, "/work/project-a");

          yield* settings.update({
            installationId,
            changes: [{ key: "allowedCommands", value: "pnpm test\ngit status" }],
          });
          assert.deepStrictEqual(yield* decide("command", "pnpm test --run"), null);
          const blocked = (yield* decide("command", "curl http://example.com")) as {
            decision: string;
          };
          assert.strictEqual(blocked.decision, "deny");

          assert.deepStrictEqual(
            yield* catalog.invoke(installationId, "action:goal", { action: "goal", target }),
            { message: "Goal cleared." },
          );
          assert.deepStrictEqual(yield* statuses(store), []);
          assert.deepStrictEqual(yield* enrich("Anything else?"), null);
        }),
      ),
    );
  });

  describe("thread-digest", () => {
    it.effect("notes each finished run as a status and a notification", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications, store } = yield* start();
          const installationId = yield* install("thread-digest");
          const source = toJson(["plugin", "example.thread-digest"]);

          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "Fix login", outcome: "completed" },
            { threadId: THREAD_B, title: "Upgrade deps", outcome: "failed" },
            { threadId: THREAD_A, title: "Fix login", operation: "capture-checkpoint" },
          ]);

          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ title, body, tone, threadId }) => ({
              title,
              body: body ?? null,
              tone,
              threadId,
            })),
            [
              {
                title: "Completed: Fix login",
                body: null,
                tone: "success",
                threadId: THREAD_A,
              },
              {
                title: "Failed: Upgrade deps",
                body: null,
                tone: "error",
                threadId: THREAD_B,
              },
              {
                title: "Finishing failed: Fix login",
                body: "Saving the checkpoint failed.",
                tone: "warning",
                threadId: THREAD_A,
              },
            ],
          );
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-a: ${source} last-run=Finishing failed (warning)`,
            `thread-b: ${source} last-run=Failed (error)`,
          ]);
        }),
      ),
    );

    it.effect("can note only failed or stopped runs", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications, settings, store } = yield* start();
          const installationId = yield* install("thread-digest");
          const source = toJson(["plugin", "example.thread-digest"]);
          yield* settings.update({
            installationId,
            changes: [{ key: "onlyProblems", value: true }],
          });

          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "Done", outcome: "completed" },
            { threadId: THREAD_B, title: "Stopped", outcome: "interrupted" },
          ]);

          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ title, tone, threadId }) => ({ title, tone, threadId })),
            [{ title: "Interrupted: Stopped", tone: "warning", threadId: THREAD_B }],
          );
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-b: ${source} last-run=Interrupted (warning)`,
          ]);
        }),
      ),
    );

    it.effect("does not note a redelivered event twice", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications } = yield* start();
          const installationId = yield* install("thread-digest");
          const page = [{ threadId: THREAD_A, title: "Fix login", outcome: "completed" }];

          yield* finishTurns(installationId, page, "first");
          yield* finishTurns(installationId, page, "first");
          yield* finishTurns(
            installationId,
            [{ threadId: THREAD_B, title: "Next", outcome: "failed" }],
            "second",
          );

          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ title }) => title),
            ["Completed: Fix login", "Failed: Next"],
          );
        }),
      ),
    );
  });

  describe("machine-label", () => {
    it.effect("labels threads that finish a turn with the configured label and color", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, settings, store } = yield* start();
          const installationId = yield* install("machine-label");
          const source = toJson(["plugin", "example.machine-label"]);

          // Without a label it shows the host name, in the default color.
          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "a", outcome: "completed" },
          ]);
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-a: ${source} machine=${NodeOS.hostname()} (info)`,
          ]);

          yield* settings.update({
            installationId,
            changes: [
              { key: "label", value: "Build box" },
              { key: "tone", value: "warning" },
            ],
          });
          yield* finishTurns(installationId, [
            { threadId: THREAD_B, title: "b", outcome: "interrupted" },
          ]);
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-a: ${source} machine=${NodeOS.hostname()} (info)`,
            `thread-b: ${source} machine=Build box (warning)`,
          ]);
        }),
      ),
    );
  });
});
