/**
 * Summaryception v5.5.6 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

// ─── Imports ─────────────────────────────────────────────────────────
import {
    sendSummarizerRequest,
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
    getConnectionDisplayName,
} from './connectionutil.js';
import {
    emptyState, validateStoredState, effectiveFacts, stateInstructions, parseStateResponse, factInstructions, parseFactResponse,
    rollbackState, correctState, messageSignature, firstSourceChange,
} from './state-memory.js';
import { createMeter, assembleBudgetedMemory, assembleBudgetedMemoryAsync } from './memory-budget.js';

const MODULE_NAME = 'summaryception';
const LOG_PREFIX = '[Summaryception]';
const EXTENSION_VERSION = '5.5.6';
const shownMigrationWarnings = new Set();
// const TRACE_MODE = true;  // ultra-verbose logging

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
    consecutiveFailureLimit:  3,        // catchup aborts after this many failures in a row

    // ── Backlog / Catchup ──────────────────────────────────────────
    backlogMultiplier:        2,        // overflow > turnsPerSummary × this triggers catchup dialog

    // ── Event Debouncing ───────────────────────────────────────────
    messageReceivedDelay:     500,      // ms — delay after new message before summarisation check
    chatChangedDelay:         100,      // ms — delay after chat switch before UI refresh
    catchupInterBatchDelay:   200,      // ms — breathing room between catchup batches

    // ── Progress Reporting ─────────────────────────────────────────
    ghostProgressInterval:    10,       // update toast every N messages during ghost/unghost
    repairProgressInterval:   5,        // update toast every N messages during repair scan

    // ── Injection Position ─────────────────────────────────────────
    // setExtensionPrompt(name, text, position, depth, scan, role)
    injectionPosition:        1,        // 0 = system prompt, 1 = in-chat
    injectionDepth:           12,       // messages from generation point
    injectionScan:            false,    // watched by World Info?
    injectionRole:            1,        // 0 = system, 1 = user, 2 = assistant

    // ── Toast Durations (ms) ───────────────────────────────────────
    // Named by intent so you can tune notification verbosity in one place.
    toastShort:               1_500,
    toastDefault:             2_000,
    toastMedium:              3_000,
    toastLong:                4_000,
    toastLonger:              5_000,
    toastExtended:            6_000,
    toastError:               8_000,

    // ── Connection UI ──────────────────────────────────────────────
    connectionStatusTimeout:  8_000,    // ms — auto-hide the status indicator
    stopButtonCooldown:       2_000,    // ms — brief disable after clicking Stop
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
    snippetsPerLayer: 30,
    snippetsPerPromotion: 3,
    maxLayers: 5,
    contextBudget: 4096,
    contextBudgetUnit: 'tokens',          // 'tokens' (estimated at 4 chars each) | 'characters'
    structuredStateEnabled: false,
    stateTokenAllowance: 600,
    savedCustomPrompts: [],
    injectionTemplate: '\n\n<auto_injected_historical_context>\n[system guidance: this is a historical summary of messages that occurred prior to the oldest assistant message currently in context for this chat]\n{{summary}}\n</auto_injected_historical_context>\n\n',
    injectionPosition: 'in_prompt',        // 'in_prompt' | 'in_chat' | 'before_prompt'
    injectionDepth: 2,                    // Used only for in-chat injection. 0 = immediately before latest message.
    injectionRole: 'system',              // 'system' | 'user' | 'assistant'
    injectionScan: false,                 // Include summary block in World Info scans

    summarizerSystemPrompt:
        'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt: NARRATIVE_PROMPT,

    promptPreset: 'narrative',  // 'narrative' | 'gamestate' | 'custom'
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


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(error) {
    try {
        const retryAfter = error?.response?.headers?.get?.('retry-after')
            || error?.response?.headers?.['retry-after']
            || error?.retryAfter
            || error?.data?.retry_after;
        if (!retryAfter) return null;
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (e) { /* ignore */ }
    return null;
}

function isRetryableError(error) {
    if (error?.name === 'AbortError') return false;

    // ConnectionError from connectionutil.js carries an explicit retryable flag.
    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }

    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) return true;
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('server error')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('overloaded')) return true;
    if (msg.includes('capacity')) return true;
    return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function trace(...args) {
    const s = getSettings();
    if (s.debugMode && s.traceMode) {
        const normalized = args.map((arg, idx) => (idx === 0 && typeof arg === 'string')
            ? arg.toUpperCase()
            : arg);
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

function debugVisibleTurns(chat, store) {
    trace('=== DEBUG VISIBLE TURNS ===');
    trace('  store.summarizedUpTo:', store.summarizedUpTo);
    trace('  Total chat messages:', chat.length);

    let visibleCount = 0;
    let ghostedCount = 0;
    let hiddenCount = 0;
    let visibleIndices = [];

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes?.trim()?.length > 0) {
            visibleCount++;
            visibleIndices.push(i);
        }
        if (m.extra?.sc_ghosted) ghostedCount++;
        if (m.is_hidden || m.is_system) hiddenCount++;
    }

    trace('  Visible non-ghosted turns:', visibleCount);
    trace('  Ghosted turns:', ghostedCount);
    trace('  Hidden/System turns:', hiddenCount);
    trace('  First 10 visible indices:', visibleIndices.slice(0, 10));
    trace('  Last 10 visible indices:', visibleIndices.slice(-10));

    // Check for messages that should have been ghosted but aren't
    const unghosteredSummarized = visibleIndices.filter(idx => idx <= store.summarizedUpTo);
    if (unghosteredSummarized.length > 0) {
        trace('  ⚠️ WARNING: Found ' + unghosteredSummarized.length + ' visible messages that are BEFORE summarizedUpTo!');
        trace('  First 5 unghostered summarized indices:', unghosteredSummarized.slice(0, 5));
    }
    trace('=== END DEBUG ===');
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function clearPersistentToast(toast) {
    if (!toast) return;
    try {
        toastr.clear(toast);
    } catch (e) {
        log('Could not clear persistent toast:', e);
    }

    // Some SillyTavern/toastr builds leave no-timeout progress toasts in the DOM
    // after the task completes. Remove the returned toast element as a fallback.
    try {
        $(toast).remove();
    } catch (e) {
        log('Could not remove persistent toast element:', e);
    }
}

function createEmptyChatStore() {
    return {
        layers: [],
        summarizedUpTo: -1,
        ghostedIndices: [],           // Track which messages WE ghosted
        structuredState: emptyState(),
        sourceSignatures: [],
    };
}

const assembledContextCache = new WeakMap();
const storeRevisions = new WeakMap();
const injectionReports = new WeakMap();

function invalidateContextCache(store) {
    if (store && typeof store === 'object') {
        assembledContextCache.delete(store);
        storeRevisions.set(store, (storeRevisions.get(store) || 0) + 1);
    }
}

function snippetText(snippet) {
    return typeof snippet === 'string' ? snippet : (snippet?.text || '');
}

function normalizeRecall(recall) {
    if (!recall || typeof recall !== 'object') return undefined;
    const list = value => [...new Set((Array.isArray(value) ? value : [])
        .map(item => String(item).trim()).filter(Boolean))];
    const normalized = {
        entities: list(recall.entities),
        unresolvedThreads: list(recall.unresolvedThreads),
        durableFacts: list(recall.durableFacts),
        currentLocation: typeof recall.currentLocation === 'string' ? recall.currentLocation.trim() : '',
        currentTime: typeof recall.currentTime === 'string' ? recall.currentTime.trim() : '',
        supersededFacts: list(recall.supersededFacts),
    };
    return Object.values(normalized).some(value => Array.isArray(value) ? value.length : value)
        ? normalized : undefined;
}

function mergeRecallFields(snippets) {
    const recalls = snippets.map(sn => normalizeRecall(sn?.recall)).filter(Boolean);
    if (!recalls.length) return undefined;
    const supersededFacts = [...new Set(recalls.flatMap(item => item.supersededFacts))];
    const superseded = new Set(supersededFacts.map(item => item.toLocaleLowerCase()));
    const uniqueActive = field => [...new Set(recalls.flatMap(item => item[field]))]
        .filter(item => !superseded.has(item.toLocaleLowerCase()));
    return normalizeRecall({
        entities: uniqueActive('entities'),
        unresolvedThreads: uniqueActive('unresolvedThreads'),
        durableFacts: uniqueActive('durableFacts'),
        currentLocation: recalls.findLast(item => item.currentLocation)?.currentLocation || '',
        currentTime: recalls.findLast(item => item.currentTime)?.currentTime || '',
        supersededFacts,
    });
}

function normalizeChatStore(store) {
    if (!store || typeof store !== 'object') store = createEmptyChatStore();
    if (!Array.isArray(store.layers)) store.layers = [];
    // Text-only exports remain valid; wrap strings without requiring structured recall data.
    // Keep array identity: callers hold these arrays across reads and requests.
    for (let i = 0; i < store.layers.length; i++) {
        if (!Array.isArray(store.layers[i])) store.layers[i] = [];
        for (let j = store.layers[i].length - 1; j >= 0; j--) {
            const snippet = store.layers[i][j];
            if (typeof snippet === 'string') store.layers[i][j] = { text: snippet };
            else if (!snippet || typeof snippet.text !== 'string') store.layers[i].splice(j, 1);
        }
    }
    if (typeof store.summarizedUpTo !== 'number') store.summarizedUpTo = -1;
    if (!Array.isArray(store.ghostedIndices)) store.ghostedIndices = [];
    if (!store.structuredState) store.structuredState = emptyState();
    if (!Array.isArray(store.sourceSignatures)) store.sourceSignatures = [];
    const chatLength = SillyTavern.getContext()?.chat?.length;
    store.ghostedIndices = [...new Set(store.ghostedIndices.filter(index =>
        Number.isInteger(index)
        && index >= 0
        && (!Number.isInteger(chatLength) || index < chatLength)
    ))].sort((a, b) => a - b);
    return store;
}

function getSummarizedRangeStart(store, endIndex = store.summarizedUpTo) {
    const starts = store.layers.flat()
        .map(snippet => snippet?.turnRange?.[0])
        .filter(index => Number.isInteger(index) && index >= 0 && index <= endIndex);
    return starts.length > 0 ? Math.min(...starts) : 0;
}

function normalizeCardFilename(value) {
    if (!value) return null;
    const decoded = (() => {
        try { return decodeURIComponent(String(value)); } catch { return String(value); }
    })();
    return decoded.replace(/\\/g, '/').split('/').pop().trim().toLowerCase() || null;
}

function getCurrentCharacterIdentity() {

    const ctx = SillyTavern.getContext();
    const id = ctx.characterId ?? ctx.this_chid ?? ctx.chid ?? null;
    const character = ctx.character || (id !== null ? ctx.characters?.[id] : null) || {};
    // Newer SillyTavern versions expose a persistent card id. Keep the list
    // deliberately conservative: these fields identify the card, unlike chid.
    const stableIdentifier = character.uuid
        || character.character_uuid
        || character.id
        || character.data?.uuid
        || character.data?.character_uuid
        || character.data?.id
        || character.data?.extensions?.sillytavern?.id
        || null;
    const avatarFilename = normalizeCardFilename(
        character.avatar || character.data?.avatar || ctx.character?.avatar,
    );

    return {
        stableIdentifier: stableIdentifier ? String(stableIdentifier) : null,
        avatarFilename,
        characterName: character.name || ctx.name2 || 'Unknown character',
        characterId: id,
        formerKeys: [],
        migrationStatus: 'current',
    };
}

function getCharacterMemoryKey() {
    const identity = getCurrentCharacterIdentity();
    if (identity.stableIdentifier) return `character:stable:${encodeURIComponent(identity.stableIdentifier)}`;
    if (identity.avatarFilename) return `character:file:${encodeURIComponent(identity.avatarFilename)}`;

    // chid is an array position and is only safe for the current ST session.
    const id = identity.characterId;
    if (id !== undefined && id !== null && id !== '') return `character:session:${id}`;
    return 'character:unknown';
}

function getCharacterMemoryLabel() {
    const ctx = SillyTavern.getContext();
    return ctx.character?.name
        || ctx.characters?.[ctx.characterId]?.name
        || ctx.name2
        || 'Unknown character';
}

function getCurrentChatAttachmentInfo() {
    const ctx = SillyTavern.getContext();
    const characterId = ctx.characterId ?? ctx.this_chid ?? ctx.chid ?? null;
    const character = characterId !== null ? ctx.characters?.[characterId] : null;
    const groupId = ctx.groupId ?? ctx.selected_group ?? null;
    const group = groupId !== null && Array.isArray(ctx.groups) ? ctx.groups.find(g => g?.id === groupId) : null;
    const chatId = ctx.chatId
        || ctx.chat?.chatId
        || ctx.chat?.id
        || ctx.chatMetadata?.chat_id
        || ctx.chatMetadata?.file_name
        || ctx.chatMetadata?.filename
        || null;
    const chatName = ctx.chatName
        || ctx.chat?.name
        || ctx.chatMetadata?.chat_name
        || ctx.chatMetadata?.name
        || ctx.chatMetadata?.title
        || chatId
        || 'Current chat';

    const identity = getCurrentCharacterIdentity();
    return {
        chatId,
        chatName,
        characterId,
        characterName: ctx.character?.name || character?.name || ctx.name2 || 'Unknown character',
        characterAvatar: ctx.character?.avatar || character?.avatar || null,
        stableIdentifier: identity.stableIdentifier,
        avatarFilename: identity.avatarFilename,
        groupId,
        groupName: group?.name || null,
    };
}

function attachmentsMatchActiveCard(attachment, identity) {
    if (!attachment) return false;
    if (identity.stableIdentifier && attachment.stableIdentifier) {
        return String(attachment.stableIdentifier) === identity.stableIdentifier;
    }
    const savedAvatar = normalizeCardFilename(attachment.avatarFilename || attachment.characterAvatar);
    if (identity.avatarFilename && savedAvatar) return savedAvatar === identity.avatarFilename;
    return Boolean(attachment.characterName && identity.characterName
        && attachment.characterName.trim().toLocaleLowerCase() === identity.characterName.trim().toLocaleLowerCase());
}

function migrateNumericCharacterBanks(memoryRoot, activeKey) {
    const identity = getCurrentCharacterIdentity();
    const candidates = Object.keys(memoryRoot.memories)
        .filter(key => /^character:\d+$/.test(key))
        .filter(key => attachmentsMatchActiveCard(memoryRoot.memoryAttachments[key], identity));
    if (!candidates.length) return;

    const targetOccupied = Boolean(memoryRoot.memories[activeKey]);
    if (candidates.length !== 1 || targetOccupied) {
        const warning = `Could not safely migrate ${candidates.join(', ')} to ${activeKey}; matching memory banks were preserved. Use Clean Up Legacy Banks in Summaryception settings after exporting anything you want to keep.`;
        memoryRoot.migrationWarnings ||= [];
        if (!memoryRoot.migrationWarnings.includes(warning)) memoryRoot.migrationWarnings.push(warning);
        for (const key of candidates) {
            memoryRoot.memoryIdentities[key] = {
                ...identity,
                formerKeys: [key],
                migrationStatus: 'ambiguous-preserved',
            };
        }
        if (!shownMigrationWarnings.has(warning)) {
            toastr.warning(warning, 'Summaryception memory migration', { timeOut: 10000 });
            shownMigrationWarnings.add(warning);
        }
        return;
    }

    const formerKey = candidates[0];
    memoryRoot.memories[activeKey] = memoryRoot.memories[formerKey];
    delete memoryRoot.memories[formerKey];
    memoryRoot.memoryLabels[activeKey] = memoryRoot.memoryLabels[formerKey] || identity.characterName;
    delete memoryRoot.memoryLabels[formerKey];
    memoryRoot.memoryAttachments[activeKey] = {
        ...memoryRoot.memoryAttachments[formerKey],
        ...getCurrentChatAttachmentInfo(),
    };
    delete memoryRoot.memoryAttachments[formerKey];
    delete memoryRoot.memoryIdentities[formerKey];
    memoryRoot.memoryIdentities[activeKey] = {
        ...identity,
        formerKeys: [formerKey],
        migrationStatus: 'migrated',
    };
}

function looksLikeLegacyStore(root) {
    return root && (
        Array.isArray(root.layers)
        || typeof root.summarizedUpTo === 'number'
        || Array.isArray(root.ghostedIndices)
    );
}

function getMemoryRoot() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = createEmptyChatStore();
    }

    const root = chatMetadata[MODULE_NAME];
    if (!getSettings().separateMemoryByCharacterCard) {
        if (root?.memories) {
            const sharedSourceKey = root.activeMemoryKey || getCharacterMemoryKey();
            if (!root.sharedMemory) {
                root.sharedMemory = structuredClone(root.memories[sharedSourceKey] || createEmptyChatStore());
            }
            return normalizeChatStore(root.sharedMemory);
        }
        return normalizeChatStore(root);
    }

    const activeKey = getCharacterMemoryKey();

    // Migration: older Summaryception saves stored one memory bank directly in chatMetadata[MODULE_NAME].
    // Keep that bank for the currently active card, then use a keyed map for future cards.
    if (looksLikeLegacyStore(root)) {
        const migratedStore = normalizeChatStore({
            layers: root.layers,
            summarizedUpTo: root.summarizedUpTo,
            ghostedIndices: root.ghostedIndices,
            structuredState: root.structuredState,
            sourceSignatures: root.sourceSignatures,
        });

        chatMetadata[MODULE_NAME] = {
            version: 3,
            memoryMode: 'perCharacterCard',
            activeMemoryKey: activeKey,
            memories: {
                [activeKey]: migratedStore,
            },
            memoryIdentities: {
                [activeKey]: { ...getCurrentCharacterIdentity(), migrationStatus: 'legacy-store-migrated' },
            },
        };
    }

    const memoryRoot = chatMetadata[MODULE_NAME];
    if (!memoryRoot.memories || typeof memoryRoot.memories !== 'object') {
        memoryRoot.memories = {};
    }
    if (!memoryRoot.memoryLabels || typeof memoryRoot.memoryLabels !== 'object') {
        memoryRoot.memoryLabels = {};
    }
    if (!memoryRoot.memoryAttachments || typeof memoryRoot.memoryAttachments !== 'object') {
        memoryRoot.memoryAttachments = {};
    }
    if (!memoryRoot.memoryIdentities || typeof memoryRoot.memoryIdentities !== 'object') {
        memoryRoot.memoryIdentities = {};
    }
    for (const key of Object.keys(memoryRoot.memories)) {
        if (memoryRoot.memoryIdentities[key]) continue;
        const attachment = memoryRoot.memoryAttachments[key] || {};
        memoryRoot.memoryIdentities[key] = {
            stableIdentifier: attachment.stableIdentifier ? String(attachment.stableIdentifier) : null,
            avatarFilename: normalizeCardFilename(attachment.avatarFilename || attachment.characterAvatar),
            characterName: attachment.characterName || memoryRoot.memoryLabels[key] || 'Unknown character',
            formerKeys: /^character:\d+$/.test(key) ? [key] : [],
            migrationStatus: /^character:\d+$/.test(key) ? 'legacy-unmatched' : 'existing',
        };
    }
    migrateNumericCharacterBanks(memoryRoot, activeKey);
    if (!memoryRoot.memories[activeKey]) {
        memoryRoot.memories[activeKey] = createEmptyChatStore();
    }

    memoryRoot.version = 3;
    memoryRoot.memoryMode = 'perCharacterCard';
    memoryRoot.activeMemoryKey = activeKey;
    memoryRoot.memoryLabels[activeKey] = getCharacterMemoryLabel();
    memoryRoot.memoryAttachments[activeKey] = getCurrentChatAttachmentInfo();
    const previousIdentity = memoryRoot.memoryIdentities[activeKey] || {};
    memoryRoot.memoryIdentities[activeKey] = {
        ...getCurrentCharacterIdentity(),
        formerKeys: Array.isArray(previousIdentity.formerKeys) ? previousIdentity.formerKeys : [],
        migrationStatus: previousIdentity.migrationStatus || 'current',
    };

    return normalizeChatStore(memoryRoot.memories[activeKey]);
}

