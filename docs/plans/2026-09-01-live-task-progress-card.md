# Live Task Progress Card Implementation Plan

**Goal:** Keep one DingTalk AI card visibly updated during long OpenClaw tasks with a concise, sanitized progress summary.

**Architecture:** Extend the card draft timeline with one replaceable progress block. A card-scoped progress controller subscribes to correlated OpenClaw lifecycle/tool events, converts tool names to safe user-facing stages, updates elapsed/completed-step metadata, emits a 30-second heartbeat, and removes the progress block before the final answer is committed.

**Tech Stack:** TypeScript, OpenClaw runtime agent events, DingTalk AI Card APIs, Vitest.

---

### Task 1: Add a replaceable progress block to the card timeline

**Files:**

- Modify: `src/card-draft-controller.ts`
- Test: `tests/unit/card-draft-controller.test.ts`

1. Write a failing test proving repeated progress updates replace one block and clearing removes it.
2. Run the focused test and confirm it fails because the API is missing.
3. Add `updateProgress` and `clearProgress` with a dedicated timeline entry.
4. Run the focused test and the full controller test file.

### Task 2: Convert runtime events into safe concise progress

**Files:**

- Create: `src/card/card-task-progress.ts`
- Create: `tests/unit/card-task-progress.test.ts`

1. Write failing tests for safe stage labels, correlated tool events, completed-step counts, elapsed time, and a 30-second heartbeat.
2. Confirm failures before implementation.
3. Implement a controller that never renders raw command arguments or tool output.
4. Run the focused tests.

### Task 3: Wire progress into the card reply lifecycle

**Files:**

- Modify: `src/reply-strategy-types.ts`
- Modify: `src/inbound-handler.ts`
- Modify: `src/reply-strategy-card.ts`
- Test: `tests/unit/inbound-handler-card-streaming.test.ts`

1. Write a failing integration test that emits runtime tool events and observes updates to the same card.
2. Pass the runtime event surface into the card strategy.
3. Start progress tracking with the card and dispose/clear it on finalization or abort.
4. Run card streaming and inbound handler regression tests.

### Task 4: Review follow-ups

**Files:**

- Create: `src/platform/runtime-events.ts`
- Modify: `src/reply-strategy-types.ts`, `src/reply-strategy-card.ts`, `src/reply-strategy-markdown.ts`, `src/reply-strategy-with-reaction.ts`
- Modify: `src/inbound-handler.ts`, `src/config-schema.ts`, `src/types.ts`
- Modify: `docs/user/features/ai-card.md`, `docs/user/reference/api-usage-and-cost.md`

1. **Release the progress controller on every exit path.** `ReplyStrategy` gained an idempotent
   `dispose()`; `inbound-handler` assigns the strategy to an outer-scope variable and calls
   `dispose()` from the dispatch `finally`, so the ask-user question-card takeover return (which
   calls neither `finalize()` nor `abort()`) can no longer leak timers or the event subscription.
2. **Never keep the process alive.** The start delay and heartbeat timers are `unref()`'d.
3. **Disable instead of mis-correlating.** An empty/blank `sessionKey` yields a no-op controller
   instead of a correlator that can only match through the optimistic window.
4. **Move shared runtime-event plumbing out of `ack-reaction/`.** Event typing, reference-counted
   fan-out, field accessors, and the run correlator now live in `src/platform/runtime-events.ts`;
   both the ack-reaction and card domains import from there. Fan-out also isolates a throwing
   listener, and correlator debug logs carry a `consumer` label.
5. **Add a user-facing switch.** `cardTaskProgress` (`true` / `false` / unset) with documented cost,
   plus the `docs/user/` updates.
6. **Drop the server-clock line.** The progress block shows elapsed time only; a `toLocaleTimeString`
   timestamp rendered the gateway host timezone, not the reader's.
7. **Regression tests.** Takeover no longer produces progress frames, disposing twice is safe,
   disabled/blank-session controllers never schedule, a progress block coexisting with an active
   answer block keeps timeline indices correct, and a throwing fan-out listener does not starve
   the other consumers.
