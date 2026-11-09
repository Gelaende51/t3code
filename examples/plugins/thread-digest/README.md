# Thread digest

A port of the ashx plugin SDK's `thread-digest` example to the official preview API. It notes how
each finished run ended.

The preview API has no timeline-note call, so the digest is two things:

- a **last-run status** on the thread (`Completed`, `Failed`, `Interrupted`, `Cancelled`, or
  `Finishing failed`);
- a **notification** with the thread title and the outcome, which opens the thread.

Runs that finished while the plugin was disabled are replayed on the next enable, because the
event cursor is retained. Events are at-least-once, so the plugin keeps the last 100 delivery IDs
in storage and skips repeats.

Capabilities: `events`, `settings` (storage and the one field), `status`, `notifications`.

## Settings

**Only failed or stopped runs** — leave it off to note every finished run; turn it on to skip
completed runs.

## Install

1. Copy this directory to the machine that runs the T3 Code server.
2. In the web or desktop app, connected with administrative access, open **Settings** > **Plugins**, choose **Add plugin** and enter the copy's absolute path.
3. Review the files and capabilities, then choose **Approve and enable**.
4. Finish a turn in a thread to see the status and notification.

## Limits

- The event carries the outcome and the thread title, not the run's start time, so this port cannot
  show a duration.
- Notifications are best-effort and rate-limited; a burst of runs can skip some. The status
  remains the part that stays visible while the plugin runs.
- Statuses are kept in server memory and disappear when the plugin stops or the server restarts.
- The host keeps at most 16 statuses per plugin and 3 plugins' statuses per thread. Past either
  limit a new status is refused, so older threads keep their digest and a newer run may not get
  one; the notification is still attempted.
