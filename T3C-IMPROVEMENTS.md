# T3C improvements

Personal backlog for T3 Code. Workspace is this checkout (`~/t3code-src`).
Keep items concrete: symptom, evidence, root cause, proposal, tests.

## Backlog

- [ ] **1. Steer silently restarts the turn on restart-only providers (ACP)** — see §1
- [ ] **2. Invisible messages on some new threads** — see §2

---

## 1. Steer silently restarts the turn on restart-only providers (ACP)

### Symptom

On an ACP provider (`dsh` / DeepSeek Harness, Copilot, Cursor) a steer sent while a
turn is running does not join the turn. T3 marks the active attempt `superseded` and
starts a new attempt with `reason: "steering_restart"`. The web timeline folds the
old attempt under **"Cut off by a steer"**.

Expected (what pi / OpenCode / Codex / Claude do): the message is queued by the
provider and delivered after the current assistant turn finishes its tool calls,
before the next LLM call. No attempt is replaced.

### Evidence

Debug thread `f25747b1-…` (DeepSeek pairing), 2026-11-08, provider `dsh`:

| attempt | reason                 | started      | ended                                           |
| ------- | ---------------------- | ------------ | ----------------------------------------------- |
| 1       | `initial`              | 15:08:32.870 | **superseded 15:15:03.937** (= steer timestamp) |
| 2       | **`steering_restart`** | 15:15:04.151 | failed 15:17:09 (`Insufficient Balance`)        |

Steer text: `you have the root pwd. you should be able to do everything yourself unattendedly`.

Cross-check of all 26 `inputIntent: "steer"` turn items in `~/.t3/userdata/statev2.sqlite`:

- `dsh`: **2 / 2** steers produced a `steering_restart` attempt.
- `pi`, `claudeAgent`, `codex`: **0** steers produced a new attempt.

So this is provider-dependent, not universal.

### Root cause

1. ACP has no mid-prompt input. `packages/provider-acp/src/server/adapter.ts`
   declares `supportsActiveSteering: false` and its `steerTurn` returns
   `ProviderAdapterSteerRunUnsupportedError` (~line 8147).
2. Server: `apps/server/src/orchestration-v2/CommandPolicy.ts`
   `resolveDeliveryIntent` returns `steer_active` for an explicit
   `deliveryIntent: "steer"` **before** looking at capabilities. Then
   `decideSteeringExecution` returns `interrupt_restart`, and
   `Orchestrator.dispatchSteerIntoRun` creates attempt N+1
   (`Orchestrator.ts:5117`).
3. Client inconsistency:
   - **web** sends `deliveryIntent: "steer"` for its Steer action
     (`packages/client-runtime/src/operations/commands.ts:779`).
   - **mobile** maps non-queue actions to `dispatchMode: "auto"`
     (`apps/mobile/src/state/use-thread-composer-state.ts`, follow-up dispatch
     block ~line 645-660). The server's `"auto"` path is capability-aware:
     active steer → queue → restart. On dsh, mobile queues instead of restarting.

### Per-provider settings: currently none

`followUpBehavior` is one client-wide value, not per provider/driver:

- `packages/contracts/src/settings.ts:472` (unified settings)
- `packages/contracts/src/settings.ts:1773` (client settings patch)

Provider instance settings (`.t3/userdata/settings.json` → `providerInstances`) only
configure runtime (command path, args, auth/models); nothing reads a per-provider
follow-up behavior. There is no per-thread or per-project override either.

Closest existing knobs:

- per-message opposite action (`Ctrl+Enter` queues when the default is Steer);
- queued-message "promote to steer" (explicit, and still restart-steers on dsh);
- switching the whole client to **Queue**.

### Proposal

Do not add a per-ACP setting first; make the behavior capability-aware, like mobile.

1. **Web:** send the setting-driven Steer as `deliveryIntent: "auto"` instead of
   `"steer"`. Keep `"restart"` for a deliberate "restart the turn" action and
   label it as such. (Optionally do the same for the alternate modifier.)
2. **Server hardening:** when `deliveryIntent: "auto"` and the provider has
   `supportsActiveSteering: false` + `supportsQueuedMessages: true`, always take
   `queue_after_active`, never `restart_active`.
3. **UX:** a provider that can only restart to steer must not present a plain
   "Steer"; use "Restart turn with message" (and/or a confirm). The attempt fold
   already says "Cut off by a steer".
4. **Config:** only if a knob is still wanted, add `followUpBehavior:
   "auto" | "queue" | "steer"` (global). Avoid a `Record<driver, behavior>` map;
   capability-aware defaults cover ACP without configuration.
5. **True active steering for dsh** would require DeepSeek Harness to accept
   mid-turn messages plus an ACP extension; not fixable in T3 alone.

### Files to touch

- `packages/client-runtime/src/operations/commands.ts` (deliveryIntent mapping)
- `apps/web/src/components/chat/ChatComposer.tsx` + `ComposerPrimaryActions.tsx`
- `packages/client-runtime/src/state/composerDispatch.ts` (maybe add `"auto"`)
- `apps/server/src/orchestration-v2/CommandPolicy.ts` (guard + tests)
- `packages/provider-acp/src/server/adapter.ts` (only if an ACP steer extension appears)

### Tests

- Command policy: ACP caps (active=false, queue=true) + `auto` → `queue_after_active`;
  pi caps (active=true) + `auto` → `steer_active`; no `steering_restart`.
- Web composer: Steer on ACP sends `deliveryIntent: "auto"`; on pi still joins.
- Regression: an `auto` send never creates a `steering_restart` attempt.

### Open questions

- Should restart-steer remain available on web as an explicit action, or is
  Stop + send enough?
- Should the client setting be renamed "Steer" → "Steer when possible, else queue"?

---

## 2. Invisible messages on some new threads

### Symptom (as reported)

Messages in newly created threads sometimes do not show up in the timeline. The
underlying thread/projection still receives them; the UI looks empty or stale until
something forces a reload.

### Reports

- [T3C new thread messages not displaying](t3-thread://v2/86e4e4f1-981d-4600-a3f4-ffcfdbb68262/4ac6e413-a847-4a7a-8811-4b7072900d61)
  — original report, 2026-11-03: _"find out why in t3c the messages in new threads
  are not displayed and fix it"_. Run 2 sent one test message and concluded
  "resolved"; no root cause or code change was recorded.
- [Finish Piper, CLIProxy, Model Gaps](t3-thread://v2/86e4e4f1-981d-4600-a3f4-ffcfdbb68262/5e42100c-4d15-4483-9dfe-b744d975614b)
  — 2026-11-03T08:06:22, follow-up _"this one aswell"_ with the thread above quoted.

### Status

Unresolved. The earlier "fix" was not verified and the bug has no reproducer or
test yet.

### Next steps

1. Reproduce on web + desktop: create a new thread, send a message, switch away and
   back, reload.
2. Compare `t3_thread_read` / `orchestration_v2_projection_messages` with what the UI
   renders at that moment. Decide whether the gap is server-side projection,
   subscription/bootstrap, or timeline row derivation.
3. If the projection has the message, inspect the client thread-workflow hydration
   and `MessagesTimeline` row grouping; add a regression test at the failing layer.
4. Record the exact T3 version and surface (web/desktop/mobile) in the next report.