function getChatStore() {
    return getMemoryRoot();
}

function getAllMemoryStores() {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    const entries = new Map();

    const addEntry = (key, store) => {
        if (!key || entries.has(key)) return;
        entries.set(key, normalizeChatStore(store || createEmptyChatStore()));
    };

    // Always include every per-character bank saved in this chat's Summaryception
    // metadata, even when the user is currently in shared per-chat mode. The
    // database viewer is an audit/export surface, so hiding inactive banks makes
    // saved memories look missing.
    if (root?.memories && typeof root.memories === 'object') {
        for (const [key, store] of Object.entries(root.memories)) {
            addEntry(key, store);
        }
    }

    // Preserve labels/attachments for cards that were seen before but do not yet
    // have snippets, so the viewer can still list all known character banks.
    for (const key of Object.keys(root?.memoryLabels || {})) {
        addEntry(key, root?.memories?.[key]);
    }
    for (const key of Object.keys(root?.memoryAttachments || {})) {
        addEntry(key, root?.memories?.[key]);
    }
    for (const key of Object.keys(root?.memoryIdentities || {})) {
        addEntry(key, root?.memories?.[key]);
    }

    if (root?.sharedMemory) {
        addEntry('chat', root.sharedMemory);
    } else if (looksLikeLegacyStore(root)) {
        addEntry('chat', root);
    }

    if (entries.size === 0) {
        const activeKey = getSettings().separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat';
        addEntry(activeKey, getChatStore());
    }

    return [...entries.entries()];
}

function getMemoryStoreByKey(key) {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];

    if (root?.memories?.[key]) {
        return normalizeChatStore(root.memories[key]);
    }

    if (key === 'chat') {
        if (root?.sharedMemory) return normalizeChatStore(root.sharedMemory);
        if (looksLikeLegacyStore(root)) return normalizeChatStore(root);
        return getSettings().separateMemoryByCharacterCard ? null : getChatStore();
    }

    return null;
}

function getMemorySnippetByPath(bankKey, layerIndex, snippetIndex) {
    const store = getMemoryStoreByKey(bankKey);
    const layer = store?.layers?.[layerIndex];
    const snippet = Array.isArray(layer) ? layer[snippetIndex] : null;
    return { store, layer, snippet };
}

function deleteMemoryBank(bankKey) {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    if (!root || bankKey === getCharacterMemoryKey() || bankKey === 'chat') return false;

    const collections = ['memories', 'memoryLabels', 'memoryAttachments', 'memoryIdentities'];
    const existed = collections.some(name => Object.hasOwn(root[name] || {}, bankKey));
    if (!existed) return false;

    for (const name of collections) {
        if (root[name] && typeof root[name] === 'object') delete root[name][bankKey];
    }

    // Migration warnings are plain text in v3 metadata. Drop a warning once none
    // of the legacy numeric keys named by it remain in the database.
    if (Array.isArray(root.migrationWarnings)) {
        root.migrationWarnings = root.migrationWarnings.filter((warning) => {
            const legacyKeys = String(warning).match(/character:\d+/g) || [];
            return legacyKeys.length === 0
                || legacyKeys.some(key => Object.hasOwn(root.memories || {}, key));
        });
    }
    shownMigrationWarnings.clear();
    return true;
}

function recalculateSummarizedUpTo(store) {
    let maxEnd = -1;
    for (const layer of store?.layers || []) {
        if (!Array.isArray(layer)) continue;
        for (const snippet of layer) {
            const end = snippet?.turnRange?.[1];
            if (Number.isFinite(end)) maxEnd = Math.max(maxEnd, end);
        }
    }
    store.summarizedUpTo = maxEnd;
}

async function persistMemoryDatabaseChange() {
    await saveChatStore();
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.saveChat) await ctx.saveChat();
    } catch (e) {
        log('Could not save chat after memory database change:', e);
    }
    updateInjection();
    updateUI();
}

let displayedMemoryBank = null;

async function activateCharacterMemoryStore() {
    const s = getSettings();
    const store = getChatStore();
    const target = captureMemoryTarget();
    // getChatStore() selects the active bank on reads, so activeMemoryKey cannot
    // reliably identify the bank that currently owns the message flags.
    if (!displayedMemoryBank || displayedMemoryBank.chat !== target.chat || displayedMemoryBank.store !== store) {
        await unghostAllMessages(createEmptyChatStore());
    }
    if (!targetIsCurrent(target)) return;
    if (s.enabled && store.summarizedUpTo >= 0) {
        await ghostMessagesUpTo(store.summarizedUpTo, getSummarizedRangeStart(store), target);
    }
    displayedMemoryBank = { chat: target.chat, store };
    scheduleFactBackfill();
}

async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

// ─── Message Hiding (Ghosting via native /hide /unhide) ──────────────
async function repairGhostingForRange(startIdx, endIdx) {
    const store = getChatStore();
    const before = store.ghostedIndices.length;
    await ghostMessagesUpTo(endIdx, startIdx);
    return store.ghostedIndices.length - before;
}

