// @effect-diagnostics nodeBuiltinImport:off -- Refusing FIFO swaps requires O_NONBLOCK, unavailable through Effect FileSystem.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class PluginViewFileError extends Schema.TaggedError<PluginViewFileError>()("PluginViewFileError", {
  cause: Schema.Defect(),
}) {}

const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

export const open = Effect.fn("PluginViews.openFile")(function* (path: string) {
  const file = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(path, OPEN_FLAGS),
      catch: (cause) => new PluginViewFileError({ cause }),
    }),
    (file) => Effect.promise(() => file.close()),
  );
  return {
    stat: Effect.tryPromise({
      try: () => file.stat(),
      catch: (cause) => new PluginViewFileError({ cause }),
    }),
    read: (buffer: Uint8Array) =>
      Effect.tryPromise({
        try: async () => (await file.read(buffer)).bytesRead,
        catch: (cause) => new PluginViewFileError({ cause }),
      }),
  };
});

export type ViewFile = Effect.Success<ReturnType<typeof open>>;
