# Structured state implementation and evaluation

## Behavior

Structured state is optional and disabled by default. Each existing bank stores a version-1 `structuredState`, separate from its recursive narrative layers. Normal and backlog summary batches request a single `{summary, stateChanges}` JSON response using the existing connection and original passage. When older summarized passages lack fact coverage, enabling tracking or activating the chat/card automatically backfills from original messages using additional `{stateChanges}` requests. Backfill preserves narrative layers, ghosting, and manual locks. It uses a dedicated fact prompt independently of the custom narrative focus. Indexed speaker labels give the extractor source-message references. There is no additional model, every-reply extraction, backend JSON-schema requirement, or parallel-agent dependency.

Facts have semantic IDs, categories, compact values, and source ranges. Updates replace by ID; explicit removals resolve goals or discard obsolete facts. Omission retains facts. The categories are location, time, present, relationship, item, injury, goal, and fact. Model output may contain at most 64 changes, 256 stored facts, and 400 characters per fact. Unsupported fields, duplicate IDs, invalid operations/ranges, malformed/partial JSON, and unsupported stored versions reject the response/import before changes are applied.

Summary batches commit narrative, updated snapshot, source fingerprints and cutoff together without an intervening await; only then can hiding begin. Fact-only backfill commits just validated state, checkpoints, and source fingerprints after every batch, with no hiding or promotion. Stop pauses both paths. Extract Missing Facts resumes saved backfill or retries a failed response. Pause/disable, a busy run, and chat/card identity guard automatic scheduling; invalid responses do not cause an automatic retry loop. A new reply received while backfill is busy defers its summary check until that run finishes. Chat identity, card identity, chat epoch, store revision, source fingerprints, and the run's cancellation signal guard pending results. Failed promotions retain their original snippets throughout the request. Promotions retain aggregate source ranges and never write structured state. Source fingerprint computation is cached by message text, speaker, role and swipe; hiding flags do not change fingerprints.

Up to twelve fact checkpoints support rollback. Edits, updated messages, swipes, swipe deletion, message deletion and branch loading reconcile all banks, including inactive cards. When a promoted narrative range cannot align with a retained state checkpoint, the affected bank is reset for replay from the still-present original messages. Unknown legacy ranges are discarded conservatively when repair is triggered. A legacy import without original fingerprints cannot prove that unchanged-length source text still matches; use Rebuild when moving memory to different source history.

Manual pins override model updates by ID; removals create locked tombstones and free the underlying fact slot. Unlock removes the lock and lets future extraction repopulate/update that ID. Corrections are anchored to the latest message and invalidated when their supporting source history changes. The active settings panel provides inspection/correction; the database viewer and exports include the snapshot, checkpoints and source signatures. Text-only imports and older database-layer exports remain accepted. Deleting a narrative snippet also drops dependent later summaries and restores their original messages, preventing hidden coverage gaps. Narrative regeneration does not re-extract state: correct the state separately or rebuild.

## Budget and placement

The state allowance is 600 tokens by default, adjustable from 400–800, inside the total injection budget. Complete facts and narrative snippets are selected; omitted items remain stored and overflow is shown in the injection inspector/state panel. Pinned facts, goals, injuries, and ownership receive priority. Canonical deepest history and newest unpromoted events receive narrative priority, with accepted snippets emitted chronologically. The wrapper and labels count toward the total; an oversized wrapper or no fitting whole item produces empty injection.

Synchronous previews use an exposed synchronous tokenizer where available, otherwise a clearly labeled estimate of four characters per token. At `GENERATION_STARTED`, an available SillyTavern async tokenizer measures the proposed injection and state block, shrinking whole-item selection until it fits. A bounded measurement loop and per-measurement cache avoid per-fact tokenization calls. If tokenization is unavailable or fails, the inspector labels the estimate; estimates are not a hard model-token guarantee. Other extensions/presets can change the final context allocation. Deterministic serialization does not guarantee KV-cache reuse.

The snapshot labels its processed-through cutoff and coverage start; later visible messages take precedence. Backfill stops at the existing narrative cutoff, preserving recent verbatim messages. Enabling after intervening text-only processing resumes missing coverage without discarding earlier facts. Old partial snapshots are replayed from message zero; stored state is replaced only after a valid response, preserving manual locks. A summary batch also completes missing coverage before extracting its own newer changes. Rebuild clears and replays the active bank, including its pins, after an in-app confirmation. Disabled mode continues the original text-only summary prompt behavior; legacy recall metadata is retained.

## Bug sweep

