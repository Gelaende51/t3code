// Notes how each finished run ended. The preview API has no timeline-note call, so
// the digest is a thread status plus a notification. Events are at-least-once, so
// recent delivery ids are kept in plugin storage and replays are skipped.
const KEY = "last-run";
const SEEN_KEY = "seen";
const MAX_SEEN = 100;

const OUTCOMES = {
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  interrupted: { label: "Interrupted", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const OPERATIONS = {
  "capture-checkpoint": "Saving the checkpoint failed.",
  "refresh-workspace": "Refreshing the workspace failed.",
  "record-finalized": "Recording the result failed.",
};

/** One line of at most `max` characters, with an ellipsis when cut. */
function oneLine(text, max) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function describe(event) {
  const thread = oneLine(event.thread?.title || "A thread", 60);
  if (event.type === "run.finalized") {
    const outcome = OUTCOMES[event.outcome] ?? {
      label: "Ended",
      tone: "neutral",
    };
    return {
      status: outcome.label,
      tone: outcome.tone,
      title: `${outcome.label}: ${thread}`,
      problem: event.outcome !== "completed",
    };
  }
  return {
    status: "Finishing failed",
    tone: "warning",
    title: `Finishing failed: ${thread}`,
    body: OPERATIONS[event.operation] ?? "Finishing the run failed.",
    problem: true,
  };
}

export function activate(context) {
  const { onEvent, notify, settings, status, storage } = context.proposed;

  onEvent(async (event) => {
    if (event.type !== "run.finalized" && event.type !== "run.finalization-failed") return;
    const digest = describe(event);
    if ((await settings.get("onlyProblems")) === true && !digest.problem) return;

    const stored = await storage.get(SEEN_KEY);
    const seen = Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
    if (seen.includes(event.deliveryId)) return;

    await status
      .set({
        threadId: event.threadId,
        key: KEY,
        text: digest.status,
        tone: digest.tone,
        tooltip: oneLine(digest.body ?? event.thread?.title ?? "This thread", 240),
      })
      .catch((error) => context.log.warn(`Could not set the run status: ${error.message}`));

    // Notifications are best effort; a rate limit must not make the page retry.
    await notify({
      title: digest.title,
      ...(digest.body === undefined ? {} : { body: digest.body }),
      tone: digest.tone,
      threadId: event.threadId,
    }).catch((error) => context.log.warn(`Could not notify about the run: ${error.message}`));

    seen.push(event.deliveryId);
    await storage.set(SEEN_KEY, seen.slice(-MAX_SEEN));
  });
}
