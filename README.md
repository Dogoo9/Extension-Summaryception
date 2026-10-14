# 🧠 Summaryception

This fork tracks [Lodactio's upstream Summaryception](https://github.com/Lodactio/Extension-Summaryception) while adding flexible connection and memory-management features. It preserves upstream's normal setup and usage while adding KoboldCPP, generic completion, and custom HTTP sources; reusable connection profiles; configurable injection placement; a memory database viewer; and per-character memory banks.

### Layered Recursive Memory for SillyTavern

> Layered narrative memory with a configurable context budget. Compression is lossy; continuity depends on the model, prompts, and budget.

Summaryception is a non-destructive, context-aware memory system for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that replaces brute-force context stuffing with intelligent layered summarization. It keeps your most recent turns verbatim while compressing older conversation into ultra-compact summary snippets — organized in recursive layers with configurable depth and injection limits.

---

## ✨ The Problem

Every roleplayer hits the same wall:

| Approach | What happens |
|---|---|
| **No summary** | Context fills up → hard truncation → everything before the cutoff is **gone forever** |
| **Basic summarization** | Lossy single summary → important details vanish → you compensate by keeping 20+ verbatim turns → context still bloats |
| **More verbatim turns** | 20 turns × 1,500 tokens = 30k tokens of mostly atmospheric prose the LLM has to process → attention degrades → coherence drops anyway |

The conventional wisdom — *"keep more raw turns"* — is a band-aid for bad compression.

## 💡 The Solution

Summaryception compresses older prose into concise narrative deltas. Repeated compression can lose detail; original chat messages remain available for review and rebuilding.

A context-aware summarizer prompt examines each batch of turns against what's *already been summarized*, outputting only the **narrative delta** — new plot points, state changes, character decisions. The aim is less repetition while retaining useful changes; this is not a guarantee of complete recall.

**Real example** — 3 turns, ~5,200 raw tokens, compressed to:

> *Alina kisses Lodactio; he reciprocates; she grows to human size, straddling him; she squeezes his crotch and intends to undo his pants.*

This illustrates the compact format. Token counts and retained details vary by tokenizer and summarizer; compression ratios do not establish recall accuracy.

Because each snippet receives a budgeted selection of previous snippets, it can avoid some repetition over time — the summarizer doesn't re-establish characters, settings, or relationships that are already recorded. Early snippets might be 40 tokens. By snippet 10, you're seeing 15-token summaries.

---

## 🔄 How It Works

```
YOUR CHAT (e.g., 200 turns)
│
│  Turns 1-180: Ghosted (hidden from LLM, still readable by you)
│  Turns 181-200: Kept VERBATIM (10 most recent assistant turns)
│
│  The ghosted turns have been compressed into:
│
│  ┌──────────────────────────────────────────┐
│  │  LAYER 2 (Deep Memory)                   │
│  │  Ultra-compressed summaries of Layer 1   │
│  │  Each covers ~27 turns                   │
│  ├──────────────────────────────────────────┤
│  │  LAYER 1 (Meta-Summaries)                │
│  │  Compressed summaries of Layer 0         │
│  │  Each covers ~9 turns                    │
│  ├──────────────────────────────────────────┤
│  │  LAYER 0 (Turn Summaries)                │
│  │  Direct summaries of conversation turns  │
│  │  Each covers ~3 turns                    │
│  ├──────────────────────────────────────────┤
│  │  VERBATIM TURNS (most recent 10)         │
│  │  Sent word-for-word to the LLM           │
│  └──────────────────────────────────────────┘
│
│  Total context: ~12k tokens
│  Narrative coverage: compressed, with possible losses
```

### The "Ception" — Recursive Layer Promotion

When a layer fills up (default: 30 snippets), the oldest snippets are promoted to the next deeper layer:

1. **Seed promotion** — The very first time a deeper layer opens, the oldest snippet is promoted **directly** as a seed, no LLM call, preserving maximum information as the foundation for that layer.
2. **Subsequent promotions** — Additional overflow snippets (default: 3 at a time) are summarized together against the destination layer's existing content (including the seed) as prior context.
3. **Cascade** — If the destination layer also fills up, the process repeats, creating Layer 2, Layer 3, etc.

Each layer increases the turn range represented by a snippet, at the cost of another lossy summarization pass. Promotions retain source ranges so edited or branched histories can be repaired.

---

## 📊 The Math

*Using ~70 tokens per snippet as a working median. Actual snippets range from ~30 tokens (late-layer, minimal delta) to ~100 tokens (early context establishment). Your results will vary based on narrative density.*

### Default Settings (30 snippets/layer, 3 turns/batch, 3 snippets/promotion)

Each promotion merges 3 snippets into 1, so each layer multiplies turn coverage by 3×.

| Layer | Snippets | Turns per Snippet | Total Turns Covered | ~Tokens |
|---|---|---|---|---|
| Verbatim | 10 turns | — | 10 | ~7,000 |
| Layer 0 | 30 | 3 | 90 | ~2,100 |
| Layer 1 | 30 | 9 | 270 | ~2,100 |
| Layer 2 | 30 | 27 | 810 | ~2,100 |
| Layer 3 | 30 | 81 | 2,430 | ~2,100 |
| Layer 4 | 30 | 243 | 7,290 | ~2,100 |
| **Total** | — | — | **~10,900 represented turns** | **~17,500 tokens** |

> Theoretical represented ranges, not measured detail retention. The configured injection budget may omit stored snippets.

### Conservative Estimate (smaller snippets at deeper layers)

In practice, deeper layers produce shorter snippets as they compress already-compressed material. A more realistic breakdown:

| Layer | Snippets | Turns per Snippet | ~Tokens/Snippet | ~Layer Tokens |
|---|---|---|---|---|
| Verbatim | 10 turns | — | — | ~7,000 |
| Layer 0 | 30 | 3 | ~80 | ~2,400 |
| Layer 1 | 30 | 9 | ~70 | ~2,100 |
| Layer 2 | 30 | 27 | ~60 | ~1,800 |
| Layer 3 | 30 | 81 | ~50 | ~1,500 |
| Layer 4 | 30 | 243 | ~40 | ~1,200 |
| **Total** | — | — | — | **~16,000 tokens** |

> These figures are illustrative capacity estimates rather than measured continuity results. The raw conversation? Roughly **15–25 million tokens.** That's a compression ratio approaching **1,000:1**.

Actual context use depends on passage length, selected memories, tokenizer, wrappers, and the active SillyTavern preset.

---

## 👻 Non-Destructive Ghost Mode

Summaryception never deletes your messages. Summarized turns are **ghosted** — hidden from the LLM context but fully visible and readable in your chat UI. Scroll up anytime to read the original prose.

- 👻 Ghosted messages show a system icon in the chat
- Clear Memory unghosts everything instantly
- Your chat file is never modified destructively

---

## 🧹 Summarizer Prompt Isolation

Direct HTTP sources send only the summary prompts. Default uses SillyTavern's raw generation path; if a prompt manager is exposed, its toggles are restored after the request. Connection Profile requests use the supported numeric token-limit argument and disable creative preset/instruct formatting while retaining the profile's endpoint, model, and credentials.

Stop and timeouts abort direct HTTP and profile requests. Default mode uses SillyTavern's native generation-stop event, which can also cancel concurrent raw generation from other extensions. Avoid overlapping background raw generations on that source.

---

## 🔁 Context-Aware Incremental Summaries

This is the core innovation. The summarizer prompt receives:

| Variable | Contents |
|---|---|
| `{{player_name}}` | Your active persona name |
| `{{context_str}}` | **Budgeted existing summaries** — everything already recorded |
| `{{story_txt}}` | The new passage to summarize |

The instruction: *"Summarize only necessary elements to coherently continue the Prior Context. Exclude anything already covered."*

Possible behavior (model-dependent):
- **Snippet 1** has to establish characters, setting, relationships (~80–100 tokens)
- **Snippet 5** only records new events — characters and setting are established (~50–70 tokens)
- **Snippet 10** is pure narrative delta — just what changed (~30–50 tokens)
- **Layer promotions** work the same way — each deeper layer summarizes against its own existing content

The prompt requests a compact delta; models can still omit facts, repeat content, or make mistakes.

---

## 🛡️ Resilient API Handling

- **Exponential backoff** with jitter for rate limits (429) and server errors (500/502/503/504)
- **Retry-After header** respected when the server provides one
- Retries up to 5 times with delays from 2s → 60s
- **Failed batches are never ghosted** — turns stay visible for the next attempt
- Network errors, timeouts, and empty responses are all handled gracefully

---

## 📦 Backlog Detection

Opening an existing chat with 100+ messages? Summaryception detects the backlog and offers you a choice:

| Option | What it does |
|---|---|
| **Process Entire Backlog** | Summarizes everything with a cancelable progress bar |
| **Skip Backlog** | Ignores old turns, only tracks new ones going forward |
| **Just One Batch** | Processes a single batch now, handles the rest incrementally |

Progress is saved continuously — cancel anytime and pick up where you left off.

---

## ⚙️ Configuration

All settings are adjustable from the SillyTavern Extensions panel:

| Setting | Default | Description |
|---|---|---|
| Verbatim Turns | 10 | Recent assistant turns kept word-for-word |
| Turns per Batch | 3 | Oldest turns summarized together per trigger |
| Snippets per Layer | 30 | Max snippets before promoting to next layer |
| Snippets per Promotion | 3 | How many snippets merge on promotion |
| Max Layers | 5 | Maximum recursion depth |

### Prompt Presets

| Preset | Best For | Focus |
|---|---|---|
| **Narrative State** (default) | Character RP, drama, thrillers, romance | Interactions, emotions, relationships, atmosphere, subtext |
| **Game State** | Roguelites, strategy, mechanical games | Plot points, quests, locations, interactables, state changes |
| **Concise Delta** | Small context budgets | Only consequential changes, at most eight phrases |
| **Chronological Events** | Event-heavy stories | Ordered scene changes, causes, consequences |
| **Relationships & Emotional Changes** | Character drama and romance | Trust, intimacy, conflict, commitments |
| **Plot Threads & Goals** | Mysteries and campaigns | Introduced, advanced, and resolved threads |
| **Continuity Recap** | General long-form RP | Balanced events, relationships, and continuity |
| **Custom** | Your own prompt | Whatever you write |

Select a preset from the dropdown in Summary Prompts, or edit the prompt directly — it auto-switches to Custom. The new presets are original adaptations of recurring community approaches discussed in [What is your best summarization prompt?](https://www.reddit.com/r/SillyTavernAI/comments/1urjdn7/what_is_your_best_summarization_prompt/) and [Prompt for summaryception](https://www.reddit.com/r/SillyTavernAI/comments/1whc4fx/prompt_for_summaryception/): meaningful chronological changes, relationships, and unresolved threads. They keep the extension's incremental prior-context contract rather than requesting a full recap on each batch.

Plus fully customizable:
- 📝 Summarizer system prompt
- 📝 Summarizer user prompt (with `{{player_name}}`, `{{context_str}}`, `{{story_txt}}` variables)
- 📝 Injection wrapper template
- 📍 Injection position, in-chat depth, role, and World Info scanning


---

## 🃏 Per-Character Memory Banks

Summaryception can keep memory separated by the active character card inside each chat. When **Separate memory per character card** is enabled, the extension stores the current card's summaries in its own memory bank under the chat metadata. Switching to another card in the same chat selects that card's bank, so injected summaries, the snippet browser, exports, imports, and `/sc-status` all operate on the active card's memory.

Existing single-bank memories are migrated automatically to the currently active card the first time the feature is used. Banks now retain a card identity record (stable SillyTavern card identifier when available, normalized avatar/card filename, display name, and former keys). Legacy numeric-id banks are migrated only when their saved attachment matches the active card; ambiguous matches remain separate and are called out in the database viewer and exports.

When an ambiguous migration preserves obsolete numeric banks, open **View Memory Database** to export and delete banks individually, or choose **Clean Up Legacy Banks** to delete every inactive `character:<number>` bank after one confirmation. The active card bank and shared chat bank are protected from deletion; use **Clear Memory** when you intend to reset the active bank.

### Limitations

- SillyTavern message hiding is still a chat-level operation. Summaryception will unghost the previous card's tracked messages and re-ghost the active card's tracked range when the active card changes, but two character banks cannot hide conflicting ranges at the same time.
- The character key prefers SillyTavern's persistent card identifier, then a normalized avatar/card filename. The positional character id is used only as a session-local last resort. Replacing a card file can therefore intentionally create a new bank.
- This is designed for separating Summaryception memories; it does not isolate SillyTavern's own chat file, lorebooks, or other extensions' metadata.

---

## 🔌 Connection Settings

Summaryception can use different backends for summarization, independent of your main chat connection:

| Source | Description |
|---|---|
| **Default** | Uses SillyTavern's active connection — simplest setup |
| **OpenAI Compatible** | Direct endpoint with URL, API key, and model — bypasses all ST formatting |
| **Ollama** | Local Ollama instance with model browser |
| **Connection Profile** | Uses the profile endpoint/model/auth with preset and instruct formatting disabled |
| **KoboldCPP** | Direct `/v1/completions` access with configurable instruct prefix and suffix |
| **Completion API** | Generic completion endpoint with API key, model, and prompt wrappers |
| **Custom HTTP JSON** | User-defined headers, request-body template, and response JSON path |

> Use the same local model if GPU residency is limited. Direct sources support request-specific cancellation; choose a response limit large enough to finish extraction, especially for reasoning models.

Fork connection settings can be saved as named profiles, updated, duplicated, and restored independently of SillyTavern's own Connection Profiles. Direct-source temperature, timeout, and stop-sequence controls are saved with each profile.

---

## 🗂️ Built-in Tools

- **Layer Stats** — Live view of snippet counts per layer, active character-card bank, and ghosted message count
- **Injection Preview** — See exactly what gets sent to the LLM
- **Injection Debug Overlay** — Opt-in floating view of the live registered block and its budget
- **Regenerate Summaries** — Regenerate latest/all snippets from originals, including promoted source ranges
- **Injection Inspector** — Verify the registered position, depth, role, and injected text
- **Snippet Browser** — Browse, edit, and regenerate narrative snippets. Deletion rolls back dependent later memory and restores original messages for rebuilding.
- **Memory Database Viewer** — Search and inspect every character bank, edit or delete snippets, export a bank, and inspect its raw JSON
- **Export/Import** — Save and restore the active memory bank as JSON
- **Force Summarize** — Manually trigger summarization; automatic/backlog processing preserves the verbatim window, while explicit single-batch force can summarize within it
- **Stop / Cancel Backlog** — Abort the active run; completed backlog batches stay saved
- **Repair** — Repair Summaryception-owned visibility while preserving manually hidden messages
- **Saved Custom Prompts** — Save, load, delete, import, and export prompt text
- **Reset to Defaults** — Reset settings while preserving chat memory and saved profiles/prompts
- **Slash Commands** — `/sc-status`, `/sc-preview`, `/sc-db`, `/sc-clear`

---

## 📥 Installation

### Requirements

- **SillyTavern 1.16.0+** (release or staging). Older versions use an incompatible `generateRaw` signature and will not work correctly.

### From SillyTavern UI
1. Open **Extensions** → **Install Extension**
2. Paste: `https://github.com/Lodactio/Extension-Summaryception`
3. Click Install
4. Find **🧠 Summaryception** in Extensions settings

### Manual
```bash
cd SillyTavern/data/default-user/extensions/third-party/
git clone https://github.com/Lodactio/Extension-Summaryception
```
Restart SillyTavern and enable the extension.

---

## Narrative Memory and Compatibility

Fact tracking has been removed: no fact extraction, catch-up calls, snapshot injection, or pin/correction controls remain. Older banks and imports still retain their narrative snippets, source ranges, signatures, and visibility ownership; retired `structuredState`, `lastFactBatch`, and snippet `recall` metadata are discarded during normalization. Export with the old version first if you want to keep those retired records.

Edits, swipes, deletions, and branches invalidate affected summaries across every bank. Original messages remain available for rebuilding. Budget selection retains whole snippets, counts injection wrappers, and leaves omitted snippets in storage. Generation uses SillyTavern's available tokenizer; previews may use a labeled four-characters-per-token estimate.

### Cancellation and Regeneration

**Cancel Backlog** appears beside a progress bar while processing and in the progress toast. **Stop** also cancels batches, retries, promotions, and regeneration. Already committed batches finish saving their message visibility; later batches do not start. Use **Force Summarize Now** to resume from the saved cutoff. **Cancel** in the initial backlog dialog closes it without skipping or summarizing history.

Select **Latest summary** or **All summaries**, then **Regenerate Summaries** to use the current prompt on the original source messages. Each snippet also has a regenerate control, including promoted snippets with retained source ranges. Earlier context is bounded by the configured budget and excludes future summaries. Bulk regeneration stages replacements in chronological order and only commits after every response succeeds; cancellation or a model failure keeps the originals. It preserves layer structure, source ranges, and message visibility. Older snippets without source ranges can still be edited manually. A promoted snippet can cover a large original passage; if the backend rejects that input, the old summary is kept.

### Injection Debug Overlay

Enable **Advanced Settings → Show Injection Debug Overlay** when debugging. The floating panel shows the actual Summaryception block registered with SillyTavern, its position/depth/role, World Info scanning, measured or estimated tokens, and omitted snippets. It updates when the registered block changes and renders memory as plain text. The overlay defaults to off; closing it disables the setting. SillyTavern's Prompt Inspector remains the way to inspect the complete final prompt after other extensions have contributed.

### Validation

Run `npm ci` then `npm test` (Node.js with `--test-isolation=none` support). The suite covers request cancellation, saved backlog progress, atomic regeneration, source edits and card/chat switches, preset/custom prompts, overlay escaping and updates, legacy migration, whole-snippet budgets, tokenization/settings races, and connection timeout cleanup. Model responses are mocked; this does not establish real-model summary quality or validate a live SillyTavern installation.

---

## Community Forks

These forks extend Summaryception with specialized features. They use the same internal module name, so **install only one at a time** — your existing settings and per-chat memory will carry over.

### [Per-Character Memory Banks](https://github.com/dogoo9/Extension-Summaryception) by dogoo9

Keeps separate summary memory for each character card in the same chat. Useful for group chats or stories where you switch between characters and don't want their memories bleeding together.

### [Lorebook Ingestion](https://github.com/jeromehbonaparte-star/Extension-Summaryception-Lorebook) by Romuromylus

Automatically extracts stable facts (character traits, locations, items) from summaries and proposes them as World Info entries. Summaries handle events and state changes; lorebook entries handle things that should never be forgotten across layers. Includes a review queue so nothing gets written without your approval.

### [Verdash's Summaryception](https://github.com/vadash/Extension-Summaryception) By Verdash

Highly Polished Summaryception with many requested features by the community and superior context management.

---

## 🤝 Credits

Built with frustration at context limits and love for long-form roleplay.

Thank you to Lodactio for creating this fantastic tool! All credit goes to them for this awesome tool.

If this saves your 500-turn adventure from amnesia, consider starring (https://github.com/Lodactio/Extension-Summaryception) repo. ⭐

---

## 📄 License

AGPL-3.0