async function unghostAllMessages(storeOverride = null) {
    const { chat } = SillyTavern.getContext();
    const store = storeOverride ? normalizeChatStore(storeOverride) : getChatStore();
    const target = captureMemoryTarget();

    // Only unhide messages that WE ghosted, not user-hidden messages
    const toUnhide = store.ghostedIndices && store.ghostedIndices.length > 0
        ? [...store.ghostedIndices]
        : [];

    // Fallback for older saves that don't have ghostedIndices:
    // find messages with our sc_ghosted flag
    if (toUnhide.length === 0) {
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.extra?.sc_ghosted) {
                toUnhide.push(i);
            }
        }
    }

    if (toUnhide.length === 0) return;

    const progressToast = toastr.info(
        `Unhiding messages: 0 / ${toUnhide.length}`,
        'Summaryception — Clearing',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
        }
    );

    let processed = 0;
    try {
        for (const idx of toUnhide) {
            if (!targetIsCurrent(target)) return;
            if (idx >= 0 && idx < chat.length) {
                if (!chat[idx]?.extra?.sc_ghosted) continue;
                // Clear our ghost flag
                if (chat[idx]?.extra?.sc_ghosted) {
                    delete chat[idx].extra.sc_ghosted;
                }

                try {
                    await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${idx}`, { showOutput: false });
                } catch (e) {
                    log(`Failed to unhide message ${idx}:`, e);
                }
            }

            processed++;
            if (processed % 10 === 0 || processed === toUnhide.length) {
                const pct = Math.round((processed / toUnhide.length) * 100);
                $(progressToast).find('.toast-message').text(
                    `Unhiding messages: ${processed} / ${toUnhide.length} (${pct}%)`
                );
            }
        }

        // Clear the tracking array
        store.ghostedIndices = [];
        log(`Unghosted ${toUnhide.length} messages (only Summaryception-hidden ones)`);
    } finally {
        clearPersistentToast(progressToast);
    }
}

async function ghostMessagesUpTo(endIndex, startIndex = 0, target = captureMemoryTarget()) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();

    const rangeStart = Math.max(0, Number.isInteger(startIndex) ? startIndex : 0);
    const rangeEnd = Math.min(chat.length - 1, Number.isInteger(endIndex) ? endIndex : -1);
    if (rangeStart > rangeEnd) return;

    const ghostedIndices = new Set(store.ghostedIndices);
    let newlyGhosted = 0;

    for (let i = rangeStart; i <= rangeEnd; i++) {
        if (!targetIsCurrent(target) || currentAbortController?.signal.aborted) break;
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_system && !msg.extra?.sc_ghosted) continue;
        if (!msg.extra) msg.extra = {};
        if (msg.extra.sc_ghosted) continue;

        // Skip messages already hidden by the user (not by us)
        if (msg.is_hidden) {
            log(`Skipping message ${i} — already hidden by user`);
            continue;
        }

        if (!s.disableGhosting) {
            try {
                // Hide messages individually so system messages and messages hidden by
                // the user are never accidentally included in a broad slash-command range.
                await SillyTavern.getContext().executeSlashCommandsWithOptions(
                    `/hide ${i}`,
                    { showOutput: false }
                );
            } catch (error) {
                console.error(LOG_PREFIX, `Failed to hide message ${i}:`, error);
                continue;
            }
        }

        msg.extra.sc_ghosted = true;
        ghostedIndices.add(i);
        newlyGhosted++;
    }

    store.ghostedIndices = [...ghostedIndices].sort((a, b) => a - b);
    log(`Ghosted messages ${rangeStart}–${rangeEnd} (${newlyGhosted} newly marked)${s.disableGhosting ? ' (hiding disabled — metadata only)' : ''}`);
}

// ─── Branch Detection & Repair ───────────────────────────────────────

/**
 * Detect chat branches that copied Summaryception metadata past the new chat's
 * end and trim stale snippets/ghost markers from every memory bank.
 */
function truncateMemoryStore(store, dirty) {
    const hadState = store.structuredState.through >= 0;
    for (let i = 0; i < store.layers.length; i++) {
        store.layers[i] = store.layers[i].filter(sn => sn.turnRange && sn.turnRange[1] < dirty);
    }
    recalculateSummarizedUpTo(store);
    store.structuredState = rollbackState(store.structuredState, dirty);
    if (hadState && store.structuredState.through !== store.summarizedUpTo) {
        store.layers = [];
        store.summarizedUpTo = -1;
        store.structuredState = { ...emptyState(), overrides: store.structuredState.overrides };
    }
    const signatureEnd = Math.max(store.summarizedUpTo, ...store.structuredState.overrides.map(o => o.anchor));
    store.sourceSignatures.length = Math.max(0, signatureEnd + 1);
    store.ghostedIndices = store.ghostedIndices.filter(i => i <= store.summarizedUpTo);
    invalidateContextCache(store);
    if (store.lastBatch?.range?.[1] >= dirty) delete store.lastBatch;
    if (store.lastFactBatch?.range?.[1] >= dirty) delete store.lastFactBatch;
}

function restoreUncoveredGhosts() {
    const { chat } = SillyTavern.getContext();
    const covered = new Set(getChatStore().ghostedIndices);
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (message?.extra?.sc_ghosted && !covered.has(i)) {
            delete message.extra.sc_ghosted;
            delete message.is_hidden;
            message.is_system = false;
        }
    }
}

function reconcileMemorySources(changedHint = null) {
    const { chat } = SillyTavern.getContext();
    if (!chat) return false;
    getChatStore();
    let repaired = false;
    for (const [, store] of getAllMemoryStores()) {
        let dirty = firstSourceChange(store.sourceSignatures, chat);
        const futureRanges = store.layers.flat().filter(sn => sn.turnRange?.[1] >= chat.length);
        if (store.summarizedUpTo >= chat.length || futureRanges.length || store.structuredState.through >= chat.length) {
            dirty = dirty < 0 ? chat.length : Math.min(dirty, chat.length);
        }
        if (Number.isInteger(changedHint) && changedHint >= 0
            && (store.summarizedUpTo >= changedHint || store.structuredState.overrides.some(o => o.anchor >= changedHint))) {
            dirty = dirty < 0 ? changedHint : Math.min(dirty, changedHint);
        }
        if (dirty < 0) continue;
        truncateMemoryStore(store, dirty);
        repaired = true;
    }
    if (repaired) {
        abortSummarization();
        restoreUncoveredGhosts();
    }
    return repaired;
}

async function repairIfBranched() {
    if (reconcileMemorySources()) {
        await saveChatStore();
        const ctx = SillyTavern.getContext();
        if (ctx.saveChat) await ctx.saveChat();
        toastr.info('Changed source messages detected. Affected memories were rolled back; original messages are available for rebuilding.', 'Summaryception', { timeOut: 6000 });
    }
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        const isOurGhost = m.extra?.sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);
        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Build passage text from a range of chat messages.
 * Skips messages that are hidden (by user or system) UNLESS they were
 * hidden by Summaryception (sc_ghosted). Also skips empty messages.
 */
function buildPassageFromRange(chat, startIdx, endIdx, includeMessageIndices = false) {
    const lines = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!m.mes || !m.mes.trim()) continue;

        // Skip messages hidden by the user (not by us)
        // A message hidden by the user will be is_system/is_hidden but NOT sc_ghosted
        // A message hidden by us will have sc_ghosted = true
        const isUserHidden = (m.is_system || m.is_hidden) && !m.extra?.sc_ghosted;
        if (isUserHidden) continue;

        const speaker = m.is_user ? 'Player' : 'Assistant';
        const source = includeMessageIndices ? `[Message ${i}; ${m.name || speaker}] ` : '';
        lines.push(`${source}${speaker}: ${m.mes.trim()}`);
    }
    return lines.join('\n');
}

/**
 * Build a full context string from all layers down to (and including) a target layer.
 * Deepest layers first, target layer last — gives the summarizer full awareness
 * of what's already been captured so it can avoid redundancy.
 *
 * @param {number} downToLayer - Include this layer and all layers above it
 * @returns {string} - Combined context string, or '(none yet)'
 */
function getContextBudgetCharacters(settings = getSettings()) {
    const amount = Math.max(1, Number(settings.contextBudget) || defaultSettings.contextBudget);
    return Math.floor(amount * (settings.contextBudgetUnit === 'characters' ? 1 : 4));
}

function fitContextParts(parts, budget) {
    const accepted = [];
    let remaining = budget;
    for (const part of parts) {
        const text = String(part.text || '').trim();
        if (!text) continue;
        const separator = accepted.length ? 1 : 0;
        if (text.length + separator > remaining) {
            continue;
        }
        accepted.push(part);
        remaining -= text.length + separator;
    }
    return accepted;
}

function buildFullContext(downToLayer = 0) {
    const store = getChatStore();
    const budget = getContextBudgetCharacters();
    const cacheKey = `${downToLayer}:${budget}`;
    const cached = assembledContextCache.get(store);
    if (cached?.has(cacheKey)) return cached.get(cacheKey);

    let deepest = -1;
    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        if (store.layers[i]?.length) { deepest = i; break; }
    }

    // The deepest layer is canonical history. Fill remaining space with the newest
    // lower-layer (not-yet-promoted) snippets, but emit each group chronologically.
    const candidates = [];
    if (deepest >= 0) {
        for (const sn of store.layers[deepest]) candidates.push({ text: snippetText(sn) });
        for (let i = deepest - 1; i >= downToLayer; i--) {
            const layer = store.layers[i] || [];
            for (let j = layer.length - 1; j >= 0; j--) {
                candidates.push({ text: snippetText(layer[j]), recent: true, layer: i, order: j });
            }
        }
    }
    const selected = fitContextParts(candidates, budget);
    const canonical = selected.filter(part => !part.recent);
    const recent = selected.filter(part => part.recent)
        .sort((a, b) => b.layer - a.layer || a.order - b.order);
    const result = [...canonical, ...recent].map(part => part.text).join(' ') || '(none yet)';
    const bankCache = cached || new Map();
    bankCache.set(cacheKey, result);
    assembledContextCache.set(store, bankCache);
    return result;
}

// ─── Prompt Toggle Management ────────────────────────────────────────

function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }
        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) return snapshot;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return snapshot;
        snapshot.orderEntries = orderList;
        for (const entry of collection.collection) {
            for (const orderEntry of orderList) {
                if (orderEntry.identifier === entry.identifier) {
                    snapshot.set(entry.identifier, orderEntry.enabled);
                }
            }
        }
        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

function disableAllPromptToggles() {
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }
        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    try {
        const orderList = snapshot.orderEntries;
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }
        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Output Cleaning ─────────────────────────────────────────────────

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 */
function cleanSummarizerOutput(raw) {
    let text = String(raw || '');
    // Remove complete reasoning blocks BEFORE removing their delimiters.
    text = text.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '')
        .replace(/<(thinking|think|reasoning|thought|reflect|inner_monologue)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<output>([\s\S]*?)<\/output>/gi, '$1');
    for (const pattern of getSettings().stripPatterns || []) {
        if (pattern) text = text.replaceAll(pattern, '');
    }
    return text.replace(/\n{3,}/g, '\n').trim();
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;
let currentAbortController = null;
let activeRun = null;
let chatEpoch = 0;
let catchupDialogClose = null;
let factBackfillTimer = null;
let pendingFactBackfill = null;
const factBackfillAttempts = new WeakMap();

function captureMemoryTarget() {
    const ctx = SillyTavern.getContext();
    return {
        chat: ctx.chat, metadata: ctx.chatMetadata, epoch: chatEpoch,
        key: getSettings().separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat',
        store: getChatStore(),
    };
}

function targetIsCurrent(target) {
    const ctx = SillyTavern.getContext();
    const key = getSettings().separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat';
    return target && target.epoch === chatEpoch && target.chat === ctx.chat
        && target.metadata === ctx.chatMetadata && target.key === key && target.store === getChatStore();
}

function captureTransaction(target, through) {
    return { target, revision: storeRevisions.get(target.store) || 0,
        signatures: target.chat.slice(0, through + 1).map(messageSignature) };
}

function transactionIsCurrent(transaction) {
    return targetIsCurrent(transaction.target)
        && transaction.revision === (storeRevisions.get(transaction.target.store) || 0)
        && firstSourceChange(transaction.signatures, transaction.target.chat) < 0
        && !currentAbortController?.signal.aborted;
}

function beginSummarization() {
    if (isSummarizing) return null;
    currentAbortController = new AbortController();
    activeRun = { target: captureMemoryTarget(), controller: currentAbortController };
    isSummarizing = true;
    return activeRun;
}

function finishSummarization(run) {
    if (activeRun !== run) return;
    activeRun = null;
    currentAbortController = null;
    isSummarizing = false;
    if (pendingFactBackfill) queueFactBackfill();
    if (!run.controller.signal.aborted && targetIsCurrent(run.pendingSummaryTarget)) {
        onMessageReceived(run.pendingSummaryMessageIndex);
    }
}

function abortSummarization() {
    clearTimeout(factBackfillTimer);
    pendingFactBackfill = null;
    currentAbortController?.abort();
    catchupDialogClose?.();
    // Keep the run locked until its finally block, including promotion/catchup.
}

function runIsCurrent(run) {
    return run && activeRun === run && !run.controller.signal.aborted && targetIsCurrent(run.target);
}

function delayWithSignal(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

async function callSummarizer(storyTxt, contextStr, extraInstructions = '', structured = false, factsOnly = false) {
    const s = structuredClone(getSettings());
    const variables = { player_name: getPlayerName(), context_str: contextStr || '(none yet)', story_txt: storyTxt };
    const prompt = (factsOnly ? `Extract supported facts from this original RP passage:\n${storyTxt}`
        : s.summarizerUserPrompt.replace(/{{(player_name|context_str|story_txt)}}/g, (_, key) => variables[key]))
        + (extraInstructions ? `\n\n${extraInstructions}` : '');
    const systemPrompt = factsOnly ? 'You maintain factual RP memory. Use only the supplied original passage and validated snapshot. Return the requested complete JSON object, with no commentary.' : s.summarizerSystemPrompt + (structured
        ? '\nReturn the complete JSON summary/stateChanges object required below, without commentary.' : '');
    const defaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = defaultMode ? snapshotPromptToggles() : null;
    if (defaultMode) disableAllPromptToggles();
    const parent = currentAbortController?.signal;
    let lastError;
    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            if (parent?.aborted) return '';
            const request = new AbortController();
            let timer, onAbort;
            try {
                const timeout = Math.max(1000, Number(s.summarizerTimeoutMs) || TUNING.llmRequestTimeout);
                const cancelled = new Promise((_, reject) => {
                    onAbort = () => { request.abort(); reject(new DOMException('Aborted by user', 'AbortError')); };
                    parent?.addEventListener('abort', onAbort, { once: true });
                    timer = setTimeout(() => {
                        request.abort();
                        reject(new Error(`Request timed out after ${Math.round(timeout / 1000)}s`));
                    }, timeout);
                });
                const raw = await Promise.race([
                    sendSummarizerRequest(s, systemPrompt, prompt, { signal: request.signal }), cancelled,
                ]);
                if (parent?.aborted) return '';
                const result = structured ? String(raw || '').trim() : cleanSummarizerOutput(raw);
                if (!result) { const error = new Error('Empty response from summarizer'); error.retryable = true; throw error; }
                return result;
            } catch (error) {
                lastError = error;
                if (parent?.aborted || error.name === 'AbortError') return '';
                if (!(error.retryable === true || isRetryableError(error)) || attempt === RETRY_CONFIG.maxRetries) break;
                const delay = Math.min(parseRetryAfter(error) ?? (RETRY_CONFIG.baseDelay * 2 ** attempt + Math.random() * RETRY_CONFIG.baseDelay), RETRY_CONFIG.maxDelay);
                toastr.warning(`Summarizer request failed. Retrying in ${(delay / 1000).toFixed(1)}s.`, 'Summaryception', { timeOut: delay });
                // Clean the request resources before backoff, then use the run's signal.
                clearTimeout(timer);
                parent?.removeEventListener('abort', onAbort);
                await delayWithSignal(delay, parent);
            } finally {
                clearTimeout(timer);
                parent?.removeEventListener('abort', onAbort);
            }
        }
        console.error(LOG_PREFIX, 'Summarization failed:', lastError);
        toastr.error(`Summarization failed: ${lastError?.message || 'unknown error'}. Source messages kept for retry.`, 'Summaryception', { timeOut: 8000 });
        return '';
    } finally {
        if (snapshot) restorePromptToggles(snapshot);
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

function unsummarizedTurns(chat, store) {
    return getAssistantTurns(chat).filter(turn => turn.index > store.summarizedUpTo
        && !(chat[turn.index].is_hidden && !chat[turn.index].extra?.sc_ghosted));
}

function needsFactBackfill(store) {
    return store.summarizedUpTo >= 0 && (store.structuredState.from > 0
        || store.structuredState.through < store.summarizedUpTo);
}

function factBackfillKey(store) {
    return `${store.summarizedUpTo}/${store.structuredState.through}/${store.structuredState.from}/${storeRevisions.get(store) || 0}`;
}

// Debounce chat/card activation and enable events. A busy run drains the queued
// request in its finally block; failed extraction is not retried on every render.
function scheduleFactBackfill(force = false) {
    const s = getSettings();
    if (!s.enabled || !s.structuredStateEnabled || s.pauseSummarization) return;
    const target = captureMemoryTarget();
    if (!needsFactBackfill(target.store)) return;
    pendingFactBackfill = { target, force: force || Boolean(pendingFactBackfill?.force) };
    queueFactBackfill();
}

function queueFactBackfill() {
    clearTimeout(factBackfillTimer);
    factBackfillTimer = setTimeout(async () => {
        factBackfillTimer = null;
        if (isSummarizing) return;
        const queued = pendingFactBackfill;
        pendingFactBackfill = null;
        const s = getSettings();
        if (!queued || !targetIsCurrent(queued.target) || !s.enabled || !s.structuredStateEnabled || s.pauseSummarization) return;
        if (!queued.force && factBackfillAttempts.get(queued.target.store) === factBackfillKey(queued.target.store)) return;
        await extractMissingFacts();
    }, 100);
}

async function extractMissingFacts() {
    const s = getSettings();
    if (!s.enabled || !s.structuredStateEnabled || s.pauseSummarization || isSummarizing) return false;
    const run = beginSummarization();
    if (!run) return false;
    try {
        reconcileMemorySources();
        if (!runIsCurrent(run)) return false;
        return await backfillStructuredState(run);
    } catch (error) {
        toastr.error(`Fact catch-up paused: ${error.message}. Existing narrative kept.`, 'Summaryception');
        return false;
    } finally {
        factBackfillAttempts.set(run.target.store, factBackfillKey(run.target.store));
        finishSummarization(run);
        updateInjection(); updateUI();
    }
}

async function backfillStructuredState(run) {
    if (!runIsCurrent(run) || !getSettings().structuredStateEnabled) return false;
    const { chat, store } = run.target;
    if (!needsFactBackfill(store)) return true;
    // Old partial snapshots missed earlier facts. Replay locally from zero, but
    // replace stored state only after a valid response; keep manual locks.
    let state = store.structuredState.from > 0
        ? { ...emptyState(), overrides: structuredClone(store.structuredState.overrides) } : store.structuredState;
    const cutoff = store.summarizedUpTo;
    const batchSize = Math.max(1, Math.floor(Number(getSettings().turnsPerSummary) || 3));
    const turns = getAssistantTurns(chat).filter(turn => turn.index > state.through && turn.index <= cutoff);
    let turnOffset = 0;
    let completed = 0;
    const toast = toastr.info(`Extracting missing facts through message ${cutoff}…`, 'Summaryception', {
        timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true, onCloseClick: abortSummarization,
    });
    run.factProgress = { through: state.through, cutoff };
    updateUI();
    try {
        while (state.through < cutoff && runIsCurrent(run)) {
            const start = state.through + 1;
            const end = turns.length - turnOffset > batchSize ? turns[turnOffset + batchSize - 1].index : cutoff;
            turnOffset += batchSize;
            const range = [start, end];
            const transaction = captureTransaction(run.target, end);
            const passage = buildPassageFromRange(chat, start, end, true);
            const started = performance.now();
            const result = passage.trim()
                ? await callSummarizer(passage, '', factInstructions(state, range), true, true)
                : '{"stateChanges":[]}';
            if (!result || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return false;
            let next;
            try { next = parseFactResponse(result, state, range); }
            catch (error) {
                toastr.error(`${error.message}. Fact catch-up paused; use Extract Missing Facts to retry. Existing narrative kept.`, 'Summaryception');
                return false;
            }
            store.structuredState = next;
            for (let i = 0; i <= end; i++) store.sourceSignatures[i] = transaction.signatures[i];
            store.lastFactBatch = { milliseconds: Math.round(performance.now() - started), range };
            invalidateContextCache(store);
            state = next;
            completed++;
            run.factProgress.through = end;
            await saveChatStore();
            if (!runIsCurrent(run)) return false;
            $(toast).find('.toast-message').text(`Extracting facts: message ${end} / ${cutoff} — click × to stop`);
            updateInjection(); updateUI();
            await delayWithSignal(TUNING.catchupInterBatchDelay, run.controller.signal);
        }
        if (!runIsCurrent(run)) return false;
        toastr.success(`Fact catch-up complete: ${completed} batches, ${effectiveFacts(state).length} facts.`, 'Summaryception');
        return true;
    } finally {
        delete run.factProgress;
        clearPersistentToast(toast);
    }
}

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled || s.pauseSummarization || isSummarizing) return;
    const target = captureMemoryTarget();
    const visible = unsummarizedTurns(target.chat, target.store);
    const overflow = visible.length - s.verbatimTurns;
    if (overflow <= 0) return;
    if (overflow > s.turnsPerSummary * TUNING.backlogMultiplier && !catchupDismissed) {
        const run = beginSummarization();
        if (!run) return;
        let choice;
        try { choice = await showCatchupDialog(overflow, Math.ceil(overflow / s.turnsPerSummary)); }
        finally { finishSummarization(run); }
        if (!targetIsCurrent(target) || run.controller.signal.aborted) return;
        if (choice === 'skip') {
            target.store.summarizedUpTo = visible[overflow - 1].index;
            invalidateContextCache(target.store);
            catchupDismissed = true;
            await saveChatStore();
            return;
        }
        if (choice === 'catchup') return runCatchup(visible, overflow);
        if (choice !== 'partial') return;
        catchupDismissed = true;
        return summarizeOneBatch(visible.slice(0, overflow));
    }
    // Preserve the configured verbatim window, even when overflow < batch size.
    await summarizeOneBatch(visible.slice(0, overflow));
}

async function summarizeOneBatch(visibleTurns) {
    const run = beginSummarization();
    if (!run) return false;
    try { return await summarizeOneBatchFromTurns(visibleTurns, run); }
    catch (error) {
        console.error(LOG_PREFIX, 'Batch processing failed:', error);
        toastr.error(`Could not finish saving the batch: ${error.message}. Check the active memory before continuing.`, 'Summaryception');
        return false;
    }
    finally { finishSummarization(run); updateInjection(); updateUI(); }
}

async function summarizeOneBatchFromTurns(visibleTurns, run = activeRun) {
    if (!runIsCurrent(run)) return false;
    // A snapshot must first include existing summarized originals, including
    // text-only batches created while tracking was disabled.
    if (getSettings().structuredStateEnabled && !await backfillStructuredState(run)) return false;
    if (!runIsCurrent(run)) return false;
    const { chat, store } = run.target;
    const s = getSettings();
    const batch = visibleTurns.filter(turn => turn.index > store.summarizedUpTo).slice(0, s.turnsPerSummary);
    if (!batch.length) return false;
    // Include the player lead-in and all interleaved messages, including message 0.
    const passageStart = Math.max(0, store.summarizedUpTo + 1);
    const endIdx = batch.at(-1).index;
    const storyTxt = buildPassageFromRange(chat, passageStart, endIdx, Boolean(s.structuredStateEnabled));
    if (!storyTxt.trim()) return false;
    const transaction = captureTransaction(run.target, endIdx);
    const range = [passageStart, endIdx];
    const stateEnabled = Boolean(s.structuredStateEnabled);
    const instructions = stateEnabled ? stateInstructions(store.structuredState, range) : '';
    const started = performance.now();
    const result = await callSummarizer(storyTxt, buildFullContext(0), instructions, stateEnabled);
    if (!result || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return false;
    let parsed = { summary: result, state: store.structuredState };
    if (stateEnabled) {
        try { parsed = parseStateResponse(result, store.structuredState, range); }
        catch (error) {
            toastr.error(`${error.message}. Previous state and source messages kept.`, 'Summaryception', { timeOut: 8000 });
            return false;
        }
    }
    // No awaits between validation and the combined narrative/state commit.
    if (!store.layers[0]) store.layers[0] = [];
    store.layers[0].push({ text: parsed.summary, turnRange: range, timestamp: Date.now() });
    store.structuredState = parsed.state;
    store.summarizedUpTo = endIdx;
    for (let i = 0; i <= endIdx; i++) store.sourceSignatures[i] = transaction.signatures[i];
    store.lastBatch = { milliseconds: Math.round(performance.now() - started), structuredState: stateEnabled, range };
    invalidateContextCache(store);
    await saveChatStore();
    if (!runIsCurrent(run)) return true;
    await ghostMessagesUpTo(endIdx, passageStart, run.target);
    if (!runIsCurrent(run)) return true;
    await maybePromoteLayer(0, run);
    if (!runIsCurrent(run)) return true;
    await saveChatStore();
    const ctx = SillyTavern.getContext();
    if (ctx.saveChat) await ctx.saveChat();
    updateInjection();
    return true;
}

async function runCatchup(visibleTurns, overflow) {
    const run = beginSummarization();
    if (!run) return;
    const s = getSettings();
    const total = Math.ceil(overflow / s.turnsPerSummary);
    let completed = 0;
    const toast = toastr.info(`Processing backlog: 0 / ${total}`, 'Summaryception', {
        timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true, onCloseClick: abortSummarization,
    });
    try {
        while (runIsCurrent(run)) {
            const turns = unsummarizedTurns(run.target.chat, run.target.store);
            const remaining = turns.length - s.verbatimTurns;
            if (remaining <= 0) break;
            if (!await summarizeOneBatchFromTurns(turns.slice(0, remaining), run)) break;
            completed++;
            $(toast).find('.toast-message').text(`Processing backlog: ${completed} / ${total} — click × to stop`);
            updateUI();
            await delayWithSignal(TUNING.catchupInterBatchDelay, run.controller.signal);
        }
        if (targetIsCurrent(run.target)) {
            const stopped = run.controller.signal.aborted || unsummarizedTurns(run.target.chat, run.target.store).length > s.verbatimTurns;
            toastr.info(`${stopped ? 'Catch-up paused' : 'Catch-up complete'}: ${completed} batches saved.`, 'Summaryception');
        }
    } catch (error) {
        console.error(LOG_PREFIX, 'Catch-up processing failed:', error);
        toastr.error(`Catch-up paused: ${error.message}. Check saved memory before continuing.`, 'Summaryception');
    } finally {
        clearPersistentToast(toast);
        finishSummarization(run);
        updateInjection();
        updateUI();
    }
}

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your ${s.verbatimTurns} verbatim limit).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Summarize all ${overflowCount} turns — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Summarize ${s.turnsPerSummary} turns now, deal with the rest later</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);
        const finish = choice => {
            overlay.remove();
            document.removeEventListener('keydown', keyHandler);
            if (catchupDialogClose === cancel) catchupDialogClose = null;
            resolve(choice);
        };
        const cancel = () => finish('cancel');
        const keyHandler = event => { if (event.key === 'Escape') cancel(); };
        catchupDialogClose = cancel;
        document.addEventListener('keydown', keyHandler);
        overlay.addEventListener('click', event => { if (event.target === overlay) cancel(); });
        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => {
            finish('catchup');
        });
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => {
            finish('skip');
        });
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => {
            finish('partial');
        });
    });
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function maybePromoteLayer(layerIndex, run = activeRun) {
    if (!runIsCurrent(run)) return;
    const s = getSettings();
    const store = run.target.store;
    if (layerIndex >= s.maxLayers - 1) return;
    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;
    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];
    if (!destLayer.length) {
        const seed = layer.shift();
        destLayer.push({ ...seed, promoted: true, seedFromLayer: layerIndex });
        invalidateContextCache(store);
    } else {
        // Keep original snippets in storage throughout the request. A failed or
        // canceled promotion cannot temporarily remove history or need a rollback.
        const toMerge = layer.slice(0, s.snippetsPerPromotion);
        const transaction = captureTransaction(run.target, store.summarizedUpTo);
        const text = await callSummarizer(toMerge.map(snippetText).join(' '), buildFullContext(layerIndex + 1),
            'This is historical memory promotion. Preserve identities, durable facts and unresolved threads. Keep events chronological. Do not describe this older passage as the current scene.');
        if (!text || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return;
        const recall = mergeRecallFields(toMerge);
        const ranges = toMerge.map(sn => sn.turnRange).filter(Boolean);
        layer.splice(0, toMerge.length);
        destLayer.push({ text, fromLayer: layerIndex, mergedCount: toMerge.length, timestamp: Date.now(),
            ...(ranges.length === toMerge.length ? { turnRange: [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))] } : {}),
            ...(recall ? { recall } : {}),
        });
        // Promotion only changes narrative layers. It never writes structured state.
        invalidateContextCache(store);
    }
    if (layer.length > s.snippetsPerLayer) await maybePromoteLayer(layerIndex, run);
    if (destLayer.length > s.snippetsPerLayer) await maybePromoteLayer(layerIndex + 1, run);
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

function getMemoryMeter() {
    const ctx = SillyTavern.getContext();
    // Modern ST exposes async token counting. Use a synchronous tokenizer only
    // when one is available; never pretend an estimate is a measured token count.
    const tokenize = typeof ctx.getTokenCount === 'function' && ctx.getTokenCount.constructor.name !== 'AsyncFunction'
        ? text => ctx.getTokenCount(text) : undefined;
    return createMeter(getSettings(), tokenize);
}

function getMemoryAssemblyOptions() {
    const s = getSettings();
    const store = getChatStore();
    const snippets = [];
    for (let i = store.layers.length - 1; i >= 0; i--) snippets.push(...(store.layers[i] || []));
    const state = store.structuredState;
    const facts = s.structuredStateEnabled ? effectiveFacts(state) : [];
    // Prioritize canonical deepest history, then newest unpromoted events;
    // render accepted snippets in chronological order.
    const deepest = store.layers.findLastIndex(layer => layer?.length);
    const canonicalCount = deepest >= 0 ? store.layers[deepest].length : 0;
    const narrative = snippets.map((sn, order) => ({ text: snippetText(sn), order }));
    const legacyRecall = !s.structuredStateEnabled ? mergeRecallFields(snippets) : null;
    const legacyParts = legacyRecall ? [
        legacyRecall.unresolvedThreads.length ? `Historical unresolved threads: ${legacyRecall.unresolvedThreads.join('; ')}` : '',
        legacyRecall.durableFacts.length ? `Historical durable facts: ${legacyRecall.durableFacts.join('; ')}` : '',
        legacyRecall.entities.length ? `Historical entities: ${legacyRecall.entities.join('; ')}` : '',
        legacyRecall.currentLocation || legacyRecall.currentTime
            ? `Historical recalled scene: ${[legacyRecall.currentLocation, legacyRecall.currentTime].filter(Boolean).join('; ')}` : '',
    ].filter(Boolean).map((text, index) => ({ text, order: index - 4 })) : [];
    const prioritized = [...legacyParts, ...narrative.slice(0, canonicalCount), ...narrative.slice(canonicalCount).reverse()];
    return {
        narrative: prioritized, facts, state,
        template: s.injectionTemplate || defaultSettings.injectionTemplate,
        meter: getMemoryMeter(), stateAllowance: Math.min(800, Math.max(400, Number(s.stateTokenAllowance) || 600)),
    };
}

function assembleSummaryBlock() {
    const store = getChatStore();
    const report = assembleBudgetedMemory(getMemoryAssemblyOptions());
    injectionReports.set(store, report);
    return report.text;
}

function getInjectionPositionValue(position) {
    switch (position) {
        case 'in_chat':
            return EXTENSION_PROMPT_TYPES.IN_CHAT;
        case 'before_prompt':
            return EXTENSION_PROMPT_TYPES.BEFORE_PROMPT;
        case 'in_prompt':
        default:
            return EXTENSION_PROMPT_TYPES.IN_PROMPT;
    }
}

function getInjectionRoleValue(role) {
    return EXTENSION_PROMPT_ROLES[role] ?? EXTENSION_PROMPT_ROLES.system;
}

function getInjectionDepthValue(settings) {
    const parsed = Number(settings.injectionDepth);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    return defaultSettings.injectionDepth;
}

function getInjectionDebugSummary(value, position, depth, scan, role) {
    return {
        chars: value?.length || 0,
        position,
        positionLabel: INJECTION_POSITION_LABELS[getSettings().injectionPosition] || 'Prompt',
        depth,
        scan,
        role,
        roleLabel: getSettings().injectionRole || 'system',
    };
}

function setSummaryceptionExtensionPrompt(value) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();

    if (typeof ctx.setExtensionPrompt !== 'function') {
        throw new Error('SillyTavern setExtensionPrompt API is not available. Update SillyTavern or reload the page.');
    }

    const position = getInjectionPositionValue(s.injectionPosition);
    const depth = getInjectionDepthValue(s);
    const scan = Boolean(s.injectionScan);
    const role = getInjectionRoleValue(s.injectionRole);

    ctx.setExtensionPrompt(MODULE_NAME, value || '', position, depth, scan, role);

    const registered = ctx.extensionPrompts?.[MODULE_NAME];
    if (registered && registered.value !== String(value || '')) {
        console.warn(LOG_PREFIX, 'Extension prompt registry did not retain the expected value.', registered);
    }

    return getInjectionDebugSummary(value || '', position, depth, scan, role);
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

function updateInjection() {
    try {
        if (reconcileMemorySources()) {
            // Reconciliation is synchronous; persist without delaying prompt assembly.
            saveChatStore().catch(error => log('Could not persist source repair:', error));
        }
        const s = getSettings();

        if (!s.enabled) {
            const info = setSummaryceptionExtensionPrompt('');
            log('Injection cleared because Summaryception is disabled:', info);
            return false;
        }

        const summaryBlock = assembleSummaryBlock();
        if (!summaryBlock) {
            const info = setSummaryceptionExtensionPrompt('');
            log('Injection cleared because there is no summary block:', info);
            return false;
        }

        const info = setSummaryceptionExtensionPrompt(summaryBlock);
        log('Injection updated:', info);
        return true;
    } catch (e) {
        console.error(LOG_PREFIX, 'updateInjection error:', e);
        toastr.error(`Summary injection failed: ${e.message || e}`, 'Summaryception', { timeOut: 8000 });
        return false;
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────

let messageReceivedTimer = null;

function onMessageReceived(messageIndex) {
    if (!getSettings().enabled) return;
    try {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            const target = captureMemoryTarget();
            clearTimeout(messageReceivedTimer);
            messageReceivedTimer = setTimeout(async () => {
                if (!targetIsCurrent(target)) return;
                if (isSummarizing) {
                    activeRun.pendingSummaryTarget = target;
                    activeRun.pendingSummaryMessageIndex = messageIndex;
                    return;
                }
                await maybeSummarizeTurns();
                updateInjection();
                updateUI();
            }, TUNING.messageReceivedDelay);
        }
    } catch (e) {
        log('onMessageReceived error:', e);
    }
}

function onChatChanged() {
    log('Chat changed.');
    abortSummarization();
    clearTimeout(messageReceivedTimer);
    chatEpoch++;
    document.querySelector('.sc-db-overlay')?.scClose?.();
    setSummaryceptionExtensionPrompt('');
    catchupDismissed = false;
    const epoch = chatEpoch;
    setTimeout(async () => {
        if (epoch !== chatEpoch) return;
        await repairIfBranched();
        if (epoch !== chatEpoch) return;
        await activateCharacterMemoryStore();
        if (epoch !== chatEpoch) return;
        updateInjection();
        updateUI();
    }, 100);
}

async function onGenerationStarted() {
    updateInjection();
    if (!getSettings().enabled) return;
    const ctx = SillyTavern.getContext();
    const tokenizer = ctx.getTokenCountAsync || ctx.getTokenCount;
    if (typeof tokenizer !== 'function' || getSettings().contextBudgetUnit === 'characters') return;
    const target = captureMemoryTarget();
    const through = Math.max(target.store.summarizedUpTo, ...target.store.structuredState.overrides.map(o => o.anchor));
    const transaction = captureTransaction(target, through);
    const report = await assembleBudgetedMemoryAsync(getMemoryAssemblyOptions(), text => tokenizer.call(ctx, text));
    if (!transactionIsCurrent(transaction)) return;
    injectionReports.set(target.store, report);
    setSummaryceptionExtensionPrompt(report.text);
    $('#sc_preview').val(report.text || '(empty — budget cannot fit a complete memory item)');
    updateInjectionInspector(report.text);
    updateStateUI();
}

function onSourceMessageChanged(index) {
    const hint = Number.isInteger(index) ? index : null;
    if (reconcileMemorySources(hint)) {
        persistMemoryDatabaseChange().catch(error => log('Could not save repaired memory:', error));
    }
    updateInjection();
    updateUI();
    scheduleFactBackfill();
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-status',
            callback: () => {
                const store = getChatStore();
                const lines = ['**Summaryception Status**'];
                lines.push(`Memory mode: ${getSettings().separateMemoryByCharacterCard ? 'per character card' : 'per chat'}`);
                if (getSettings().separateMemoryByCharacterCard) {
                    lines.push(`Active card: ${getCharacterMemoryLabel()} (${getCharacterMemoryKey()})`);
                    lines.push(`Memory banks in this chat: ${getAllMemoryStores().length}`);
                }
                const s = getSettings();
                lines.push(`Injection: ${INJECTION_POSITION_LABELS[s.injectionPosition] || 'Prompt'}${s.injectionPosition === 'in_chat' ? ` at depth ${getInjectionDepthValue(s)}` : ''} as ${s.injectionRole || 'system'}`);
                lines.push(`Injected chars: ${(SillyTavern.getContext().extensionPrompts?.[MODULE_NAME]?.value || '').length}`);
                lines.push(`Summarized up to index: ${store.summarizedUpTo}`);
                if (store.layers) {
                    for (let i = 0; i < store.layers.length; i++) {
                        const l = store.layers[i];
                        if (l && l.length > 0) {
                            lines.push(`Layer ${i}: ${l.length} snippets`);
                        }
                    }
                }
                return lines.join('\n');
            },
            helpString: 'Show Summaryception layer status',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                await clearActiveMemory();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-injected',
            callback: () => {
                const registered = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME];
                if (!registered?.value) return '(No Summaryception injection is currently registered)';
                return registered.value;
            },
            helpString: 'Show the Summaryception prompt currently registered with SillyTavern',
        }));


        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-db',
            callback: () => {
                showMemoryDatabaseModal();
                return 'Opened Summaryception memory database viewer.';
            },
            helpString: 'Open the Summaryception memory database viewer',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────

function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
        $('#sc_separate_by_character').prop('checked', s.separateMemoryByCharacterCard);
        $('#sc_verbatim_turns').val(s.verbatimTurns);
        $('#sc_verbatim_turns_val').text(s.verbatimTurns);
        $('#sc_turns_per_summary').val(s.turnsPerSummary);
        $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
        $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
        $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
        $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
        $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
        $('#sc_max_layers').val(s.maxLayers);
        $('#sc_max_layers_val').text(s.maxLayers);
        $('#sc_context_budget').val(s.contextBudget);
        $('#sc_context_budget_unit').val(s.contextBudgetUnit);
        $('#sc_injection_template').val(s.injectionTemplate);
        $('#sc_injection_position').val(s.injectionPosition || defaultSettings.injectionPosition);
        $('#sc_injection_depth').val(getInjectionDepthValue(s));
        $('#sc_injection_depth_val').text(getInjectionDepthValue(s));
        $('#sc_injection_role').val(s.injectionRole || defaultSettings.injectionRole);
        $('#sc_injection_scan').prop('checked', Boolean(s.injectionScan));
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        // ── Prompt preset migration & sync ──
        // Upgrade only exact prior built-ins. Never replace user-authored text.
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();
            const previousNarrativePrompt = PREVIOUS_NARRATIVE_PROMPT.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt || currentPrompt === previousNarrativePrompt) {
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                // User customized their prompt — mark as custom
                s.promptPreset = 'custom';
                saveSettings();
            }
        } else if (s.promptPreset === 'narrative'
            && (s.summarizerUserPrompt || '').trim() === PREVIOUS_NARRATIVE_PROMPT.trim()) {
            // The preset field already existed when this built-in prompt changed.
            s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
            saveSettings();
        }

        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        let ghostedCount = 0;
        try {
            const { chat } = SillyTavern.getContext();
            ghostedCount = chat.filter(m => m.extra?.sc_ghosted).length;
        } catch (e) { /* no chat loaded */ }

        let statsHtml = '';
        if (s.separateMemoryByCharacterCard) {
            statsHtml += `<div class="sc-layer-stat">🃏 Active card memory: <strong>${escapeHtml(getCharacterMemoryLabel())}</strong></div>`;
            statsHtml += `<div class="sc-layer-stat sc-muted">Memory banks in this chat: ${getAllMemoryStores().length}</div>`;
        }
        const injectionPositionLabel = INJECTION_POSITION_LABELS[s.injectionPosition] || INJECTION_POSITION_LABELS.in_prompt;
        const injectionSuffix = s.injectionPosition === 'in_chat'
            ? ` at depth ${getInjectionDepthValue(s)}`
            : '';
        statsHtml += `<div class="sc-layer-stat">📌 Injection: <strong>${escapeHtml(injectionPositionLabel)}</strong>${escapeHtml(injectionSuffix)} as ${escapeHtml(s.injectionRole || 'system')}</div>`;
        statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }
        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');
        updateInjectionInspector(preview);

        updateSnippetBrowser();
        updateStateUI();
        renderCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
}

function updateInjectionInspector(preview = assembleSummaryBlock()) {
    const s = getSettings();
    const registered = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME];
    const registeredValue = registered?.value || '';
    const matches = registeredValue === String(preview || '');
    const positionLabel = INJECTION_POSITION_LABELS[s.injectionPosition] || 'Prompt';
    const html = [
        `<div class="sc-layer-stat">🔎 Registered: <strong>${registeredValue ? 'yes' : 'no'}</strong> · matches preview: <strong>${matches ? 'yes' : 'no'}</strong></div>`,
        `<div class="sc-layer-stat">📌 Position: <strong>${escapeHtml(positionLabel)}</strong>${s.injectionPosition === 'in_chat' ? ` at depth ${getInjectionDepthValue(s)}` : ''} · role: <strong>${escapeHtml(s.injectionRole || 'system')}</strong> · World Info scan: <strong>${s.injectionScan ? 'on' : 'off'}</strong></div>`,
        `<div class="sc-layer-stat">📏 Preview: <strong>${(preview || '').length}</strong> chars / ~${estimateTokens(preview)} tokens · Registered: <strong>${registeredValue.length}</strong> chars / ~${estimateTokens(registeredValue)} tokens</div>`,
        (() => {
            const report = injectionReports.get(getChatStore());
            return report ? `<div class="sc-layer-stat">Budget: ${escapeHtml(report.meterLabel)}${report.measuredTokens != null ? ` · measured injection: ${report.measuredTokens} tokens` : ''}. Omitted from injection: ${report.omittedFacts} facts, ${report.omittedSnippets} snippets (still stored).</div>` : '';
        })(),
        registered && typeof registered === 'object'
            ? `<details><summary>Raw registered extension prompt object</summary><pre>${escapeHtml(JSON.stringify(registered, null, 2))}</pre></details>`
            : '',
    ].join('');
    $('#sc_injection_inspector').html(html);
}

function getMemoryBankLabel(key) {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    if (root?.memoryIdentities?.[key]?.characterName) return root.memoryIdentities[key].characterName;
    if (root?.memoryLabels?.[key]) return root.memoryLabels[key];
    if (root?.memoryAttachments?.[key]?.characterName) return root.memoryAttachments[key].characterName;
    if (key === getCharacterMemoryKey()) return getCharacterMemoryLabel();
    if (key === 'chat') return 'Shared chat memory';
    return key.replace(/^character:/, 'Character ');
}

function getMemoryBankAttachment(key) {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    const currentAttachment = getCurrentChatAttachmentInfo();

    if (key === 'chat') {
        return {
            ...currentAttachment,
            characterName: 'All characters in this chat',
            stableIdentifier: null,
            avatarFilename: null,
            formerKeys: [],
            migrationStatus: 'shared',
        };
    }

    const identity = root?.memoryIdentities?.[key] || {};
    const isActive = key === getCharacterMemoryKey();
    return {
        ...(isActive ? currentAttachment : {}),
        ...(root?.memoryAttachments?.[key] || {}),
        stableIdentifier: identity.stableIdentifier || root?.memoryAttachments?.[key]?.stableIdentifier || null,
        avatarFilename: identity.avatarFilename || normalizeCardFilename(root?.memoryAttachments?.[key]?.characterAvatar),
        formerKeys: Array.isArray(identity.formerKeys) ? identity.formerKeys : [],
        migrationStatus: identity.migrationStatus || 'unmigrated',
        characterName: getMemoryBankLabel(key),
    };
}

function getMemoryDatabaseSnapshot() {
    // Ensure metadata exists and the active bank label/attachment are current before snapshotting.
    getChatStore();

    const s = getSettings();
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    const activeKey = s.separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat';
    const currentChat = getCurrentChatAttachmentInfo();
    const banks = getAllMemoryStores().map(([key, store]) => {
        const layers = (store.layers || []).map((layer, layerIndex) => ({
            layerIndex,
            snippets: (layer || []).map((snippet, snippetIndex) => ({
                snippetIndex,
                ...snippet,
            })),
        }));

        const attachment = getMemoryBankAttachment(key);

        return {
            key,
            label: getMemoryBankLabel(key),
            active: s.separateMemoryByCharacterCard ? key === activeKey : key === 'chat',
            chatId: attachment.chatId,
            chatName: attachment.chatName,
            characterId: attachment.characterId,
            characterName: attachment.characterName,
            characterAvatar: attachment.characterAvatar,
            stableIdentifier: attachment.stableIdentifier,
            avatarFilename: attachment.avatarFilename,
            formerKeys: attachment.formerKeys,
            migrationStatus: attachment.migrationStatus,
            groupId: attachment.groupId,
            groupName: attachment.groupName,
            summarizedUpTo: store.summarizedUpTo ?? -1,
            ghostedIndices: [...(store.ghostedIndices || [])],
            structuredState: structuredClone(store.structuredState),
            sourceSignatures: [...store.sourceSignatures],
            snippetCount: layers.reduce((sum, layer) => sum + layer.snippets.length, 0),
            layers,
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        module: MODULE_NAME,
        memoryMode: s.separateMemoryByCharacterCard ? 'perCharacterCard' : 'perChat',
        currentChat,
        activeKey,
        activeLabel: getMemoryBankLabel(activeKey),
        bankCount: banks.length,
        migrationWarnings: [...(root?.migrationWarnings || [])],
        banks,
    };
}

function buildMemoryDatabaseHtml(snapshot) {
    if (!snapshot.banks.length) {
        return '<div class="sc-muted">No memory banks found.</div>';
    }

    const warningsHtml = snapshot.migrationWarnings?.length
        ? `<div class="sc-db-migration-warning">⚠️ ${snapshot.migrationWarnings.map(escapeHtml).join('<br>')}</div>`
        : '';
    return warningsHtml + snapshot.banks.map((bank) => {
        const layerHtml = bank.layers
            .filter(layer => layer.snippets.length > 0)
            .map(layer => {
                const snippetsHtml = layer.snippets.map(sn => {
                    const rangeStr = sn.turnRange
                        ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                        : sn.mergedCount
                            ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                            : 'meta';
                    const timestamp = sn.timestamp ? new Date(sn.timestamp).toLocaleString() : 'unknown time';
                    const flags = [sn.promoted ? 'promoted' : '', sn.regenerated ? 'regenerated' : '', sn.edited ? 'edited' : '']
                        .filter(Boolean)
                        .join(', ');
                    return `
                    <div class="sc-db-snippet" data-bank-key="${escapeHtml(bank.key)}" data-layer="${layer.layerIndex}" data-idx="${sn.snippetIndex}">
                        <div class="sc-db-snippet-meta">#${sn.snippetIndex + 1} · ${escapeHtml(rangeStr)} · ${escapeHtml(timestamp)}${flags ? ` · ${escapeHtml(flags)}` : ''}</div>
                        <div class="sc-db-snippet-text">${escapeHtml(sn.text || '')}</div>
                        <div class="sc-db-snippet-actions">
                            <button class="menu_button sc-db-snippet-edit-btn" type="button" title="Edit this memory snippet">
                                <i class="fa-solid fa-pen-to-square"></i> Edit Memory
                            </button>
                            <button class="menu_button menu_button_danger sc-db-snippet-delete-btn" type="button" title="Delete this memory snippet">
                                <i class="fa-solid fa-trash"></i> Delete
                            </button>
                        </div>
                    </div>`;
                }).join('');

                return `
                <details class="sc-db-layer" open>
                    <summary>Layer ${layer.layerIndex} · ${layer.snippets.length} snippet${layer.snippets.length === 1 ? '' : 's'}</summary>
                    ${snippetsHtml}
                </details>`;
            }).join('') || '<div class="sc-muted">No snippets in this bank yet.</div>';

        const attachmentRows = [
            ['Character', bank.characterName || 'Unknown character'],
            bank.stableIdentifier ? ['Stable card ID', bank.stableIdentifier] : null,
            bank.avatarFilename ? ['Card/avatar file', bank.avatarFilename] : null,
            ['Migration', bank.migrationStatus],
            bank.formerKeys?.length ? ['Former keys', bank.formerKeys.join(', ')] : null,
            ['Chat', bank.chatName || 'Current chat'],
            bank.chatId !== null && bank.chatId !== undefined ? ['Chat ID/file', bank.chatId] : null,
            bank.characterId !== null && bank.characterId !== undefined ? ['Character ID', bank.characterId] : null,
            bank.groupName ? ['Group', bank.groupName] : null,
            bank.groupId !== null && bank.groupId !== undefined ? ['Group ID', bank.groupId] : null,
            bank.characterAvatar ? ['Avatar', bank.characterAvatar] : null,
        ].filter(Boolean).map(([label, value]) => `
            <div class="sc-db-attachment-row">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(String(value))}</strong>
            </div>`).join('');

        const migrationWarning = bank.migrationStatus === 'ambiguous-preserved'
            ? '<div class="sc-db-migration-warning">⚠️ Ambiguous identity match; this bank was preserved and not merged.</div>'
            : '';
        return `
        <details class="sc-db-bank" ${bank.active ? 'open' : ''} data-bank-key="${escapeHtml(bank.key)}">
            <summary>
                <span>${bank.active ? '🟢 ' : ''}${escapeHtml(bank.label)}</span>
                <span class="sc-db-bank-meta">${bank.snippetCount} snippets · ${bank.ghostedIndices.length} ghosted · up to ${bank.summarizedUpTo}</span>
            </summary>
            <div class="sc-db-bank-key">Memory key: ${escapeHtml(bank.key)}</div>
            ${migrationWarning}
            <div class="sc-db-bank-actions">
                <button class="menu_button sc-db-bank-export-btn" type="button" data-bank-key="${escapeHtml(bank.key)}">
                    <i class="fa-solid fa-file-export"></i> Export Bank
                </button>
                ${bank.active ? '' : `
                <button class="menu_button menu_button_danger sc-db-bank-delete-btn" type="button" data-bank-key="${escapeHtml(bank.key)}">
                    <i class="fa-solid fa-trash"></i> Delete Bank
                </button>`}
            </div>
            <div class="sc-db-attachments">${attachmentRows}</div>
            <details class="sc-db-state"><summary>State snapshot · through ${bank.structuredState.through} · ${effectiveFacts(bank.structuredState).length} facts</summary>
                <pre>${escapeHtml(JSON.stringify(bank.structuredState, null, 2))}</pre>
            </details>
            ${layerHtml}
        </details>`;
    }).join('');
}

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function showMemoryDatabaseModal() {
    document.querySelector('.sc-db-overlay')?.scClose?.();

    const target = captureMemoryTarget();
    let snapshot = getMemoryDatabaseSnapshot();
    const overlay = document.createElement('div');
    overlay.className = 'sc-db-overlay';

    const buildModalShell = () => `
    <div class="sc-db-modal" role="dialog" aria-modal="true" aria-labelledby="sc_db_title">
        <div class="sc-db-header">
            <div>
                <h3 id="sc_db_title">🧠 Summaryception Memory Database</h3>
                <div class="sc-db-subtitle">${escapeHtml(snapshot.currentChat.chatName)} · ${escapeHtml(snapshot.memoryMode)} · ${snapshot.bankCount} bank${snapshot.bankCount === 1 ? '' : 's'} · active: ${escapeHtml(snapshot.activeLabel)}</div>
            </div>
            <button class="menu_button sc-db-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="sc-db-toolbar">
            <input id="sc_db_filter" class="text_pole" type="search" placeholder="Filter banks and snippets..." />
            <button id="sc_db_refresh" class="menu_button"><i class="fa-solid fa-rotate"></i> Refresh</button>
            <button id="sc_db_cleanup_legacy" class="menu_button menu_button_danger"><i class="fa-solid fa-broom"></i> Clean Up Legacy Banks</button>
            <button id="sc_db_copy" class="menu_button"><i class="fa-solid fa-copy"></i> Copy JSON</button>
            <button id="sc_db_export_all" class="menu_button"><i class="fa-solid fa-file-export"></i> Export All</button>
        </div>
        <div class="sc-db-body">
            <div id="sc_db_rendered" class="sc-db-rendered">${buildMemoryDatabaseHtml(snapshot)}</div>
            <details class="sc-db-json-wrap">
                <summary>Raw JSON snapshot</summary>
                <textarea id="sc_db_json" class="text_pole sc-db-json" readonly>${escapeHtml(JSON.stringify(snapshot, null, 2))}</textarea>
            </details>
        </div>
        <div class="sc-db-footer sc-muted">
            Edit Memory changes the selected stored snippet in-place, then refreshes the injected Summaryception context. No external vector database is required for Summaryception's ordered summaries.
        </div>
    </div>`;

    overlay.innerHTML = buildModalShell();

    const applyFilter = () => {
        const filterInput = overlay.querySelector('#sc_db_filter');
        const needle = filterInput?.value.trim().toLowerCase() || '';
        for (const bankEl of overlay.querySelectorAll('.sc-db-bank')) {
            const matches = !needle || bankEl.textContent.toLowerCase().includes(needle);
            bankEl.style.display = matches ? '' : 'none';
            if (matches && needle) bankEl.open = true;
        }
    };

    const refreshDatabaseView = () => {
        const filterInput = overlay.querySelector('#sc_db_filter');
        const filterValue = filterInput?.value || '';
        const openBanks = new Set([...overlay.querySelectorAll('.sc-db-bank[open]')].map(el => el.dataset.bankKey));
        snapshot = getMemoryDatabaseSnapshot();
        overlay.querySelector('.sc-db-subtitle').innerHTML = `${escapeHtml(snapshot.currentChat.chatName)} · ${escapeHtml(snapshot.memoryMode)} · ${snapshot.bankCount} bank${snapshot.bankCount === 1 ? '' : 's'} · active: ${escapeHtml(snapshot.activeLabel)}`;
        overlay.querySelector('#sc_db_rendered').innerHTML = buildMemoryDatabaseHtml(snapshot);
        for (const bankEl of overlay.querySelectorAll('.sc-db-bank')) {
            if (openBanks.has(bankEl.dataset.bankKey)) bankEl.open = true;
        }
        overlay.querySelector('#sc_db_json').value = JSON.stringify(snapshot, null, 2);
        if (filterInput) filterInput.value = filterValue;
        applyFilter();
    };

    const close = () => {
        document.removeEventListener('keydown', keyHandler);
        overlay.remove();
    };
    overlay.scClose = close;
    const keyHandler = (event) => {
        if (event.key === 'Escape') close();
    };
    overlay.querySelector('.sc-db-close').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });

    document.addEventListener('keydown', keyHandler);

    overlay.querySelector('#sc_db_filter').addEventListener('input', applyFilter);

    overlay.querySelector('#sc_db_rendered').addEventListener('click', async (event) => {
        if (!targetIsCurrent(target)) { close(); return; }
        const cancelButton = event.target.closest('.sc-db-snippet-cancel-btn');
        if (cancelButton) {
            refreshDatabaseView();
            return;
        }

        const saveButton = event.target.closest('.sc-db-snippet-save-btn');
        if (saveButton) {
            const snippetEl = saveButton.closest('.sc-db-snippet');
            const bankKey = snippetEl?.dataset.bankKey;
            const layerIndex = Number.parseInt(snippetEl?.dataset.layer, 10);
            const snippetIndex = Number.parseInt(snippetEl?.dataset.idx, 10);
            const textarea = snippetEl?.querySelector('.sc-db-snippet-edit-area');
            const newText = textarea?.value.trim();

            if (!bankKey || Number.isNaN(layerIndex) || Number.isNaN(snippetIndex) || !textarea) return;
            if (!newText) {
                toastr.warning('Memory text cannot be empty.', 'Summaryception', { timeOut: 2000 });
                textarea.focus();
                return;
            }

            const { snippet } = getMemorySnippetByPath(bankKey, layerIndex, snippetIndex);
            if (!snippet) {
                toastr.error('Could not find that memory snippet. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }

            snippet.text = newText;
            snippet.edited = true;
            snippet.editedAt = new Date().toISOString();
            invalidateContextCache(getMemoryStoreByKey(bankKey));
            await persistMemoryDatabaseChange();
            refreshDatabaseView();
            toastr.success(`Memory updated in Layer ${layerIndex}.`, 'Summaryception', { timeOut: 2000 });
            return;
        }

        const deleteButton = event.target.closest('.sc-db-snippet-delete-btn');
        if (deleteButton) {
            const snippetEl = deleteButton.closest('.sc-db-snippet');
            const bankKey = snippetEl?.dataset.bankKey;
            const layerIndex = Number.parseInt(snippetEl?.dataset.layer, 10);
            const snippetIndex = Number.parseInt(snippetEl?.dataset.idx, 10);

            if (!bankKey || Number.isNaN(layerIndex) || Number.isNaN(snippetIndex)) return;
            if (!confirm(`Delete memory snippet #${snippetIndex + 1} from Layer ${layerIndex}? This cannot be undone.`)) return;

            const { store, layer, snippet } = getMemorySnippetByPath(bankKey, layerIndex, snippetIndex);
            if (!store || !Array.isArray(layer) || !snippet) {
                toastr.error('Could not find that memory snippet. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }

            abortSummarization();
            truncateMemoryStore(store, snippet.turnRange?.[0] ?? 0);
            restoreUncoveredGhosts();
            await persistMemoryDatabaseChange();
            refreshDatabaseView();
            toastr.success(`Memory deleted from Layer ${layerIndex}.`, 'Summaryception', { timeOut: 2000 });
            return;
        }

        const bankExportButton = event.target.closest('.sc-db-bank-export-btn');
        if (bankExportButton) {
            const bankKey = bankExportButton.dataset.bankKey;
            snapshot = getMemoryDatabaseSnapshot();
            const bank = snapshot.banks.find(item => item.key === bankKey);
            if (!bank) {
                toastr.error('Could not find that memory bank. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }
            downloadJson(`summaryception_memory_bank_${bankKey.replace(/[^a-z0-9_-]+/gi, '_')}_${Date.now()}.json`, { format: 'summaryception-memory-bank-v3', key: bankKey, label: bank.label, store: getMemoryStoreByKey(bankKey) });
            toastr.success('Memory bank exported.', 'Summaryception', { timeOut: 2000 });
            return;
        }

        const bankDeleteButton = event.target.closest('.sc-db-bank-delete-btn');
        if (bankDeleteButton) {
            const bankKey = bankDeleteButton.dataset.bankKey;
            if (!bankKey || bankKey === getCharacterMemoryKey() || bankKey === 'chat') {
                toastr.warning('The active memory bank cannot be deleted. Use Clear Memory instead.', 'Summaryception');
                return;
            }
            if (!confirm(`Permanently delete memory bank "${bankKey}" and all of its snippets? Export it first if you may need it later.`)) return;
            if (!deleteMemoryBank(bankKey)) {
                toastr.error('Could not find that memory bank. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }
            await persistMemoryDatabaseChange();
            refreshDatabaseView();
            toastr.success('Memory bank deleted.', 'Summaryception', { timeOut: 2000 });
            return;
        }

        const editButton = event.target.closest('.sc-db-snippet-edit-btn');
        if (!editButton) return;

        const snippetEl = editButton.closest('.sc-db-snippet');
        const textEl = snippetEl?.querySelector('.sc-db-snippet-text');
        if (!snippetEl || !textEl || snippetEl.classList.contains('sc-db-snippet-editing')) return;

        const originalText = textEl.textContent || '';
        snippetEl.classList.add('sc-db-snippet-editing');
        textEl.innerHTML = `
            <textarea class="text_pole sc-db-snippet-edit-area" rows="5">${escapeHtml(originalText)}</textarea>
            <div class="sc-db-snippet-edit-actions">
                <button class="menu_button sc-db-snippet-save-btn" type="button"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                <button class="menu_button sc-db-snippet-cancel-btn" type="button"><i class="fa-solid fa-ban"></i> Cancel</button>
            </div>`;
        editButton.style.display = 'none';
        textEl.querySelector('.sc-db-snippet-edit-area')?.focus();
    });

    overlay.querySelector('#sc_db_refresh').addEventListener('click', () => {
        refreshDatabaseView();
        toastr.info('Memory database refreshed.', 'Summaryception', { timeOut: 1500 });
    });

    overlay.querySelector('#sc_db_cleanup_legacy').addEventListener('click', async () => {
        snapshot = getMemoryDatabaseSnapshot();
        const legacyBanks = snapshot.banks.filter(bank => !bank.active && /^character:\d+$/.test(bank.key));
        if (!legacyBanks.length) {
            toastr.info('No inactive legacy numeric memory banks were found.', 'Summaryception', { timeOut: 2000 });
            return;
        }
        const bankList = legacyBanks.map(bank => bank.key).join(', ');
        if (!confirm(`Permanently delete ${legacyBanks.length} inactive legacy memory bank${legacyBanks.length === 1 ? '' : 's'} (${bankList})? Export All first if you may need them later.`)) return;

        const deletedCount = legacyBanks.reduce((count, bank) => count + Number(deleteMemoryBank(bank.key)), 0);
        await persistMemoryDatabaseChange();
        refreshDatabaseView();
        toastr.success(`Deleted ${deletedCount} legacy memory bank${deletedCount === 1 ? '' : 's'}.`, 'Summaryception', { timeOut: 3000 });
    });

    overlay.querySelector('#sc_db_copy').addEventListener('click', async () => {
        try {
            snapshot = getMemoryDatabaseSnapshot();
            const json = JSON.stringify(snapshot, null, 2);
            overlay.querySelector('#sc_db_json').value = json;
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(json);
            } else {
                const textarea = overlay.querySelector('#sc_db_json');
                textarea.focus();
                textarea.select();
                document.execCommand('copy');
            }
            toastr.success('Memory database JSON copied.', 'Summaryception', { timeOut: 2000 });
        } catch (e) {
            console.error(LOG_PREFIX, 'Could not copy memory database JSON:', e);
            toastr.error('Could not copy memory database JSON. Check console for details.', 'Summaryception');
        }
    });

    overlay.querySelector('#sc_db_export_all').addEventListener('click', () => {
        snapshot = getMemoryDatabaseSnapshot();
        overlay.querySelector('#sc_db_json').value = JSON.stringify(snapshot, null, 2);
        downloadJson(`summaryception_memory_database_${Date.now()}.json`, snapshot);
        toastr.success('Memory database exported.', 'Summaryception', { timeOut: 2000 });
    });

    document.body.appendChild(overlay);
    overlay.querySelector('#sc_db_filter').focus();
}

function updateSnippetBrowser() {
    const store = getChatStore();
    let html = '';

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const rangeStr = sn.turnRange
                    ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                    : sn.mergedCount
                        ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                        : '';
                const seedStr = sn.promoted ? ' 🌱' : '';
                const canRedo = (i === 0 && sn.turnRange);
                const redoBtn = canRedo
                    ? `<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right" title="Regenerate this snippet"></button>`
                    : '';

                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                <span class="sc-snippet-text" data-layer="${i}" data-idx="${j}" title="Click to edit">${escapeHtml(sn.text)}</span>
                <span class="sc-snippet-meta">${rangeStr}${seedStr}</span>
                ${redoBtn}
                <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    // Edit snippet on click
    $('.sc-snippet-text').off('click').on('click', function () {
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];
        const textEl = $(this);

        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.text)
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const newText = $(this).val().trim();
                    if (newText) {
                        sn.text = newText;
                        invalidateContextCache(store);
                        await saveChatStore();
                        updateInjection();
                        toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                    }
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                const newText = $(this).val().trim();
                if (newText && newText !== sn.text) {
                    sn.text = newText;
                    invalidateContextCache(store);
                    await saveChatStore();
                    updateInjection();
                    toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                }
                updateSnippetBrowser();
            });

        textEl.replaceWith(textarea);

        // Auto-size to fit content
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';

        textarea.focus().select();
    });

    // Redo snippet
    $('.sc-snippet-redo').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const store = getChatStore();
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];

        if (!sn.turnRange) {
            toastr.warning(
                'Only Layer 0 (turn summary) snippets can be regenerated. Promoted meta-summaries have no source turns.',
                'Summaryception',
                { timeOut: 5000 }
            );
            return;
        }

        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.', 'Summaryception');
            return;
        }

        const [rangeStart, rangeEnd] = sn.turnRange;
        const { chat } = SillyTavern.getContext();

        if (!confirm(`Regenerate summary for turns ${rangeStart}–${rangeEnd}?`)) return;

        const run = beginSummarization();
        if (!run) return;
        const transaction = captureTransaction(run.target, rangeEnd);
        const btn = $(this);
        btn.prop('disabled', true).removeClass('fa-rotate-right').addClass('fa-spinner fa-spin');

        try {
            const storyTxt = buildPassageFromRange(chat, rangeStart, rangeEnd);

            if (!storyTxt.trim()) {
                toastr.error('Source turns are empty — cannot regenerate.', 'Summaryception');
                return;
            }

            const contextParts = [];
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const l = store.layers[i];
                if (!l) continue;
                for (let j = 0; j < l.length; j++) {
                    if (l[j].turnRange && l[j].turnRange[1] >= rangeStart) continue;
                    if (!l[j].turnRange) continue;
                    contextParts.push(l[j].text);
                }
            }
            const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';

            toastr.info(`Regenerating summary for turns ${rangeStart}–${rangeEnd}…`, 'Summaryception', {
                timeOut: 3000,
                progressBar: true,
            });

            const newSummary = await callSummarizer(storyTxt, contextStr);

            if (!newSummary || !runIsCurrent(run) || !transactionIsCurrent(transaction)) {
                toastr.error('Regeneration failed — original snippet kept.', 'Summaryception');
                return;
            }

            sn.text = newSummary;
            sn.timestamp = Date.now();
            sn.regenerated = true;
            invalidateContextCache(store);

            await saveChatStore();
            updateInjection();
            updateUI();

            toastr.success(`Snippet regenerated for turns ${rangeStart}–${rangeEnd}`, 'Summaryception', { timeOut: 3000 });

        } finally {
            finishSummarization(run);
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
        }
    });

    // Delete snippet
    $('.sc-snippet-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer) {
            abortSummarization();
            truncateMemoryStore(store, layer[snippetIdx]?.turnRange?.[0] ?? 0);
            restoreUncoveredGhosts();

            await saveChatStore();
            updateInjection();
            updateUI();
            toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
        }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function clearActiveMemory() {
    abortSummarization();
    const target = captureMemoryTarget();
    const store = target.store;
    store.layers = [];
    store.summarizedUpTo = -1;
    store.structuredState = emptyState();
    store.sourceSignatures = [];
    delete store.lastBatch;
    delete store.lastFactBatch;
    invalidateContextCache(store);
    await unghostAllMessages(store);
    if (!targetIsCurrent(target)) return;
    await persistMemoryDatabaseChange();
}

