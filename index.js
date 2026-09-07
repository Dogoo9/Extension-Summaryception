/**
 * Summaryception v5.5.5 — Layered Recursive Summarization for SillyTavern
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

const MODULE_NAME = 'summaryception';
const LOG_PREFIX = '[Summaryception]';
const EXTENSION_VERSION = '5.5.5';
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
        const retryAfter = error?.response?.headers?.['retry-after']
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
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
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
    };
}

const assembledContextCache = new WeakMap();

function invalidateContextCache(store) {
    if (store && typeof store === 'object') assembledContextCache.delete(store);
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
    store.layers = store.layers.map(layer => Array.isArray(layer)
        ? layer.map(snippet => typeof snippet === 'string' ? { text: snippet } : snippet)
        : []);
    if (typeof store.summarizedUpTo !== 'number') store.summarizedUpTo = -1;
    if (!Array.isArray(store.ghostedIndices)) store.ghostedIndices = [];
    const chatLength = SillyTavern.getContext()?.chat?.length;
    store.ghostedIndices = [...new Set(store.ghostedIndices.filter(index =>
        Number.isInteger(index)
        && index >= 0
        && (!Number.isInteger(chatLength) || index < chatLength)
    ))].sort((a, b) => a - b);
    return store;
}

function getSummarizedRangeStart(store, endIndex = store.summarizedUpTo) {
    const starts = (store.layers[0] || [])
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
        const warning = `Could not safely migrate ${candidates.join(', ')} to ${activeKey}; matching memory banks were preserved.`;
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
                root.sharedMemory = root.memories[sharedSourceKey] || createEmptyChatStore();
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

async function activateCharacterMemoryStore() {
    const s = getSettings();
    if (!s.separateMemoryByCharacterCard) return;

    const { chatMetadata } = SillyTavern.getContext();
    const previousKey = chatMetadata[MODULE_NAME]?.activeMemoryKey;
    const nextKey = getCharacterMemoryKey();

    if (previousKey && previousKey !== nextKey) {
        await unghostAllMessages(chatMetadata[MODULE_NAME]?.memories?.[previousKey]);
    }

    const store = getChatStore();
    if (store.summarizedUpTo >= 0) {
        await ghostMessagesUpTo(store.summarizedUpTo, getSummarizedRangeStart(store));
    }
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
    trace('>>> ENTERING repairGhostingForRange');
    trace('  startIdx:', startIdx, 'endIdx:', endIdx);

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const ghostedIndices = new Set(store.ghostedIndices);
    let repaired = 0;
    let skipped = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;

        // Skip if already ghosted
        if (m.extra?.sc_ghosted) {
            skipped++;
            continue;
        }

        // Skip if user-hidden (not by us)
        if (m.is_hidden && !m.extra?.sc_ghosted) {
            trace('  Skipping message ' + i + ' - user-hidden');
            skipped++;
            continue;
        }

        // Skip system/empty messages
        if (m.is_system || !m.mes?.trim()) {
            skipped++;
            continue;
        }

        // Skip user messages
        if (m.is_user) {
            skipped++;
            continue;
        }

        // This is an assistant message that should be ghosted but isn't
        trace('  Ghosting message ' + i);
        m.extra = m.extra || {};
        m.extra.sc_ghosted = true;

        ghostedIndices.add(i);

        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, { showOutput: false });
            repaired++;
        } catch (e) {
            console.error(LOG_PREFIX, 'Failed to ghost message ' + i + ':', e);
        }
    }

    store.ghostedIndices = [...ghostedIndices].sort((a, b) => a - b);
    trace('  Repaired:', repaired, 'Skipped:', skipped);
    await saveChatStore();
    trace('<<< EXITING repairGhostingForRange');
    return repaired;
}

async function ghostMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;
    if (!msg.extra) msg.extra = {};
    if (msg.extra.sc_ghosted) return;

    msg.extra.sc_ghosted = true;

    // Track that WE ghosted this message
    const store = getChatStore();
    const ghostedIndices = new Set(store.ghostedIndices);
    ghostedIndices.add(messageIndex);
    store.ghostedIndices = [...ghostedIndices].sort((a, b) => a - b);

    try {
        await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${messageIndex}`, { showOutput: false });
    } catch (e) {
        log(`Failed to hide message ${messageIndex}:`, e);
    }

    log(`Ghosted message at index ${messageIndex}`);
}

async function unghostAllMessages(storeOverride = null) {
    const { chat } = SillyTavern.getContext();
    const store = storeOverride ? normalizeChatStore(storeOverride) : getChatStore();

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
            if (idx >= 0 && idx < chat.length) {
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

async function ghostMessagesUpTo(endIndex, startIndex = 0) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();

    const rangeStart = Math.max(0, Number.isInteger(startIndex) ? startIndex : 0);
    const rangeEnd = Math.min(chat.length - 1, Number.isInteger(endIndex) ? endIndex : -1);
    if (rangeStart > rangeEnd) return;

    const ghostedIndices = new Set(store.ghostedIndices);
    let newlyGhosted = 0;

    for (let i = rangeStart; i <= rangeEnd; i++) {
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
async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) return;

    const chatLength = chat.length;
    const repairedBanks = [];

    // Ensure current metadata/migrations are initialized before scanning all
    // stores, including inactive per-character banks.
    getChatStore();

    for (const [key, store] of getAllMemoryStores()) {
        const oldSummarizedUpTo = store.summarizedUpTo;
        const originalGhostedCount = store.ghostedIndices.length;
        let removedSnippets = 0;

        if (store.layers[0]) {
            const before = store.layers[0].length;
            store.layers[0] = store.layers[0].filter(snippet => {
                if (!snippet.turnRange) return true;
                return snippet.turnRange[1] < chatLength;
            });
            removedSnippets = before - store.layers[0].length;
            if (removedSnippets > 0) invalidateContextCache(store);
        }

        store.ghostedIndices = store.ghostedIndices.filter(idx => idx < chatLength);

        const needsRepair = oldSummarizedUpTo >= chatLength
            || removedSnippets > 0
            || store.ghostedIndices.length !== originalGhostedCount;

        if (!needsRepair) {
            continue;
        }

        recalculateSummarizedUpTo(store);
        repairedBanks.push(getMemoryBankLabel(key));

        log(
            `Branch repair complete for ${key}. ` +
            `removed snippets: ${removedSnippets}, ` +
            `ghosted indices: ${originalGhostedCount} → ${store.ghostedIndices.length}, ` +
            `summarizedUpTo: ${oldSummarizedUpTo} → ${store.summarizedUpTo}`
        );
    }

    if (repairedBanks.length > 0) {
        await saveChatStore();
        toastr.info(
            `Branch detected — trimmed stale Summaryception memory data in ${repairedBanks.length} bank${repairedBanks.length === 1 ? '' : 's'}.`,
            'Summaryception — Branch Repair',
            { timeOut: 6000 }
        );
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
function buildPassageFromRange(chat, startIdx, endIdx) {
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
        lines.push(`${speaker}: ${m.mes.trim()}`);
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
            if (accepted.length === 0 && remaining > 0) {
                accepted.push({ ...part, text: text.slice(0, remaining) });
            }
            break;
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
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
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
    let text = raw;

    const s = getSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Remove common reasoning blocks (content between tag pairs)
    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;
let currentAbortController = null;

function abortSummarization() {
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
    isSummarizing = false;
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

async function callSummarizer(storyTxt, contextStr, extraInstructions = '') {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const prompt = s.summarizerUserPrompt
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{story_txt}}', storyTxt)
        + (extraInstructions ? `\n\n${extraInstructions}` : '');

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) disableAllPromptToggles();

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    let lastError = null;

    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            trace(`  Attempt ${attempt} starting...`);

            if (signal.aborted) {
                log('Summarization aborted by user.');
                toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
                return '';
            }

            try {
                if (attempt > 0) {
                    log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
                }

                trace(`  About to call sendSummarizerRequest with:`, {
                    connectionSource: s.connectionSource,
                    summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
                    promptLength: prompt.length,
                });

                const timeoutMs = Number(s.summarizerTimeoutMs) > 0
                    ? Number(s.summarizerTimeoutMs)
                    : defaultSettings.summarizerTimeoutMs;
                const result = await Promise.race([
                    sendSummarizerRequest(s, s.summarizerSystemPrompt, prompt),
                    new Promise((_, reject) => {
                        const timer = setTimeout(() => reject(new Error('Request timed out after 120s')), timeoutMs);
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Aborted by user'));
                        });
                    }),
                ]);

                trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));

                let trimmed = (result || '').trim();
                trimmed = cleanSummarizerOutput(trimmed);

                if (!trimmed) {
                    log('Empty response from LLM, treating as retryable');
                    throw new Error('Empty response from summarizer');
                }

                log('Result:', trimmed);
                trace('<<< EXITING callSummarizer WITH SUCCESS');
                return trimmed;

            } catch (err) {
                lastError = err;
                trace(`  Caught error on attempt ${attempt}:`, {
                    name: err?.name,
                    message: err?.message,
                    retryable: err?.retryable,
                });

                if (signal.aborted || err.message === 'Aborted by user') {
                    log('Summarization aborted by user.');
                    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
                    return '';
                }

                if (!isRetryableError(err)) {
                    trace('  ERROR IS NON-RETRYABLE, BREAKING');
                    console.error(LOG_PREFIX, 'Non-retryable error:', err);
                    break;
                }

                if (attempt >= RETRY_CONFIG.maxRetries) {
                    trace('  MAX RETRIES EXHAUSTED');
                    console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                    break;
                }

                let delay;
                const retryAfterMs = parseRetryAfter(err);
                if (retryAfterMs) {
                    delay = Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
                    log(`Server requested retry after ${delay}ms`);
                } else {
                    const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
                    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
                    delay = Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
                }

                const delaySec = (delay / 1000).toFixed(1);
                const status = err?.status || err?.response?.status || '?';

                console.warn(LOG_PREFIX, `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`, err.message || err);

                toastr.warning(
                    `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
                    'Summaryception',
                    { timeOut: delay }
                );

                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
            'Summaryception',
            { timeOut: 8000 }
        );
        trace('<<< EXITING callSummarizer WITH FAILURE');
        return '';

    } finally {
        currentAbortController = null;
        if (isDefaultMode && snapshot) {
            restorePromptToggles(snapshot);
        }
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) return;
    if (s.pauseSummarization) return;  // ← new
    if (isSummarizing) return;

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

    log(`Visible assistant turns: ${visibleTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleTurns.length <= s.verbatimTurns) return;

    const overflow = visibleTurns.length - s.verbatimTurns;

    // ─── Backlog detection ───────────────────────────────────────
    const backlogThreshold = s.turnsPerSummary * 2;

    if (overflow > backlogThreshold && !catchupDismissed) {
        log(`Large backlog detected: ${overflow} turns over limit`);

        const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);
        const choice = await showCatchupDialog(overflow, batchesNeeded);

        if (choice === 'skip') {
            const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
            if (cutoff) {
                store.summarizedUpTo = cutoff.index;
                log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
            }
            catchupDismissed = true;
            await saveChatStore();
            return;
        } else if (choice === 'catchup') {
            await runCatchup(visibleTurns, overflow);
            return;
        } else if (choice === 'partial') {
            await summarizeOneBatch(visibleTurns);
            return;
        }
        return;
    }

    // ─── Normal operation: single batch ──────────────────────────
    const success = await summarizeOneBatch(visibleTurns);

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return;
    }

    const remaining = getAssistantTurns(chat).filter(t => !chat[t.index].extra?.sc_ghosted);
    if (remaining.length > s.verbatimTurns && remaining.length - s.verbatimTurns <= backlogThreshold) {
        await maybeSummarizeTurns();
    }
}

// ─── Core: Single Batch Summarization ────────────────────────────────

async function summarizeOneBatch(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatch');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const batchSize = Math.min(s.turnsPerSummary, visibleTurns.length);
    const batch = visibleTurns.slice(0, batchSize);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatch - EMPTY BATCH');
        return false;
    }

    isSummarizing = true;

    try {
        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;
        trace('  startIdx:', startIdx, 'endIdx:', endIdx);
        trace('  store.summarizedUpTo:', store.summarizedUpTo);

        log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

        // ─── FIX: Ensure batch is actually after the summarized point ───
        if (startIdx <= store.summarizedUpTo) {
            log(`Skipping batch: startIdx (${startIdx}) is <= summarizedUpTo (${store.summarizedUpTo})`);
            trace('<<< EXITING summarizeOneBatch - BATCH ALREADY SUMMARIZED');
            return false;
        }

        if (!store.layers[0]) store.layers[0] = [];
        const passageStart = Math.max(
            batch[0].index,
            store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1
        );

        // ─── SANITY CHECK ───
        if (passageStart > endIdx) {
            log(`ERROR: passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
            trace('<<< EXITING summarizeOneBatch - PASSAGE START GREATER THAN END');
            return false;
        }

        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
        if (!storyTxt.trim()) {
            trace('<<< EXITING summarizeOneBatch - EMPTY PASSAGE');
            return false;
        }

        const contextStr = buildFullContext(0);

        toastr.info(`Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`, 'Summaryception', {
            timeOut: 3000,
            progressBar: true,
        });

        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  summary length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('<<< EXITING summarizeOneBatch - EMPTY SUMMARY');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });
        invalidateContextCache(store);

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        await ghostMessagesUpTo(endIdx, passageStart);

        log(`Layer 0 now has ${store.layers[0].length} snippets`);

        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        toastr.success(`Summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: 2000 });
        trace('<<< EXITING summarizeOneBatch - SUCCESS');
        return true;

    } finally {
        isSummarizing = false;
    }
}

// ─── Core: Inner Batch for Catchup ───────────────────────────────────

const CATCHUP_BATCH_RESULT = Object.freeze({
    EMPTY_SKIP: 'EMPTY_SKIP',
    NO_ELIGIBLE: 'NO_ELIGIBLE',
});

async function summarizeOneBatchFromTurns(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const eligibleTurns = visibleTurns.filter(turn => turn.index > store.summarizedUpTo);

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    trace('  eligibleTurns:', eligibleTurns.length);
    trace('  batchSize:', batchSize);
    trace('  batch prepared:', batch.length);


    try {
        if (batch.length === 0) {
            const summarizedVisibleTurns = visibleTurns.filter(turn => turn.index <= store.summarizedUpTo);
            trace('  No eligible turns; re-ghosting summarized visible turns:', summarizedVisibleTurns.length);
            for (const turn of summarizedVisibleTurns) {
                await ghostMessage(turn.index);
            }
            await saveChatStore();
            trace('<<< EXITING summarizeOneBatchFromTurns - NO_ELIGIBLE');
            return CATCHUP_BATCH_RESULT.NO_ELIGIBLE;
        }

        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;
        const passageStart = startIdx;

        trace('  startIdx:', startIdx, 'endIdx:', endIdx);
        trace('  store.summarizedUpTo:', store.summarizedUpTo);
        trace('  passageStart:', passageStart, 'endIdx:', endIdx);

        if (!store.layers[0]) store.layers[0] = [];

        trace('  About to call buildPassageFromRange...');
        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  buildPassageFromRange returned, length:', storyTxt?.length ?? 'UNDEFINED');

        if (!storyTxt.trim()) {
            store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
            await saveChatStore();
            trace('  Empty passage skipped; summarizedUpTo advanced to:', store.summarizedUpTo);
            trace('<<< EXITING summarizeOneBatchFromTurns - EMPTY_SKIP');
            return CATCHUP_BATCH_RESULT.EMPTY_SKIP;

        }

        trace('  About to call buildFullContext...');
        const contextStr = buildFullContext(0);
        trace('  buildFullContext returned, length:', contextStr?.length ?? 'UNDEFINED');

        trace('  About to call callSummarizer...');
        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  callSummarizer returned, length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('  <<< EXITING - summary is empty');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });
        invalidateContextCache(store);

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

        await saveChatStore();
        await ghostMessagesUpTo(endIdx, passageStart);
        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        trace('<<< EXITING summarizeOneBatchFromTurns - SUCCESS');
        return true;

    } catch (err) {
        trace('  CAUGHT EXCEPTION:', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.substring?.(0, 200),
        });
        console.error(LOG_PREFIX, 'summarizeOneBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeOneBatchFromTurns - EXCEPTION');
        return false;
    }
}

// ─── Core: Catchup Processing ────────────────────────────────────────

async function runCatchup(visibleTurns, overflow) {

    trace('>>> ENTERING runCatchup');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
    trace('  overflow:', overflow);

    const s = getSettings();
    const totalBatches = Math.ceil(overflow / s.turnsPerSummary);
    let completed = 0;
    let failed = 0;
    let cancelled = false;

    trace('  totalBatches calculated:', totalBatches);

    const progressToast = toastr.info(
        `Processing backlog: 0 / ${totalBatches} batches (0%)`,
        'Summaryception Catch-Up',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            onCloseClick: () => {
                cancelled = true;
                abortSummarization();
            },
        }
    );

    isSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const currentVisible = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            trace(`  currentVisible turns: ${currentVisible.length}, verbatimTurns limit: ${s.verbatimTurns}`);

            if (currentVisible.length <= s.verbatimTurns) {
                trace('  Visible turns now within limit, breaking');
                break;
            }

            trace('  About to call summarizeOneBatchFromTurns...');
            const result = await summarizeOneBatchFromTurns(currentVisible);

            if (result === true) {
                trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                completed++;
                consecutiveFailures = 0;
            } else if (result === CATCHUP_BATCH_RESULT.EMPTY_SKIP) {
                trace('  >>> summarizeOneBatchFromTurns returned EMPTY_SKIP');
                completed++;
                consecutiveFailures = 0;
            } else if (result === CATCHUP_BATCH_RESULT.NO_ELIGIBLE) {
                trace('  >>> summarizeOneBatchFromTurns returned NO_ELIGIBLE');
                consecutiveFailures = 0;

            } else {
                trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
                failed++;
                consecutiveFailures++;

                if (consecutiveFailures >= TUNING.consecutiveFailureLimit) {
                    toastr.error(
                        `${TUNING.consecutiveFailureLimit} consecutive failures — API may be down. Pausing catch-up. Progress saved; will resume on next message.`,
                        'Summaryception',
                        { timeOut: 8000 }
                    );
                    trace('  3 consecutive failures, breaking');
                    break;
                }
            }

            const pct = Math.round((completed / totalBatches) * 100);
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast).find('.toast-message').text(
                `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`
            );

            await new Promise(r => setTimeout(r, 200));
        }

        if (cancelled) {
            toastr.warning(
                `Catch-up paused at ${completed}/${totalBatches}. Progress saved — will continue on next message.`,
                'Summaryception',
                { timeOut: 5000 }
            );
        } else if (failed === 0) {
            toastr.success(
                `Catch-up complete! ${completed} batches processed.`,
                'Summaryception',
                { timeOut: 4000 }
            );
        } else {
            toastr.warning(
                `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
                'Summaryception',
                { timeOut: 6000 }
            );
        }

        updateUI();

    } finally {
        clearPersistentToast(progressToast);
        isSummarizing = false;
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

        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => {
            overlay.remove();
            resolve('catchup');
        });
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => {
            overlay.remove();
            resolve('skip');
        });
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => {
            overlay.remove();
            resolve('partial');
        });
    });
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        const seed = layer.shift();
        seed.promoted = true;
        seed.seedFromLayer = layerIndex;
        destLayer.push(seed);
        invalidateContextCache(store);

        log(`Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`);

        toastr.info(
            `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
            'Summaryception',
            { timeOut: 2000 }
        );

        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex);
        }
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex + 1);
        }
        return;
    }

    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    invalidateContextCache(store);
    const storyTxt = toMerge.map(snippetText).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true }
    );

    const promotionInstructions = `This is a memory promotion. Preserve every unresolved thread and durable fact. Merge repeated facts into one concise statement. When newer information conflicts with older information, explicitly replace the obsolete state instead of appending both versions. Preserve current location/time and named entities.`;
    const metaSummary = await callSummarizer(storyTxt, contextStr, promotionInstructions);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        invalidateContextCache(store);
        return;
    }

    const mergedRecall = mergeRecallFields(toMerge);

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
        ...(mergedRecall ? { recall: mergedRecall } : {}),
    });
    invalidateContextCache(store);

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) return '';

    const snippets = [];

    for (let i = store.layers.length - 1; i >= 1; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            snippets.push(sn);
        }
    }

    if (store.layers[0] && store.layers[0].length > 0) {
        for (const sn of store.layers[0]) {
            snippets.push(sn);
        }
    }

    if (snippets.length === 0) return '';

    const recall = mergeRecallFields(snippets);
    const priorityParts = [];
    if (recall?.unresolvedThreads.length) priorityParts.push(`Unresolved: ${recall.unresolvedThreads.join('; ')}`);
    if (recall?.currentLocation || recall?.currentTime) {
        priorityParts.push(`Current state: ${[
            recall.currentLocation && `location=${recall.currentLocation}`,
            recall.currentTime && `time=${recall.currentTime}`,
        ].filter(Boolean).join(', ')}`);
    }
    if (recall?.durableFacts.length) priorityParts.push(`Durable facts: ${recall.durableFacts.join('; ')}`);
    if (recall?.entities.length) priorityParts.push(`Entities: ${recall.entities.join('; ')}`);

    const budget = getContextBudgetCharacters(s);
    const prioritized = fitContextParts(priorityParts.map(text => ({ text })), budget);
    const used = prioritized.reduce((sum, part, index) => sum + part.text.length + (index ? 1 : 0), 0);
    const chronology = fitContextParts(
        snippets.map(sn => ({ text: snippetText(sn) })),
        Math.max(0, budget - used - (prioritized.length ? 1 : 0)),
    );
    const combinedSummary = [...prioritized, ...chronology].map(part => part.text).join(' ').trim();
    const template = (s.injectionTemplate || defaultSettings.injectionTemplate).trim();

    if (template.includes('{{summary}}')) {
        return template.replaceAll('{{summary}}', combinedSummary);
    }

    // A missing placeholder used to silently drop the summary from injection.
    // Append the summary instead so a bad edit is visible and recoverable.
    return `${template}
${combinedSummary}`.trim();
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

function onMessageReceived(messageIndex) {
    if (!getSettings().enabled) return;
    try {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            setTimeout(async () => {
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
    catchupDismissed = false;
    setTimeout(async () => {
        await activateCharacterMemoryStore();
        await repairIfBranched();
        updateInjection();
        updateUI();
    }, 100);
}

function onGenerationStarted() {
    updateInjection();
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
                await unghostAllMessages();

                const store = getChatStore();
                store.layers.length = 0;
                invalidateContextCache(store);
                store.summarizedUpTo = -1;
                store.ghostedIndices = [];

                await saveChatStore();
                try {
                    const ctx2 = SillyTavern.getContext();
                    if (ctx2.saveChat) await ctx2.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
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
            </div>
            <div class="sc-db-attachments">${attachmentRows}</div>
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
    document.querySelector('.sc-db-overlay')?.remove();

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

            layer.splice(snippetIndex, 1);
            invalidateContextCache(store);
            recalculateSummarizedUpTo(store);
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
            downloadJson(`summaryception_memory_bank_${bankKey.replace(/[^a-z0-9_-]+/gi, '_')}_${Date.now()}.json`, bank);
            toastr.success('Memory bank exported.', 'Summaryception', { timeOut: 2000 });
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

        isSummarizing = true;
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
                    if (i === layerIdx && j === snippetIdx) continue;
                    contextParts.push(l[j].text);
                }
            }
            const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';

            toastr.info(`Regenerating summary for turns ${rangeStart}–${rangeEnd}…`, 'Summaryception', {
                timeOut: 3000,
                progressBar: true,
            });

            const newSummary = await callSummarizer(storyTxt, contextStr);

            if (!newSummary) {
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
            isSummarizing = false;
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
        }
    });

    // Delete snippet
    $('.sc-snippet-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer) {
            layer.splice(snippetIdx, 1);
            invalidateContextCache(store);

            if (store.layers[0] && store.layers[0].length > 0) {
                const maxEnd = Math.max(...store.layers[0]
                    .filter(sn => sn.turnRange)
                    .map(sn => sn.turnRange[1]));
                store.summarizedUpTo = maxEnd;
            } else {
                store.summarizedUpTo = -1;
            }

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

function bindUIEvents() {
    $('#sc_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $('#sc_pause_summarization').on('change', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
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
        }
    });

    $('#sc_disable_ghosting').on('change', function () {
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_separate_by_character').on('change', async function () {
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
        const { chat } = SillyTavern.getContext();
        let repaired = 0;

        const progressToast = toastr.info(
            'Scanning for orphaned messages...',
            'Summaryception — Repair',
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
        );

        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];

            const isStuckHidden = (m.is_system || m.is_hidden)
                && !m.is_user
                && !m.extra?.sc_ghosted
                && m.mes
                && m.mes.trim().length > 0;

            if (isStuckHidden) {
                try {
                    await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, { showOutput: false });
                } catch (e) {
                    log(`Repair: failed to unhide ${i}:`, e);
                }

                m.is_system = false;
                delete m.is_hidden;

                repaired++;

                if (repaired % 5 === 0) {
                    $(progressToast).find('.toast-message').text(
                        `Repairing: found ${repaired} orphaned messages...`
                    );
                }
            }
        }

        clearPersistentToast(progressToast);

        if (repaired > 0) {
            try {
                const ctx = SillyTavern.getContext();
                if (ctx.saveChat) await ctx.saveChat();
            } catch (e) {
                log('Could not save chat:', e);
            }
            updateUI();
            toastr.success(
                `Repaired ${repaired} orphaned messages. They are now visible to the summarizer again.`,
                'Summaryception',
                { timeOut: 5000 }
            );
        } else {
            toastr.info('No orphaned messages found.', 'Summaryception', { timeOut: 3000 });
        }
    });


    $('#sc_view_database').on('click', function () {
        showMemoryDatabaseModal();
    });

    $('#sc_clear_memory').on('click', async function () {
        if (!confirm('Clear Summaryception memory for the active memory bank and unghost its messages?')) return;
        await unghostAllMessages();
        const store = getChatStore();
        store.layers.length = 0;
        invalidateContextCache(store);
        store.summarizedUpTo = -1;
        store.ghostedIndices = [];
        await saveChatStore();
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }
        updateInjection();
        updateUI();
        toastr.success('Active Summaryception memory cleared and messages unghosted.', 'Summaryception');
    });

    $('#sc_force_summarize').on('click', async function () {
        trace('>>> FORCE SUMMARIZE CLICKED');

        const s = getSettings();
        const { chat } = SillyTavern.getContext();
        const store = getChatStore();

        trace('  enabled:', s.enabled);
        trace('  isSummarizing:', isSummarizing);

        debugVisibleTurns(chat, store);

        const ghostedCount = chat.filter(m => m?.extra?.sc_ghosted).length;

        // Auto-recover corrupted ghosting state: everything ghosted but nothing summarized yet.
        if (store.summarizedUpTo < 0 && ghostedCount > 0) {
            trace('  Detected ghost-state mismatch. summarizedUpTo = -1 but ghostedCount =', ghostedCount);
            toastr.warning(
                `Detected ${ghostedCount} ghosted messages with no saved summary index. Restoring visibility first...`,
                'Summaryception',
                { timeOut: 3500 }
            );
            await unghostAllMessages();
            await saveChatStore();

            try {
                const ctx = SillyTavern.getContext();
                if (ctx.saveChat) await ctx.saveChat();
            } catch (e) {
                log('Could not save chat after ghost-state recovery:', e);
            }

            toastr.success('Recovered ghosted messages. Re-running force summarization now.', 'Summaryception', { timeOut: 2500 });
        }

        if (!s.enabled) {
            toastr.warning('Enable Summaryception first.');
            return;
        }
        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.');
            return;
        }
        if (s.pauseSummarization) {
            log('Force Summarize overrides pause mode.');
        }

        // ─── NEW: Repair ghosting before proceeding ───
        if (store.summarizedUpTo >= 0) {
            trace('  Checking ghosting integrity...');
            const unghosteredCount = Array.from({ length: store.summarizedUpTo + 1 }).reduce((count, _, i) => {
                const m = chat[i];
                return (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes?.trim()) ? count + 1 : count;
            }, 0);

            if (unghosteredCount > 0) {
                trace('  Found ' + unghosteredCount + ' unghosted messages up to summarizedUpTo');
                toastr.warning(
                    `Found ${unghosteredCount} messages that should be hidden. Repairing ghosting...`,
                    'Summaryception',
                    { timeOut: 3000 }
                );

                const repaired = await repairGhostingForRange(
                    getSummarizedRangeStart(store),
                    store.summarizedUpTo
                );
                trace('  Repaired ' + repaired + ' messages');
                toastr.info(
                    `Repaired ghosting for ${repaired} messages.`,
                    'Summaryception',
                    { timeOut: 2000 }
                );
            }
        }

        $(this).prop('disabled', true).text(' Working…');
        try {
            catchupDismissed = false;

            const allAssistantTurns = getAssistantTurns(chat);
            const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);
            const unsummarizedVisibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);

            trace('  allAssistantTurns:', allAssistantTurns.length);
            trace('  visibleTurns after repair:', visibleTurns.length);
            trace('  unsummarizedVisibleTurns:', unsummarizedVisibleTurns.length);
            trace('  summarizedUpTo:', store.summarizedUpTo);

            // Standard path: summarize until we are back under the verbatim window.
            if (visibleTurns.length > s.verbatimTurns) {
                const overflow = visibleTurns.length - s.verbatimTurns;
                trace('  overflow turns:', overflow);
                toastr.info(`${overflow} turns to process. Starting...`, 'Summaryception', { timeOut: 2000 });

                trace('  About to call runCatchup...');
                await runCatchup(visibleTurns, overflow);
                trace('  runCatchup returned');
                updateInjection();
                return;
            }

            // Forced path: even if currently under verbatim window, process any unsummarized visible backlog.
            if (unsummarizedVisibleTurns.length > 0) {
                toastr.info(
                    `Forcing one backlog batch (${Math.min(s.turnsPerSummary, unsummarizedVisibleTurns.length)} turn${unsummarizedVisibleTurns.length > 1 ? 's' : ''})...`,
                    'Summaryception',
                    { timeOut: 2500 }
                );
                const success = await summarizeOneBatchFromTurns(unsummarizedVisibleTurns);
                if (success) {
                    toastr.success('Forced summarization completed.', 'Summaryception', { timeOut: 2000 });
                    updateInjection();
                }
                return;
            }

            toastr.info(
                `Nothing to summarize. Visible assistant turns: ${visibleTurns.length}, verbatim limit: ${s.verbatimTurns}, summarized up to index: ${store.summarizedUpTo}.`,
                'Summaryception'
            );
            trace('<<< FORCE SUMMARIZE - nothing to summarize');
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateUI();
            trace('<<< FORCE SUMMARIZE COMPLETED');
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
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const importedStore = data.store || data;
                if (!importedStore.layers || !Array.isArray(importedStore.layers)) {
                    toastr.error('Invalid file format.');
                    return;
                }

                const { chat } = SillyTavern.getContext();
                const store = getChatStore();

                await unghostAllMessages();

                store.layers = importedStore.layers;
                store.summarizedUpTo = importedStore.summarizedUpTo ?? -1;
                store.ghostedIndices = importedStore.ghostedIndices || [];
                normalizeChatStore(store);
                invalidateContextCache(store);


                if (store.summarizedUpTo >= 0) {
                    await ghostMessagesUpTo(store.summarizedUpTo, getSummarizedRangeStart(store));
                }

                await saveChatStore();
                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                toastr.success(
                    `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                    'Summaryception',
                    { timeOut: 4000 }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.');
            }
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

    bindSimpleConnectionInput('summaryception_temperature', 'summarizerTemperature', v => Number.parseFloat(v) || defaultSettings.summarizerTemperature);
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
    const {
        eventSource,
        event_types,
        renderExtensionTemplateAsync,
    } = SillyTavern.getContext();

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

    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        updateUI();
        log(`v${EXTENSION_VERSION} loaded. Connection Settings available`);
    });
})();
