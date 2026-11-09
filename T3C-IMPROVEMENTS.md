# T3C improvements

Personal backlog for T3 Code. Workspace is this checkout (`~/t3code-src`).
Keep items concrete: symptom, evidence, root cause, proposal, tests.

## Backlog

- [ ] **1. Steer silently restarts the turn on restart-only providers (ACP)** — see §1
- [ ] **2. Invisible messages on some new threads** — see §2
- [ ] **3. Sync threads across all devices** (feature) — see §3
- [ ] **4. Route provider requests through another computer** (feature) — see §4

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

---

## 3. Sync threads across all devices

Feature gap, not a bug: same-environment multi-device access already works, cross-environment
continuity does not.

### Symptom

Two environments show different thread lists. The desktop app's bundled server at home and a
`t3` server on a VPS each own a separate `statev2.sqlite`, so a thread started on one is invisible
and unreachable on the other. The phone only lists threads of environments it has added. Moving
between machines means re-creating or abandoning the conversation.

### Current state

- Inside one environment, sync already works: every client reads the same projections from the
  environment's database, and remote access (direct, Tailscale, T3 Connect) only changes the route.
  The current answer to "threads on all devices" is "add the one server everywhere".
- Across environments there is nothing. [remote.md](docs/internals/remote.md) is explicit: a project
  and its threads belong to one environment; a peer link lets an agent _read_ another environment's
  threads, it does not copy them.
- `thread.fork` / `thread.merge_back`
  ([orchestrationV2.ts:3351](packages/contracts/src/orchestrationV2.ts),
  [:3362](packages/contracts/src/orchestrationV2.ts)) and the `t3_thread_transfer` tool move context
  between threads of the _same_ environment only.
- No export/import either: [thread-migration.md](docs/user/thread-migration.md) says there is no
  whole-thread export command.

### Proposal

Mirror, do not replicate the event log.

1. **Owner and follower.** Each thread has one authoritative environment. A follower stores a
   read-only copy: thread metadata, user/assistant messages, terminal run summaries. Never provider
   sessions, checkpoints, terminals, queued runs, or live activity.
2. **Transport.** The follower subscribes to the owner over its existing authenticated connection
   (pairing or T3 Connect; peer link credentials can carry it). Batches commit with
   `(environmentId, threadId, messageId)` dedupe and a per-thread cursor; on reconnect the follower
   catches up from that cursor. No second protocol, no inbound port on home.
3. **One writer.** Sending from a mirrored thread still goes to the owner, so it stays the single
   writer. "Continue here" is the reverse door: fork ownership at the latest point, end the mirror,
   and the old owner keeps its copy as history.
4. **Metadata.** Title, pin, snooze, archive and settlement are last-writer-wins by `updatedAt`,
   owner wins ties; archive/unarchive mirror as tombstones so sync cannot resurrect a deleted thread.
5. **Attachments.** Fetch lazily from the owner through the same connection; do not copy blobs into
   the follower's `userdata`.
6. **UI.** Sidebar groups mirrored threads under their owner with a small environment badge.
   Settings toggle per environment (and later per project); turning it off removes local copies and
   the cursor, never the owner's thread.

### Files to touch

- `packages/contracts` — mirror commands/events plus a sync cursor shape (new namespace, not
  `thread.*`, so replay stays explicit about what it may contain).
- `apps/server/src/peer/PeerLinks.ts` — peer session reuse or a dedicated sync endpoint.
- New server service that owns the subscriber, dedupe and cursor; transports stay thin.
- `packages/client-runtime/src/state` — merge local and mirrored threads into sidebar read models.
- `apps/web` sidebar + thread view read-only state; `apps/mobile` thread list.

### Tests

- Re-delivering a batch is idempotent (same message ids, no duplicated timeline rows).
- Follower offline for a while catches up to the same message order; a gap refuses to render rather
  than skipping silently.
- `thread.merge_back` on a mirrored thread fails; "continue here" forks ownership and stops the mirror.
- Mirror never writes checkpoints, runs or provider state into the follower database.
- Metadata LWW: owner update newer than follower edit wins; tie keeps owner.
- Turning sync off removes the copy; the owner's thread survives a follower restart.