function validateMemoryImport(data) {
    const original = data?.store || data;
    if (!original || !Array.isArray(original.layers)) throw new Error('Expected a memory bank with layers.');
    const store = structuredClone(original);
    // The database viewer's historical export format used {snippets} layer rows.
    store.layers = store.layers.map(layer => Array.isArray(layer) ? layer : layer?.snippets);
    if (store.layers.some(layer => !Array.isArray(layer))) throw new Error('Invalid memory layers.');
    for (const snippet of store.layers.flat()) {
        if (typeof snippet === 'string') continue;
        if (!snippet || typeof snippet.text !== 'string') throw new Error('Invalid snippet text.');
        if (snippet.turnRange && !(Array.isArray(snippet.turnRange) && snippet.turnRange.length === 2
            && snippet.turnRange.every(Number.isInteger) && snippet.turnRange[0] >= 0
            && snippet.turnRange[1] >= snippet.turnRange[0])) throw new Error('Invalid snippet source range.');
    }
    if (store.summarizedUpTo != null && (!Number.isInteger(store.summarizedUpTo) || store.summarizedUpTo < -1)) {
        throw new Error('Invalid summarized cutoff.');
    }
    store.structuredState = validateStoredState(store.structuredState);
    const anchor = Math.max(store.structuredState.through, ...store.structuredState.overrides.map(item => item.anchor));
    if (anchor >= 0 && (!Array.isArray(store.sourceSignatures) || store.sourceSignatures.length <= anchor
        || Array.from({ length: anchor + 1 }, (_, i) => store.sourceSignatures[i]).some(value => typeof value !== 'string' || !value))) {
        throw new Error('Structured state is missing its original-message signatures.');
    }
    if (store.structuredState.through > (store.summarizedUpTo ?? -1)) throw new Error('State extends beyond narrative cutoff.');
    return normalizeChatStore(store);
}

