/**
 * Summaryception — constants, prompts and default settings
 * AGPL-3.0
 */


const MODULE_NAME = 'summaryception';
const LOG_PREFIX = '[Summaryception]';
const EXTENSION_VERSION = '5.5.7';

// ═══════════════════════════════════════════════════════════════════════
//  TUNING — Centralised operational constants.
//  Change these instead of hunting through function bodies.
// ═══════════════════════════════════════════════════════════════════════

const TUNING = Object.freeze({

    // ── Retry / Resilience ─────────────────────────────────────────
    maxRetries:               5,        // LLM call retry attempts before giving up
    retryBaseDelay:           2_000,    // ms — initial back-off delay
    retryMaxDelay:            60_000,   // ms — ceiling for exponential back-off
    retryBackoffMultiplier:   2,        // exponential growth factor
    retryableStatuses:        [429, 500, 502, 503, 504],
    llmRequestTimeout:        120_000,  // ms — per-request hard timeout

    // ── Backlog / Catchup ──────────────────────────────────────────
    backlogMultiplier:        2,        // overflow > turnsPerSummary × this triggers catchup dialog

    // ── Event Debouncing ───────────────────────────────────────────
    messageReceivedDelay:     500,      // ms — delay after new message before summarisation check
    chatChangedDelay:         100,      // ms — delay after chat switch before UI refresh
    catchupInterBatchDelay:   200,      // ms — breathing room between catchup batches

    // ── Progress Reporting ─────────────────────────────────────────
    ghostProgressInterval:    10,       // update toast every N messages during unghost

    // ── Toast Durations (ms) ───────────────────────────────────────
    // Named by intent so you can tune notification verbosity in one place.
    toastShort:               1_500,
    toastDefault:             2_000,
    toastMedium:              3_000,
    toastLonger:              5_000,
    toastExtended:            6_000,
    toastError:               8_000,

    // ── Connection UI ──────────────────────────────────────────────
    connectionStatusTimeout:  8_000,    // ms — auto-hide the status indicator
});

// Legacy alias — keeps RETRY_CONFIG references readable without a noisy diff.
const RETRY_CONFIG = Object.freeze({
    maxRetries:         TUNING.maxRetries,
    baseDelay:          TUNING.retryBaseDelay,
    maxDelay:           TUNING.retryMaxDelay,
    backoffMultiplier:  TUNING.retryBackoffMultiplier,
    retryableStatuses:  TUNING.retryableStatuses,
});

// ─── Default Settings ────────────────────────────────────────────────

// Retained solely so settings saved with the previous built-in narrative prompt
// can be upgraded without mistaking a user-authored prompt for a preset.
const PREVIOUS_NARRATIVE_PROMPT = `<player_name>{{player_name}}</player_name>
    <prior_context>{{context_str}}</prior_context>
    <passage_in_question>{{story_txt}}</passage_in_question>

    Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

    Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, places, and time references; plot developments and unresolved tensions; details that distinguish this moment from any other.

    Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
    Skip any passages that are empty, unclear, or lack significant content.
    Write in short phrases, no more than 20; output must be a single line:`;

const NARRATIVE_PROMPT = `<player_name>{{player_name}}</player_name>
    <prior_context>{{context_str}}</prior_context>
    <passage_in_question>{{story_txt}}</passage_in_question>

    Summarize only the necessary elements from passage_in_question to coherently continue prior_context. Second-person prose in the passage refers to {{player_name}}; include the player's name in the output.

    Prioritize: character identities, interactions, dialogue tone, relationship dynamics, emotional beats, motivations, narrative themes and subtext; names, places, time references, plot developments, and unresolved goals or tensions. Retain atmosphere and sensory details when they are distinctive or show a change of state; omit generic atmosphere, generic prose, and repetition, including events already covered in prior_context.

    When prior_context is empty, permit a larger initial summary so establishing identities, relationships, location, time, and unresolved goals are retained. Otherwise, write no more than 20 short phrases. Skip passages that are empty, unclear, or lack significant content. Keep the output compact and on a single line:`;