### Open questions

- Account-level (every machine auto-mirrors) vs. an explicit per-environment pair.
- What happens when the owner is offline: queue the send, or show the mirrored thread as read-only?
- Privacy and retention of copied transcripts on a shared VPS, and size limits on long histories.

---

## 4. Route provider requests through another computer

Feature gap, not a bug: work should run on the VPS, but provider traffic should leave from home.

### Symptom

Providers see the environment server's public IP. Running T3 on a CI runner or VPS means Claude,
Codex, and the rest see a datacenter address: geo restrictions, different rate-limit buckets, account
anomaly checks, and "new location" verification. Expected: run the agent on the VPS, make the
provider requests look like they come from home.

### Current state

- Provider CLIs are subprocesses of the environment server (`apps/server/src/provider/Drivers/*`,
  `ClaudeProvider.ts`, `CodexProvider.ts`) and inherit the host network. Provider instance settings
  (`.t3/userdata/settings.json` → `providerInstances`) configure executable, args and auth only.
- T3's own `fetch` already honors an ambient HTTP proxy
  ([outboundHttp.ts](apps/server/src/outboundHttp.ts), `NODE_USE_ENV_PROXY` / `--use-env-proxy`), but
  nothing sets it per provider, and provider children only benefit if their own HTTP stack honors
  `HTTPS_PROXY`.
- Workaround today: a host-level Tailscale exit node or VPN on the VPS. Works, but all traffic is
  routed, it is not per provider, and it needs host access.
- Nothing verifies what address a provider actually uses, so a silently missing proxy looks like a
  working setup until the account gets flagged.

### Proposal

1. **Peer-hosted CONNECT proxy.** The home environment starts a local HTTP `CONNECT` proxy and
   exposes it over the existing outbound peer link (no inbound port, no new tunnel binary). The VPS
   sets `HTTPS_PROXY` / `HTTP_PROXY` plus `NO_PROXY=127.0.0.1,localhost,::1` on that provider's child
   env only.
2. **No MITM.** `CONNECT` keeps TLS end-to-end, so no certificate install and the proxy sees
   hostnames only. Stream the tunnel; never buffer or persist payloads.
3. **Per instance setting** `egress: "direct" | "peer:<environmentId>"` on the provider instance.
   A **Check egress** action fetches an IP echo endpoint through the tunnel and shows the observed
   address; a turn whose provider launched without the configured egress warns instead of going
   direct silently.
4. **CLIs that ignore proxy env** (bundled network stacks, certificate pinning) fall back to the
   documented host exit node; the same check proves it, and the setting must not pretend to work.
5. **Scope.** Provider API, auth-token refresh and usage traffic only. Local MCP, OAuth loopback
   callbacks, preview servers, git and source-control calls stay direct through `NO_PROXY`.

### Files to touch

- `apps/server/src/peer/PeerLinks.ts` — proxy endpoint over the existing peer session.
- Provider child env construction in the drivers and `ClaudeProvider.ts` / `CodexProvider.ts` /
  `CodexInstallation.ts`; proxy URL comes from the instance, not `process.env`.
- `packages/contracts/src/settings.ts` — `providerInstances` gains `egress`.
- `apps/web` provider instance settings: egress picker, **Check egress**, warning state.

### Tests

- Child env gets the proxy (and `NO_PROXY`) only for the provider instance that selected it.
- Loopback stays direct: a local MCP/OAuth callback never traverses the tunnel.
- The proxy refuses plaintext and non-`CONNECT` requests.
- Egress check failure surfaces without blocking the turn; the next turn still starts.
- Tunnel reconnect during a streamed response: the provider call fails or retries, it never hangs.

### Open questions

- Open proxy vs. an allowlist of provider hosts. Allowlists drift with every provider version; an
  open proxy on a peer is a relay if credentials leak.
- Browser-based logins (Codex/Claude OAuth) that happen on the user's device, not the server: route
  or leave direct?
- Extra tunnel RTT on every request and streamed token; measure before promising it is invisible.
