# Structured state maintenance: implementation brief

## Goal
Improve continuity of durable facts and unresolved goals across recursive summarization, with modest overhead on a single-GPU local backend. Implement a small, optional feature in Summaryception, then validate it. Keep this PR draft for maintainer review; do not merge.

## Starting findings (verify against current code)
index.js has normalizeRecall, mergeRecallFields, and priority rendering in assembleSummaryBlock, but ordinary and backlog summarization save text-only snippets. Existing recall metadata is merged during promotion rather than newly extracted. The current token budget uses a four-characters-per-token estimate.

## Required behavior
- Maintain a versioned structured state record per existing memory bank, separate from recursive narrative layers. Preserve existing imports, exports, migration, card identity, shared-bank mode, ghosting, connection profiles, and custom prompt compatibility.
- Use the previous validated state plus original passage to generate a narrative summary and validated state changes in the same normal/backlog summarizer call when enabled. Avoid another model, a call every turn, or reliance on backend-specific structured-output APIs.
- Track compact facts such as location/time, present characters, relationships, important item ownership, injuries, immediate goals/unresolved threads, and pinned durable facts. Do not invent numerical relationship scores or infer unsupported changes.
- Use stable fact identifiers and explicit set/remove or equivalent semantics; omission must not silently delete a fact. Do not rely on exact prose matching to resolve changed facts. Store source message references/ranges and a processed-through cutoff.
- Clearly render state as a snapshot at its cutoff: later visible messages take precedence. Do not advertise a historical snapshot as authoritative current truth.
- Validate responses before committing changes. On malformed, partial, failed, canceled, or stale responses, preserve the last valid state and its cutoff. Do not ghost source messages on unsuccessful batch processing. Avoid partial state/summary commits and cross-chat/card asynchronous writes.
- Promotion must never overwrite newer state with older summarized events.
- Handle message edits, deletion, swipe/regeneration, and branching without future or obsolete facts leaking into injection. Restore a valid checkpoint or invalidate/rebuild from available original messages. Cover changes in inactive banks and retain bounded checkpoint metadata.
- Provide enable/disable, compact state inspection/manual correction, and persistence/export/import. Manual corrections should have defined precedence and must not be silently overwritten; integrate with the existing viewer where practical.
- Reserve a configurable state allowance within the total memory injection budget (initial target around 600 tokens, adjustable within roughly 400–800). Account for labels/wrappers. Use an available appropriate tokenizer where supported; explicitly label any fallback estimate. Never cut structured data or facts mid-field. Preserve omitted facts in storage and surface overflow rather than silently destroying them.
- Use deterministic serialization and sensible placement, but do not promise guaranteed context retention against other extensions or automatic KV cache speedups.
- Keep feature disabled by default for existing users so current custom prompts and text-only behavior continue to work. Avoid unnecessary dependencies and unrelated refactors.

## Validation and evidence
Add meaningful runnable regression tests, using the repository's existing conventions if any, for:
- Item transfer, injury persistence, location change, goal resolution, explicit correction/removal, and no-change updates.
- Malformed/partial extraction preserving prior state; duplicate processing; chat/card switching during a pending request.
- Multiple promotions never reverting newer state.
- Edits, swipes, deletion, branches, and checkpoint invalidation.
- Legacy text-only import, per-bank isolation, state export/import, disabled mode, overflow, and budget behavior.
Inspect the integration paths and exercise UI/runtime behavior where available. Do not claim a real SillyTavern or local-model test if only mocks were run.
Provide a small reproducible replay fixture and instructions to compare feature on/off with the same model and comparable total context budgets. Measure continuity accuracy, injected tokens, and summarization latency when a backend is actually available; otherwise document the pending experiment without inventing gains.

## Scope limits
No VectHare integration or keyword suppression, RAG redesign, extra agents/extensions, additional model residency, or broad harness framework. Update README claims relevant to the feature: narrative compression is lossy and continuity gains require measurement.
Before marking ready, report changed behavior, tests actually run, limitations, and local-model evaluation still needed. Replace this planning brief with final implementation/evaluation documentation if appropriate.
