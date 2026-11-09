# Goal command

A test addon for T3 Code's plugin system. It adds a per-thread goal:

> **This is not T3 Code's native `/goal`.** Codex and Claude threads already support
> `/goal <objective>`, which the provider enforces across turns. This addon targets providers without
> a native goal loop, and it can only inject context and gate approvals. If you use a Codex or Claude
> thread, prefer the native command and leave this plugin out of that workflow.

1. Run `/goal` from the composer (or the command palette / thread menu).
2. The next message you send becomes the thread's goal. The agent receives it as context on that
   turn and every later turn, until you clear it.
3. Run `/goal` again to clear the goal.

While a goal is active, the plugin also uses the `approvals` capability as a guard: it denies
`file-change` requests for paths outside the thread's working directory (configurable under
**Settings** > **Plugins**), and, if you list command prefixes, denies commands that match none of
them. It never auto-approves anything; a request it does not deny still waits for you.

Capabilities: `actions` (`/goal`), `status` (the goal line), `settings` (storage and the guard
settings), `transforms` (context injection), `approvals` (the guard).

## Install

1. Copy this directory to the machine that runs the T3 Code server.
2. In the web or desktop app, connected with administrative access, open **Settings** > **Plugins**, choose **Add plugin** and enter the copy's absolute path.
3. Review the files and capabilities, then choose **Approve and enable**.
4. In a thread, type `/goal`, pick the command, then send the goal as your next message.

## What it can and cannot enforce

- The goal is injected as context; the agent is told to stay on it, but no plugin can force a
  provider to comply.
- The approval guard only sees requests the provider actually sends. A thread in **Full access**
  usually sends none, so the guard does not run there.
- File-change subjects come from the provider as paths. A request without them is left to you, and
  relative paths are resolved against the thread's working directory captured when `/goal` ran.
- Command prefixes are a blunt allowlist. Allowing `git` also allows `git push --force`; the plugin
  only denies, it never approves.
- Goals and the guard settings live in plugin storage, so they survive restarts. The status line is
  memory-only and comes back on the next turn.