- Added missing saved-custom-prompt, Reset to Defaults, and top-level legacy-cleanup handlers. Tested that every settings button is bound.
- Included player lead-ins and intervening messages in normal/backlog passages, and replaced all prompt-variable occurrences.
- Preserved the verbatim window in automatic/backlog processing. Skip Backlog now excludes skipped indices from eligibility instead of repeatedly attempting them.
- Preserved layer array identity on reads; promotion no longer writes to detached arrays or removes history while awaiting a response.
- Cancelled the entire catch-up run, retry/backoff and current request; prevented stale chat/card/source/revision commits.
- Fixed profile calls to the supported `sendRequest(profileId, messages, maxTokens, options, overridePayload)` signature. Disabled creative preset/instruct formatting for extraction.
- Propagated direct HTTP/profile abort signals, cleared timers/listeners, processed trailing SSE frames, rejected incomplete/truncated streams and JSON completion replies, and preserved rate-limit retry metadata.
- Used SillyTavern's native stop event for Default raw generation because its current public `generateRaw` API has no abort-signal parameter. This event can stop concurrent raw generations from other extensions; direct/profile requests have request-specific cancellation.
- Honored Ollama temperature/output/stop controls; accepted temperature zero in the UI; briefly cached KoboldCPP context-size lookups (60 seconds) and lowered its fallback response limit from 2000 to 512 tokens.
- Repaired all layers/banks, restored visibility on card switches even after intervening UI reads, and copied shared-bank state instead of aliasing a card bank.
- Preserved manually hidden messages in Repair; cleared dormant state on Clear Memory; validated imports before mutation and made bank exports round-trip compatible.
- Removed reasoning blocks before stripping their delimiters and restored captured prompt-order objects without rewriting a newly selected preset.
- Initialized late-enabled extensions immediately and supported modern/legacy event-type aliases.

## Validation actually run

Use Node.js 24 and `npm ci --ignore-scripts`, then `npm test`. Test dependencies (`jsdom`, `jquery`) are development-only; the browser extension has no added runtime dependencies.

The suite exercises pure state/budget code, mocked HTTP/SSE backends, and the extension's real handlers in a jsdom SillyTavern simulation. Coverage includes ownership transfer, injury persistence, location changes, relationship state, goal resolution, no-change updates, manual locks/removals/unlock, malformed/partial extraction, duplicates, bounded checkpoints, overflow, native/fallback token budgets, stale chat/card/source writes, cancellation, multiple promotions, every-layer/inactive-bank repair, legacy import, shared/card isolation, initialization, saved prompts/reset/cleanup, visibility repair, and the fixed replay fixture.

JavaScript syntax checks and `git diff --check` are also run. Supported connection signatures and cancellation mechanisms were inspected against SillyTavern's public release source. No actual SillyTavern browser session, GPU backend, or live model was run here. Mock responses test state mechanics and UI handlers; they do not measure semantic extraction accuracy or end-to-end speed.

## Reproducible model comparison (pending)

1. Import `docs/replay-narrative.jsonl` as a SillyTavern chat with an Alex persona and a Mara card, then make two identical chat copies. The JSONL contains fixed dialogue only. `docs/replay-narrative.json` supplies recommended settings, gold fact changes, expected cutoff state, and a probe; do not include these gold answers in the model prompt.
2. Use the same summarizer/chat model, quantization, GPU residency, model context size, prompt preset, sampler settings, and response-token limit in both copies. The fixture settings use four verbatim assistant turns, two turns per batch, three snippets per layer, two per promotion, five layers, and **2048 total memory tokens**. Use that same total budget on both arms; the state-on arm reserves 600 of those tokens for state. A complete JSON response can require a larger limit (e.g. 1024 or more for reasoning models); use the same limit for both arms.
3. Clear each bank, leave state off in one and enable it in the other. Force catch-up until only four assistant turns remain unsummarized. Memory/state should end at **message index 27** (zero-based), with indices 28–35 visible. Promotions must occur. Keep original dialogue and hidden/visible coverage identical in the two arms.
4. Pause summarization, inspect the registered injection, and append the fixture's probe as a user message. Score the eight expected facts plus the two completed goals against `expectedAtCutoff` / `resolvedIds`, accepting equivalent wording. Incorrect or unknown answers score zero; count fabricated facts separately. Later visible dialogue intentionally does not repeat ownership, injury, or task facts.
5. Record actual injected tokens from the active tokenizer and the full prompt tokens reported by the backend, summary-call count (including promotions), total catch-up wall time, per-call median/p95 latency, response tokens, and continuity score. `lastBatch.milliseconds` measures the latest extraction call through response receipt/validation boundary, excluding hiding/promotion; it is not total catch-up or main-generation latency. Use server timing/logs for per-call distributions.
6. Repeat at least three times per arm with the same model and comparable cache/warmup conditions. Also replay one edit, a deleted source message, an alternate swipe, an item-transfer correction and a branch before an earlier checkpoint. Inspect snapshots and injection for obsolete/future facts.

| Evidence | Result |
| --- | --- |
| Automated regression mechanics | Pass/fail is reported by `npm test` |
| Live-model continuity accuracy | Pending |
| Actual backend injection/prompt tokens | Pending |
| Local GPU catch-up and generation latency | Pending |
| KV-cache benefit | Unmeasured; no guarantee |

Structured JSON increases output and prompt work within routine summary calls, and missing historical fact coverage adds one-time catch-up calls. Include those calls in measurements when evaluating an upgrade of an existing bank; a fresh replay needs no separate backfill. Faster cancellation, fewer redundant requests, cached fingerprints/lookups and bounded context remove avoidable work; whether total latency improves needs the experiment above. Schema validation establishes response shape and transaction safety, not truth or guaranteed retention. Banks exceeding the fact capacity require manual pruning or a smaller scope before further extraction can commit.
