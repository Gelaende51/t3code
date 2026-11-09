// A goal is a per-thread objective. `/goal` arms the thread, the next message becomes
// the goal, and every later turn gets it as context. While a goal is active, approval
// requests that leave the thread's working directory are denied. The plugin can only
// gate what the provider asks about; the goal itself is enforced by the context.
import * as NodePath from "node:path";

const KEY = "goal";
const MAX_GOAL_CHARS = 4_000;
const pendingKey = (threadId) => `pending:${threadId}`;
const goalKey = (threadId) => `goal:${threadId}`;

const goalContext = (goal) => ({
  context: [
    {
      title: "Thread goal",
      text:
        `Active goal for this thread: ${goal}\n` +
        "Keep every action aligned with this goal, and say when it is complete. " +
        "Do not start unrelated work.",
    },
  ],
});

/** One line for the thread status; the host truncates it to its own limit. */
const statusText = (goal) => `Goal: ${goal.replace(/\s+/g, " ").trim()}`;

/** True when `candidate` resolves inside `directory`; a missing directory never blocks. */
function isInside(directory, candidate) {
  if (typeof directory !== "string" || directory.length === 0) return true;
  const base = NodePath.resolve(directory);
  const resolved = NodePath.resolve(base, candidate);
  return resolved === base || resolved.startsWith(`${base}${NodePath.sep}`);
}

export function activate(context) {
  const { handle, settings, status, storage } = context.proposed;

  handle("action:goal", async ({ target }) => {
    if (target.kind !== "thread") return { message: "Open a thread to use /goal." };
    const { threadId, cwd } = target;
    try {
      const active = await storage.get(goalKey(threadId));
      const pending = await storage.get(pendingKey(threadId));
      if (active !== undefined || pending !== undefined) {
        await storage.delete(goalKey(threadId));
        await storage.delete(pendingKey(threadId));
        await status.clear({ threadId, key: KEY });
        return { message: "Goal cleared." };
      }
      await storage.set(pendingKey(threadId), { cwd });
      await status.set({
        threadId,
        key: KEY,
        text: "Goal: describe it in your next message",
        tone: "warning",
        tooltip: "Run /goal again to cancel.",
      });
      return { message: "Describe the goal in your next message." };
    } catch (error) {
      context.log.warn(`Could not change the goal: ${error.message}`);
      return { message: "Could not change the goal." };
    }
  });

  handle("t3.transform.enrich", async ({ threadId, message }) => {
    const pending = await storage.get(pendingKey(threadId));
    if (pending !== undefined) {
      const text = message.text.trim();
      // An empty turn cannot become a goal; stay armed for the next one.
      if (text.length === 0) return null;
      const goal = text.slice(0, MAX_GOAL_CHARS);
      await storage.delete(pendingKey(threadId));
      await storage.set(goalKey(threadId), { text: goal, cwd: pending.cwd ?? null });
      await status
        .set({
          threadId,
          key: KEY,
          text: statusText(goal),
          tone: "info",
          tooltip: goal.slice(0, 240),
        })
        .catch((error) => context.log.warn(`Could not show the goal: ${error.message}`));
      return goalContext(goal);
    }
    const active = await storage.get(goalKey(threadId));
    return active === undefined ? null : goalContext(active.text);
  });

  handle("t3.approval.decide", async ({ kind, subject, context: { threadId } }) => {
    const active = await storage.get(goalKey(threadId));
    if (active === undefined) return null;

    if (kind === "file-change") {
      if (!(await settings.get("confineWrites"))) return null;
      const paths = (subject ?? "")
        .split("\n")
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
      // Without the changed paths the request cannot be judged; leave it to the user.
      if (paths.length === 0) return null;
      const outside = paths.filter((path) => !isInside(active.cwd, path));
      if (outside.length === 0) return null;
      return {
        decision: "deny",
        reason: `The active goal is confined to ${active.cwd}; ${outside.slice(0, 3).join(", ")} is outside it.`,
      };
    }

    if (kind === "command") {
      const configured = await settings.get("allowedCommands");
      if (typeof configured !== "string" || configured.trim().length === 0) return null;
      const allowed = configured
        .split("\n")
        .map((prefix) => prefix.trim())
        .filter((prefix) => prefix.length > 0);
      const command = (subject ?? "").trim();
      // No subject means no match to judge; the user still decides.
      if (command.length === 0) return null;
      if (allowed.some((prefix) => command.startsWith(prefix))) return null;
      return {
        decision: "deny",
        reason: `Not one of the active goal's allowed command prefixes: ${allowed.slice(0, 5).join(", ")}.`,
      };
    }

    return null;
  });
}
