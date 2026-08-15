# AgentHarness runtime trace guide

Runtime implementation is split by durable protocol:

- `agent-harness-runtime.ts`: construction, lane registry, global settings, close, and fault lifecycle.
- `lane-runtime.ts`: `AgentLane` facade, run admission, drive-facing methods, lane configuration, and deferred public tree writes.
- `operation-task.ts`: drive claim/join/fencing, `ActiveOperation` installation, effect-gate ownership, and outer task cleanup.
- `run-driver.ts`: resume prelude, activation-recovery dispatch, and the direct `RunPhase` switch.
- `assistant-procedure.ts`: assistant recovery, retry waits, request intent/effect/settlement, and assistant lifecycle publication.
- `tool-batch-procedure.ts`: ordinary and recovered tool batches, parallel promise ownership, source-ordered settlement, and batch completion.
- `checkpoint-procedure.ts`: checkpoint/failure-drain dispatch and terminal cleanup. Add R5 checkpoint inbox drains in `driveCheckpoint()` before generation or finish.
- `run-mutation.ts`: shared restore/commit failure normalization only; phase and identity checks stay in procedure modules.
- `transitions.ts`: pure classification, arithmetic, validation, state construction, and terminal hydration.
- `types.ts`: runtime-only contexts and procedure result types.

Primary traces:

1. Start at `executeDrivePass()` in `run-driver.ts`.
2. Follow the `switch (state.phase.kind)` to `executeAssistantGeneration()`, `executeOrdinaryToolBatch()`, or `driveCheckpoint()`.
3. For restart behavior, follow `recoverRunAtActivation()` in the same driver to `recoverAssistantAtActivation()` or `recoverToolBatchAtActivation()`.

Assistant intent and settlement are both in `assistant-procedure.ts`. Tool intent, effect admission, and ordered settlement are all in `tool-batch-procedure.ts`; their event order remains adjacent to the commits that establish durability. In both procedures, `entry_added` is published only after the settlement commit and is the event that proves the entry is durable.