async function confirmAndCleanupLegacyMemoryBanks() {
    const banks = getMemoryDatabaseSnapshot().banks.filter(bank => !bank.active && /^character:\d+$/.test(bank.key));
    if (!banks.length) { toastr.info('No inactive legacy numeric memory banks found.', 'Summaryception'); return false; }
    if (!confirm(`Delete ${banks.length} inactive legacy bank(s): ${banks.map(bank => bank.key).join(', ')}? Export first if needed.`)) return false;
    abortSummarization();
    for (const bank of banks) deleteMemoryBank(bank.key);
    await persistMemoryDatabaseChange();
    toastr.success(`Deleted ${banks.length} legacy bank(s).`, 'Summaryception');
    return true;
}

function renderCustomPromptSlots() {
    const s = getSettings();
    const select = document.getElementById('sc_custom_prompt_slot');
    if (!select) return;
    const selected = select.value;
    select.replaceChildren(new Option('-- Load a saved prompt --', ''));
    for (const prompt of s.savedCustomPrompts) select.add(new Option(prompt.name, prompt.id));
    select.value = selected;
    $('#sc_custom_prompt_manager').toggle(s.promptPreset === 'custom');
}

function bindCustomPromptUI() {
    const apply = text => {
        const s = getSettings();
        s.summarizerUserPrompt = text;
        s.promptPreset = 'custom';
        saveSettings();
        updateUI();
    };
    $('#sc_custom_prompt_save').on('click', () => {
        const name = String($('#sc_custom_prompt_name').val() || '').trim();
        if (!name) { toastr.warning('Enter a prompt name.', 'Summaryception'); return; }
        const s = getSettings();
        const existing = s.savedCustomPrompts.find(prompt => prompt.name === name);
        if (existing && !confirm(`Replace saved prompt "${name}"?`)) return;
        if (existing) existing.text = s.summarizerUserPrompt;
        else s.savedCustomPrompts.push({ id: crypto.randomUUID(), name, text: s.summarizerUserPrompt });
        saveSettings();
        renderCustomPromptSlots();
        toastr.success('Custom prompt saved.', 'Summaryception');
    });
    $('#sc_custom_prompt_load').on('click', () => {
        const prompt = getSettings().savedCustomPrompts.find(item => item.id === $('#sc_custom_prompt_slot').val());
        if (!prompt) { toastr.warning('Select a saved prompt.', 'Summaryception'); return; }
        apply(prompt.text);
    });
    $('#sc_custom_prompt_delete_slot').on('click', () => {
        const s = getSettings();
        const id = $('#sc_custom_prompt_slot').val();
        const prompt = s.savedCustomPrompts.find(item => item.id === id);
        if (!prompt || !confirm(`Delete saved prompt "${prompt.name}"?`)) return;
        s.savedCustomPrompts = s.savedCustomPrompts.filter(item => item.id !== id);
        saveSettings(); renderCustomPromptSlots();
    });
    $('#sc_custom_prompt_export').on('click', () => {
        const blob = new Blob([getSettings().summarizerUserPrompt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = 'summaryception_prompt.txt'; link.click(); URL.revokeObjectURL(url);
    });
    $('#sc_custom_prompt_import').on('click', () => {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.txt';
        input.onchange = async event => {
            try {
                const file = event.target.files[0];
                if (!file) return;
                const text = await file.text();
                if (!text.trim()) throw new Error('The prompt file is empty.');
                apply(text);
            } catch (error) { toastr.error(error.message, 'Summaryception'); }
        };
        input.click();
    });
}

function updateStateUI() {
    const s = getSettings();
    const store = getChatStore();
    const state = store.structuredState;
    $('#sc_state_enabled').prop('checked', s.structuredStateEnabled);
    $('#sc_state_allowance').val(s.stateTokenAllowance);
    $('#sc_state_details').toggle(s.structuredStateEnabled);
    const report = injectionReports.get(store);
    const progress = activeRun?.target.store === store ? activeRun.factProgress : null;
    $('#sc_state_status').text(`${progress ? `Extracting missing facts: message ${progress.through} / ${progress.cutoff}. ` : needsFactBackfill(store) ? 'Missing fact coverage; automatic catch-up is pending or paused. ' : ''}Snapshot through message ${state.through}; coverage begins at ${state.from}. ${effectiveFacts(state).length} facts; ${state.overrides.length} manual locks. ${report?.omittedFacts || 0} facts and ${report?.omittedSnippets || 0} snippets omitted from injection (still stored). Budget: ${report?.meterLabel || 'not measured'}.${store.lastFactBatch ? ` Last fact catch-up batch: ${store.lastFactBatch.milliseconds} ms.` : ''}${store.lastBatch ? ` Last summary batch: ${store.lastBatch.milliseconds} ms.` : ''}`);
    $('#sc_state_json').val(JSON.stringify(state, null, 2));
    const select = document.getElementById('sc_state_fact');
    if (!select) return;
    const selected = select.value;
    select.replaceChildren(new Option('-- Select or add a fact --', ''));
    const facts = new Map(effectiveFacts(state).map(fact => [fact.id, fact]));
    for (const item of state.overrides) if (!item.fact) facts.set(item.id, { id: item.id, value: '[removed, locked]' });
    for (const fact of facts.values()) select.add(new Option(`${fact.id}: ${fact.value}`, fact.id));
    select.value = selected;
}

function bindStateUI() {
    $('#sc_state_enabled').on('change', async function () {
        abortSummarization();
        const s = getSettings();
        s.structuredStateEnabled = $(this).prop('checked');
        const store = getChatStore();
        invalidateContextCache(store);
        saveSettings();
        await persistMemoryDatabaseChange();
        scheduleFactBackfill(true);
    });
    $('#sc_state_allowance').on('change', function () {
        getSettings().stateTokenAllowance = Math.min(800, Math.max(400, Number($(this).val()) || 600));
        saveSettings(); updateInjection(); updateUI();
    });
    $('#sc_state_fact').on('change', function () {
        const id = $(this).val();
        const state = getChatStore().structuredState;
        const fact = effectiveFacts(state).find(item => item.id === id);
        $('#sc_state_id').val(id);
        $('#sc_state_category').val(fact?.category || 'fact');
        $('#sc_state_value').val(fact?.value || '');
    });
    const correct = async action => {
        try {
            const { chat } = SillyTavern.getContext();
            if (!chat.length) throw new Error('Open a chat before correcting state.');
            abortSummarization();
            const store = getChatStore();
            store.structuredState = correctState(store.structuredState, {
                id: String($('#sc_state_id').val() || '').trim(),
                category: $('#sc_state_category').val(), value: $('#sc_state_value').val(),
                remove: action === 'remove', unlock: action === 'unlock',
            }, chat.length - 1);
            store.sourceSignatures = chat.map(messageSignature);
            invalidateContextCache(store);
            await persistMemoryDatabaseChange();
        } catch (error) { toastr.error(error.message, 'Summaryception'); }
    };
    $('#sc_state_pin').on('click', () => correct('pin'));
    $('#sc_state_remove').on('click', () => correct('remove'));
    $('#sc_state_unlock').on('click', () => correct('unlock'));
    $('#sc_state_extract').on('click', async () => {
        if (isSummarizing) { toastr.warning('A memory run is already active. Use Stop to pause it first.', 'Summaryception'); return; }
        if (!getSettings().enabled || getSettings().pauseSummarization) {
            toastr.warning('Enable Summaryception and unpause processing to extract missing facts.', 'Summaryception'); return;
        }
        await extractMissingFacts();
    });
    $('#sc_state_rebuild').on('click', async () => {
        if (!getSettings().structuredStateEnabled) return;
        if (isSummarizing) { toastr.warning('Stop the current run before rebuilding.', 'Summaryception'); return; }
        if (!confirm('Rebuild the active bank from original chat messages? This clears its summaries, state, and manual pins. Export first if needed. The verbatim window is preserved.')) return;
        const target = captureMemoryTarget();
        await clearActiveMemory();
        if (!targetIsCurrent(target)) return;
        const turns = unsummarizedTurns(target.chat, target.store);
        if (turns.length > getSettings().verbatimTurns) await runCatchup(turns, turns.length - getSettings().verbatimTurns);
    });
}


function bindUIEvents() {
    $('#sc_enabled').on('change', async function () {
        abortSummarization();
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        if (getSettings().enabled) await activateCharacterMemoryStore();
        else await unghostAllMessages();
        await persistMemoryDatabaseChange();
    });

    $('#sc_pause_summarization').on('change', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            abortSummarization();
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: 5000 }
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: 3000 }
            );
            scheduleFactBackfill(true);
        }
    });

    $('#sc_disable_ghosting').on('change', async function () {
        abortSummarization();
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();
        await unghostAllMessages();
        await activateCharacterMemoryStore();
        await persistMemoryDatabaseChange();
    });

    $('#sc_separate_by_character').on('change', async function () {
        abortSummarization();
        const previousStore = getChatStore();
        await unghostAllMessages(previousStore);
        const s = getSettings();
        s.separateMemoryByCharacterCard = $(this).prop('checked');
        saveSettings();
        await activateCharacterMemoryStore();
        updateInjection();
        updateUI();
        toastr.info(
            s.separateMemoryByCharacterCard
                ? 'Character-card memory separation enabled for this chat. The active card now has its own memory bank.'
                : 'Character-card memory separation disabled. This chat will use one shared memory bank.',
            'Summaryception',
            { timeOut: 5000 }
        );
    });

    $('#sc_summarizer_response_length').on('input', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    bindStateUI();
    bindCustomPromptUI();

    $('#sc_reset_defaults').on('click', async () => {
        if (!confirm('Reset Summaryception settings? This preserves chat memory and saved profiles/prompts, but resets active connection settings.')) return;
        abortSummarization();
        const s = getSettings();
        const saved = { savedConnectionProfiles: s.savedConnectionProfiles, savedCustomPrompts: s.savedCustomPrompts };
        await unghostAllMessages();
        Object.assign(s, structuredClone(defaultSettings), saved);
        saveSettings();
        await activateCharacterMemoryStore();
        syncConnectionUIFromSettings();
        await persistMemoryDatabaseChange();
    });

    $('#sc_context_budget').on('change', function () {
        getSettings().contextBudget = Math.max(1, parseInt($(this).val(), 10) || defaultSettings.contextBudget);
        saveSettings();
        updateInjection();
    });

    $('#sc_context_budget_unit').on('change', function () {
        getSettings().contextBudgetUnit = $(this).val() === 'characters' ? 'characters' : 'tokens';
        saveSettings();
        updateInjection();
    });

    $('#sc_strip_patterns').on('change', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });

    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        { id: '#sc_turns_per_summary', key: 'turnsPerSummary', display: '#sc_turns_per_summary_val' },
        { id: '#sc_snippets_per_layer', key: 'snippetsPerLayer', display: '#sc_snippets_per_layer_val' },
        { id: '#sc_snippets_per_promotion', key: 'snippetsPerPromotion', display: '#sc_snippets_per_promotion_val' },
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
    ];

    for (const sl of sliders) {
        $(sl.id).on('input', function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val;
            $(sl.display).text(val);
            saveSettings();
            updateInjection();
        });
    }

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(ta.id).on('change', function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
            if (ta.key === 'injectionTemplate') updateInjection();
        });
    }

    $('#sc_injection_position').on('change', function () {
        getSettings().injectionPosition = $(this).val();
        saveSettings();
        updateInjection();
        updateUI();
    });

    $('#sc_injection_depth').on('input', function () {
        const val = parseInt($(this).val(), 10);
        getSettings().injectionDepth = Number.isFinite(val) ? val : defaultSettings.injectionDepth;
        $('#sc_injection_depth_val').text(getSettings().injectionDepth);
        saveSettings();
        updateInjection();
    });

    $('#sc_injection_role').on('change', function () {
        getSettings().injectionRole = $(this).val();
        saveSettings();
        updateInjection();
        updateUI();
    });

    $('#sc_injection_scan').on('change', function () {
        getSettings().injectionScan = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $('#sc_test_injection').on('click', function () {
        const hadSummary = updateInjection();
        const ctx = SillyTavern.getContext();
        const registered = ctx.extensionPrompts?.[MODULE_NAME];
        if (!hadSummary || !registered?.value) {
            toastr.warning('No Summaryception summary is currently available to inject. Create or import a summary first.', 'Summaryception', { timeOut: 5000 });
            return;
        }
        const positionLabel = INJECTION_POSITION_LABELS[getSettings().injectionPosition] || 'Prompt';
        toastr.success(
            `Injection registered (${registered.value.length} chars, ${positionLabel}, role ${getSettings().injectionRole}). Check Prompt Inspector on the next generation to verify placement.`,
            'Summaryception',
            { timeOut: 7000 }
        );
    });

    $('#sc_debug_mode').on('change', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_trace_mode').on('change', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_repair').on('click', async function () {
        abortSummarization();
        await repairIfBranched();
        const { chat } = SillyTavern.getContext();
        const store = getChatStore();
        const covered = new Set(store.ghostedIndices);
        const target = captureMemoryTarget();
        for (let i = 0; i < chat.length && targetIsCurrent(target); i++) {
            if (chat[i]?.extra?.sc_ghosted && (!covered.has(i) || i > store.summarizedUpTo)) {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, { showOutput: false });
                delete chat[i].extra.sc_ghosted;
            }
        }
        if (!targetIsCurrent(target)) return;
        await ghostMessagesUpTo(store.summarizedUpTo, getSummarizedRangeStart(store));
        await persistMemoryDatabaseChange();
        toastr.success('Summaryception-owned visibility repaired. Manually hidden messages preserved.', 'Summaryception');
    });

    $('#sc_view_database').on('click', function () {
        showMemoryDatabaseModal();
    });

    $('#sc_cleanup_legacy_banks').on('click', async function () {
        await confirmAndCleanupLegacyMemoryBanks();
    });

    $('#sc_clear_memory').on('click', async function () {
        if (!confirm('Clear Summaryception memory for the active memory bank and unghost its messages?')) return;
        await clearActiveMemory();
        toastr.success('Active Summaryception memory cleared and messages unghosted.', 'Summaryception');
    });

    $('#sc_force_summarize').on('click', async function () {
        const s = getSettings();
        if (!s.enabled) { toastr.warning('Enable Summaryception first.'); return; }
        if (isSummarizing) { toastr.warning('Already summarizing. Please wait.'); return; }
        await repairIfBranched();
        const target = captureMemoryTarget();
        if (target.store.summarizedUpTo < 0) await unghostAllMessages();
        if (!targetIsCurrent(target)) return;
        const turns = unsummarizedTurns(target.chat, target.store);
        $(this).prop('disabled', true).text(' Working…');
        try {
            catchupDismissed = true;
            if (turns.length > s.verbatimTurns) await runCatchup(turns, turns.length - s.verbatimTurns);
            else if (turns.length) await summarizeOneBatch(turns); // Explicit force may use the verbatim window.
            else toastr.info('Nothing to summarize.', 'Summaryception');
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateInjection();
            updateUI();
        }
    });

    $('#sc_stop_summarize').on('click', function () {
        if (!isSummarizing && !currentAbortController) {
            toastr.info('Nothing is running.', 'Summaryception');
            return;
        }
        abortSummarization();
        toastr.warning('Summarization stopped. Progress has been saved.', 'Summaryception', { timeOut: 4000 });
        $(this).prop('disabled', true);
        setTimeout(() => $(this).prop('disabled', false), 2000);
        updateUI();
    });

    $('#sc_refresh_preview').on('click', () => updateUI());
    $('#sc_copy_injected').on('click', async () => {
        const value = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME]?.value || '';
        if (!value) {
            toastr.warning('No Summaryception injection is currently registered.', 'Summaryception');
            return;
        }
        await navigator.clipboard.writeText(value);
        toastr.success('Registered Summaryception injection copied.', 'Summaryception');
    });

    $('#sc_export').on('click', function () {
        const store = getChatStore();
        const key = getSettings().separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat';
        const exportedBank = {
            format: 'summaryception-memory-bank-v3',
            key,
            label: getMemoryBankLabel(key),
            attachment: getMemoryBankAttachment(key),
            store,
        };
        const blob = new Blob([JSON.stringify(exportedBank, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $('#sc_import').on('click', function () {
        const target = captureMemoryTarget();
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = async event => {
            const file = event.target.files[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                if (!targetIsCurrent(target)) throw new Error('Chat/card changed while selecting an import.');
                const imported = validateMemoryImport(data);
                abortSummarization();
                invalidateContextCache(target.store);
                await unghostAllMessages();
                if (!targetIsCurrent(target)) return;
                Object.assign(target.store, imported, { ghostedIndices: [] });
                invalidateContextCache(target.store);
                reconcileMemorySources();
                if (getSettings().enabled) await ghostMessagesUpTo(target.store.summarizedUpTo, getSummarizedRangeStart(target.store));
                if (!targetIsCurrent(target)) return;
                await persistMemoryDatabaseChange();
                toastr.success('Memory imported into the active bank.', 'Summaryception');
            } catch (error) { toastr.error(`Import failed: ${error.message}`, 'Summaryception'); }
        };
        input.click();
    });

    // ── Prompt Preset dropdown ──
    $('#sc_prompt_preset').on('change', function () {
        const selected = $(this).val();
        const s = getSettings();
        s.promptPreset = selected;

        if (selected !== 'custom') {
            // Overwrite textarea with the selected preset
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
        }
        // 'custom' leaves the textarea untouched for user editing

        saveSettings();
        renderCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $('#sc_summarizer_user_prompt').on('input', function () {
        const currentText = $(this).val();
        const s = getSettings();

        // Always sync the prompt text
        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                s.promptPreset = 'custom';
                $('#sc_prompt_preset').val('custom');
                renderCustomPromptSlots();
            }
        }

        saveSettings();
    });
}

// ─── Connection Settings UI ──────────────────────────────────────────

function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();
    renderSavedConnectionProfiles();

    bindSimpleConnectionInput('summaryception_temperature', 'summarizerTemperature', v => Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : defaultSettings.summarizerTemperature);
    bindSimpleConnectionInput('summaryception_timeout_ms', 'summarizerTimeoutMs', v => Number.parseInt(v, 10) || defaultSettings.summarizerTimeoutMs);
    bindSimpleConnectionInput('summaryception_stop_sequences', 'summarizerStopSequences', v => v.split('\n').map(x => x.trim()).filter(Boolean), v => (v || []).join('\n'));

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            s().activeSavedConnectionProfileId = '';
            save();
            updateConnectionSubPanels(sourceSelect.value);
            renderSavedConnectionProfiles();
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, s().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, s().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            s().connectionProfileId = profileSelect.value;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = s().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    bindSimpleConnectionInput('summaryception_completion_url', 'completionUrl');
    bindSimpleConnectionInput('summaryception_completion_key', 'completionKey');
    bindSimpleConnectionInput('summaryception_completion_model', 'completionModel');
    bindSimpleConnectionInput('summaryception_completion_prefix', 'completionPrefix', v => v.replace(/\\n/g, '\n'), v => (v || '').replace(/\n/g, '\\n'));
    bindSimpleConnectionInput('summaryception_completion_suffix', 'completionSuffix', v => v.replace(/\\n/g, '\n'), v => (v || '').replace(/\n/g, '\\n'));
    bindSimpleConnectionInput('summaryception_custom_url', 'customUrl');
    bindSimpleConnectionInput('summaryception_custom_headers', 'customHeaders');
    bindSimpleConnectionInput('summaryception_custom_body', 'customBodyTemplate');
    bindSimpleConnectionInput('summaryception_custom_response_path', 'customResponsePath');
    bindSimpleConnectionInput('summaryception_custom_api_key', 'customApiKey');
    bindSimpleConnectionInput('summaryception_custom_model', 'customModel');

    document.getElementById('summaryception_test_current')?.addEventListener('click', testCurrentConnectionHandler);
    document.getElementById('summaryception_profile_save')?.addEventListener('click', saveCurrentConnectionProfile);
    document.getElementById('summaryception_profile_update')?.addEventListener('click', updateSelectedConnectionProfile);
    document.getElementById('summaryception_profile_duplicate')?.addEventListener('click', duplicateSelectedConnectionProfile);
    document.getElementById('summaryception_profile_delete')?.addEventListener('click', deleteSelectedConnectionProfile);
    document.getElementById('summaryception_saved_profile')?.addEventListener('change', loadSelectedConnectionProfile);

    // ── KoboldCPP URL ──
    const kcppUrl = document.getElementById('summaryception_kcpp_url');
    if (kcppUrl) {
        kcppUrl.value = s().koboldcppUrl || 'http://localhost:5001';
        kcppUrl.addEventListener('input', () => {
            s().koboldcppUrl = kcppUrl.value.trim().replace(/\/+$/, '');
            save();
        });
    }

    // ── KoboldCPP Prefix ──
    const kcppPrefix = document.getElementById('summaryception_kcpp_prefix');
    if (kcppPrefix) {
        kcppPrefix.value = (s().koboldcppPrefix || '<|im_start|>user\n').replace(/\n/g, '\\n');
        kcppPrefix.addEventListener('input', () => {
            s().koboldcppPrefix = kcppPrefix.value.replace(/\\n/g, '\n');
            save();
        });
    }

    // ── KoboldCPP Suffix ──
    const kcppSuffix = document.getElementById('summaryception_kcpp_suffix');
    if (kcppSuffix) {
        kcppSuffix.value = (s().koboldcppSuffix || '<|im_end|>\n<|im_start|>assistant\n').replace(/\n/g, '\\n');
        kcppSuffix.addEventListener('input', () => {
            s().koboldcppSuffix = kcppSuffix.value.replace(/\\n/g, '\n');
            save();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

const CONNECTION_PROFILE_FIELDS = [
    'connectionSource', 'summarizerResponseLength', 'summarizerTemperature', 'summarizerTimeoutMs', 'summarizerStopSequences',
    'connectionProfileId', 'ollamaUrl', 'ollamaModel', 'openaiUrl', 'openaiKey', 'openaiModel', 'openaiMaxTokens',
    'koboldcppUrl', 'koboldcppPrefix', 'koboldcppSuffix', 'completionUrl', 'completionKey', 'completionModel',
    'completionPrefix', 'completionSuffix', 'customUrl', 'customHeaders', 'customBodyTemplate', 'customResponsePath',
    'customApiKey', 'customModel',
];

function bindSimpleConnectionInput(id, key, fromUi = v => v.trim(), toUi = v => v ?? '') {
    const el = document.getElementById(id);
    if (!el) return;
    const sync = () => {
        const value = getSettings()[key];
        el.value = toUi(value);
    };
    sync();
    el.addEventListener('input', () => {
        getSettings()[key] = fromUi(el.value);
        getSettings().activeSavedConnectionProfileId = '';
        saveSettings();
        renderSavedConnectionProfiles();
    });
}

function captureConnectionProfileData() {
    const s = getSettings();
    return Object.fromEntries(CONNECTION_PROFILE_FIELDS.map(key => [key, structuredClone(s[key])]));
}

function applyConnectionProfileData(data) {
    const s = getSettings();
    for (const key of CONNECTION_PROFILE_FIELDS) {
        if (Object.hasOwn(data, key)) s[key] = structuredClone(data[key]);
    }
    saveSettings();
    syncConnectionUIFromSettings();
}

function renderSavedConnectionProfiles() {
    const select = document.getElementById('summaryception_saved_profile');
    if (!select) return;
    const s = getSettings();
    select.innerHTML = '<option value="">-- Current unsaved settings --</option>';
    for (const profile of s.savedConnectionProfiles || []) {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = `${profile.name} (${profile.data?.connectionSource || 'default'})`;
        select.appendChild(opt);
    }
    select.value = s.activeSavedConnectionProfileId || '';
}

function syncConnectionUIFromSettings() {
    const s = getSettings();
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value ?? '';
    };
    set('summaryception_connection_source', s.connectionSource || 'default');
    set('summaryception_connection_profile', s.connectionProfileId || '');
    set('summaryception_ollama_url', s.ollamaUrl || '');
    set('summaryception_ollama_model', s.ollamaModel || '');
    set('summaryception_openai_url', s.openaiUrl || '');
    set('summaryception_openai_key', s.openaiKey || '');
    set('summaryception_openai_model', s.openaiModel || '');
    set('summaryception_openai_max_tokens', s.openaiMaxTokens || 0);
    set('summaryception_kcpp_url', s.koboldcppUrl || '');
    set('summaryception_kcpp_prefix', (s.koboldcppPrefix || '').replace(/\n/g, '\\n'));
    set('summaryception_kcpp_suffix', (s.koboldcppSuffix || '').replace(/\n/g, '\\n'));
    set('summaryception_temperature', s.summarizerTemperature ?? defaultSettings.summarizerTemperature);
    set('summaryception_timeout_ms', s.summarizerTimeoutMs ?? defaultSettings.summarizerTimeoutMs);
    set('summaryception_stop_sequences', (s.summarizerStopSequences || []).join('\n'));
    set('summaryception_completion_url', s.completionUrl || '');
    set('summaryception_completion_key', s.completionKey || '');
    set('summaryception_completion_model', s.completionModel || '');
    set('summaryception_completion_prefix', (s.completionPrefix || '').replace(/\n/g, '\\n'));
    set('summaryception_completion_suffix', (s.completionSuffix || '').replace(/\n/g, '\\n'));
    set('summaryception_custom_url', s.customUrl || '');
    set('summaryception_custom_headers', s.customHeaders || '');
    set('summaryception_custom_body', s.customBodyTemplate || '');
    set('summaryception_custom_response_path', s.customResponsePath || '');
    set('summaryception_custom_api_key', s.customApiKey || '');
    set('summaryception_custom_model', s.customModel || '');
    updateConnectionSubPanels(s.connectionSource || 'default');
    renderSavedConnectionProfiles();
}

function saveCurrentConnectionProfile() {
    const name = prompt('Name this Summaryception connection profile:', getConnectionDisplayName(getSettings()));
    if (!name) return;
    const s = getSettings();
    const profile = { id: `sc_${Date.now().toString(36)}`, name: name.trim(), data: captureConnectionProfileData(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    s.savedConnectionProfiles = [...(s.savedConnectionProfiles || []), profile];
    s.activeSavedConnectionProfileId = profile.id;
    saveSettings();
    renderSavedConnectionProfiles();
    toastr.success(`Saved connection profile "${profile.name}".`, 'Summaryception');
}

function getSelectedConnectionProfile() {
    const id = document.getElementById('summaryception_saved_profile')?.value || getSettings().activeSavedConnectionProfileId;
    return (getSettings().savedConnectionProfiles || []).find(profile => profile.id === id);
}

function updateSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) return toastr.warning('Select a saved Summaryception profile first.', 'Summaryception');
    profile.data = captureConnectionProfileData();
    profile.updatedAt = new Date().toISOString();
    getSettings().activeSavedConnectionProfileId = profile.id;
    saveSettings();
    renderSavedConnectionProfiles();
    toastr.success(`Updated connection profile "${profile.name}".`, 'Summaryception');
}

function duplicateSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) return toastr.warning('Select a saved Summaryception profile first.', 'Summaryception');
    const copy = structuredClone(profile);
    copy.id = `sc_${Date.now().toString(36)}`;
    copy.name = `${profile.name} Copy`;
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    getSettings().savedConnectionProfiles.push(copy);
    getSettings().activeSavedConnectionProfileId = copy.id;
    saveSettings();
    renderSavedConnectionProfiles();
}

function deleteSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) return toastr.warning('Select a saved Summaryception profile first.', 'Summaryception');
    if (!confirm(`Delete Summaryception connection profile "${profile.name}"?`)) return;
    const s = getSettings();
    s.savedConnectionProfiles = (s.savedConnectionProfiles || []).filter(item => item.id !== profile.id);
    if (s.activeSavedConnectionProfileId === profile.id) s.activeSavedConnectionProfileId = '';
    saveSettings();
    renderSavedConnectionProfiles();
}

function loadSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) {
        getSettings().activeSavedConnectionProfileId = '';
        saveSettings();
        return;
    }
    getSettings().activeSavedConnectionProfileId = profile.id;
    applyConnectionProfileData(profile.data || {});
    toastr.success(`Loaded connection profile "${profile.name}".`, 'Summaryception');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile:   document.getElementById('summaryception_profile_settings'),
        ollama:    document.getElementById('summaryception_ollama_settings'),
        openai:    document.getElementById('summaryception_openai_settings'),
        koboldcpp: document.getElementById('summaryception_kcpp_settings'),
        completion: document.getElementById('summaryception_completion_settings'),
        custom: document.getElementById('summaryception_custom_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

async function testCurrentConnectionHandler() {
    const s = getSettings();
    showConnectionStatus('loading', `Testing ${getConnectionDisplayName(s)}...`);
    const started = performance.now();
    try {
        const response = await Promise.race([
            sendSummarizerRequest(s, 'You are a connection test assistant.', 'Reply with exactly: CONNECTION_OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection test timed out')), s.summarizerTimeoutMs || defaultSettings.summarizerTimeoutMs)),
        ]);
        const elapsed = Math.round(performance.now() - started);
        showConnectionStatus('success', `OK in ${elapsed}ms: ${(response || '').trim().slice(0, 160)}`);
        toastr.success(`Connection test succeeded in ${elapsed}ms.`, 'Summaryception');
    } catch (error) {
        showConnectionStatus('error', `Failed: ${error.message || error}`);
        toastr.error(`Connection test failed: ${error.message || error}`, 'Summaryception');
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) container.style.display = 'none';
        }, 8000);
    }
}

async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}

// ─── Initialization ──────────────────────────────────────────────────


(async function init() {
    const context = SillyTavern.getContext();
    const {
        eventSource,
        renderExtensionTemplateAsync,
    } = context;
    const event_types = context.eventTypes || context.event_types;

    getSettings();

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);

    bindUIEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED', 'CHARACTER_MESSAGE_RENDERED']) {
        if (event_types[name]) eventSource.on(event_types[name], name === 'CHARACTER_MESSAGE_RENDERED' ? () => onSourceMessageChanged() : onSourceMessageChanged);
    }

    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        updateUI();
        log(`v${EXTENSION_VERSION} loaded. Connection Settings available`);
    });
    // Extensions can be enabled after APP_READY has already fired.
    await repairIfBranched();
    await activateCharacterMemoryStore();
    updateInjection();
    updateUI();
})();