const defaultSettings = Object.freeze({
    enabled: true,
    verbatimTurns: 10,
    turnsPerSummary: 3,
    // false = hysteresis: the verbatim window floats between verbatimTurns and
    // verbatimTurns + turnsPerSummary - 1, so each summarizer call covers a full
    // batch and the prompt prefix changes once per batch instead of every turn.
    strictVerbatimWindow: false,
    snippetsPerLayer: 30,
    snippetsPerPromotion: 3,
    maxLayers: 5,
    archivePromotedSnippets: true,        // keep merged children in store.archive instead of discarding them
    promotionNameCheck: true,             // retry a promotion once when it drops names from its inputs
    protectedNames: '',                   // newline/comma list of names a promotion must keep when present
    contextBudget: 4096,
    contextBudgetUnit: 'tokens',          // 'tokens' (estimated at 4 chars each) | 'characters'
    savedCustomPrompts: [],
    injectionTemplate: '\n\n<auto_injected_historical_context>\n[system guidance: this is a historical summary of messages that occurred prior to the oldest assistant message currently in context for this chat]\n{{summary}}\n</auto_injected_historical_context>\n\n',
    injectionPosition: 'in_prompt',        // 'in_prompt' | 'in_chat' | 'before_prompt'
    injectionDepth: 2,                    // Used only for in-chat injection. 0 = immediately before latest message.
    injectionRole: 'system',              // 'system' | 'user' | 'assistant'
    injectionScan: false,                 // Include summary block in World Info scans

    summarizerSystemPrompt:
        'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt: NARRATIVE_PROMPT,

    promptPreset: 'narrative',
    pauseSummarization: false,  // true = stop processing, keep injecting
    disableGhosting: false,     // mark summarized ranges without hiding messages
    separateMemoryByCharacterCard: true,  // true = keep independent memory banks per active character card within each chat

    stripPatterns: [
        '<|channel>thought',
        '<channel|>',
        '<output>',
        '</output>',
        '<thinking>',
        '</thinking>',
    ],

    debugMode: false,
    traceMode: false,
    injectionDebugOverlay: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default',          // 'default' | 'profile' | 'ollama' | 'openai' | 'koboldcpp' | 'completion' | 'custom'
    summarizerResponseLength: 0,          // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
    savedConnectionProfiles: [],
    activeSavedConnectionProfileId: '',
    summarizerTemperature: 0.3,
    summarizerTimeoutMs: 120000,
    summarizerStopSequences: [],
    connectionProfileId: '',              // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [],                // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0,                   // 0 = no limit (provider default)

    // KoboldCPP direct connection (fork addition)
    koboldcppUrl:    'http://localhost:5001',
    koboldcppPrefix: '<|im_start|>user\n',
    koboldcppSuffix: '<|im_end|>\n<|im_start|>assistant\n',

    completionUrl: '',
    completionKey: '',
    completionModel: '',
    completionPrefix: 'System:\n',
    completionSuffix: '\nAssistant:',

    customUrl: '',
    customHeaders: '{"Content-Type":"application/json"}',
    customBodyTemplate: '{\n  "model": "{{model}}",\n  "messages": [\n    { "role": "system", "content": "{{systemPrompt}}" },\n    { "role": "user", "content": "{{userPrompt}}" }\n  ],\n  "temperature": {{temperature}},\n  "stream": false\n}',
    customResponsePath: 'choices.0.message.content',
    customApiKey: '',
    customModel: '',
});

// ─── Prompt Presets ──────────────────────────────────────────────────

const PROMPT_PRESETS = {
    narrative: NARRATIVE_PROMPT,

    concise: focusedSummaryPrompt('Keep only consequential actions, revelations, decisions, and changes needed to continue the story. Use at most 8 short phrases. Omit flavor, repeated emotions, and dialogue that adds no information.'),
    chronological: focusedSummaryPrompt('Record meaningful events in chronological order. Group related actions into compact scene phrases. Preserve causes, consequences, accomplishments, and transitions between named locations; avoid a play-by-play.'),
    relationships: focusedSummaryPrompt('Prioritize changes in trust, intimacy, conflict, vulnerability, power, and commitments between named characters. Retain decisions, revelations, and plot events that explain those changes. Omit repeated emotions and generic body language.'),
    plotthreads: focusedSummaryPrompt('Prioritize introduced, advanced, or resolved goals, mysteries, promises, threats, and unanswered questions. Identify who is involved and what changed. Preserve necessary events and relationships for continuity; never invent future plans or treat resolved threads as still open.'),
    continuity: focusedSummaryPrompt('Balance chronological events, named character developments, relationship changes, and unresolved plot threads. Preserve consequential changes to location, possessions, injuries, knowledge, and commitments in the narrative. Omit decorative details and repetitions.'),

    gamestate: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

Focus on: story progression, plot points, plans, tasks, quests; location changes and current location (reference by name); location interactables encountered, used, or discovered; significant changes to player, NPCs, locations, world, or setting.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

    custom: null, // Uses whatever is in the textarea
};

const DEFAULT_PROMPT_PRESET = 'narrative';

function focusedSummaryPrompt(focus) {
    return `<player_name>{{player_name}}</player_name>
<prior_context>{{context_str}}</prior_context>
<passage_in_question>{{story_txt}}</passage_in_question>

Pause the roleplay and summarize only new information in passage_in_question needed to coherently continue prior_context. Second-person prose refers to {{player_name}}; use the player's name.
${focus}
Use only supported events from the supplied passage. Do not continue the roleplay, invent motives, or repeat information already in prior_context. If prior_context is empty, establish relevant identities and setting. Output only a compact summary on one line, no headings or commentary, at most 20 short phrases.`;
}

const EXTENSION_PROMPT_TYPES = Object.freeze({
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
});

const EXTENSION_PROMPT_ROLES = Object.freeze({
    system: 0,
    user: 1,
    assistant: 2,
});

const INJECTION_POSITION_LABELS = Object.freeze({
    in_prompt: 'Prompt',
    in_chat: 'In Chat',
    before_prompt: 'Before Prompt',
});

export {
    EXTENSION_PROMPT_ROLES,
    EXTENSION_PROMPT_TYPES,
    EXTENSION_VERSION,
    INJECTION_POSITION_LABELS,
    LOG_PREFIX,
    MODULE_NAME,
    PREVIOUS_NARRATIVE_PROMPT,
    PROMPT_PRESETS,
    RETRY_CONFIG,
    TUNING,
    defaultSettings,
};
