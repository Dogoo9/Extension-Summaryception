/**
 * Summaryception — memory store, ghosting, summarization, promotion and injection
 * AGPL-3.0
 */

import {
    sendSummarizerRequest,
} from './connectionutil.js';
import {
    messageSignature,
    firstSourceChange,
} from './source-signatures.js';
import {
    createMeter,
    assembleBudgetedMemory,
    assembleBudgetedMemoryAsync,
} from './memory-budget.js';
import {
    checkNameRetention,
    parseNameList,
} from './name-check.js';
import {
    EXTENSION_PROMPT_ROLES,
    EXTENSION_PROMPT_TYPES,
    INJECTION_POSITION_LABELS,
    LOG_PREFIX,
    MODULE_NAME,
    RETRY_CONFIG,
    TUNING,
    defaultSettings,
} from './constants.js';
import {
    getSettings,
    log,
    saveSettings,
    trace,
} from './settings.js';
import {
    disableAllPromptToggles,
    restorePromptToggles,
    snapshotPromptToggles,
} from './prompt-toggles.js';
import {
    clearActiveMemory,
    estimateTokens,
    showMemoryDatabaseModal,
    updateInjectionInspector,
    updateUI,
} from './settings-ui.js';

const shownMigrationWarnings = new Set();

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
        sourceSignatures: [],
        archive: [],                  // Snippets merged by promotion: { ...snippet, layer, parentId, archivedAt }
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

function newSnippetId() {
    // crypto.randomUUID needs a secure context; SillyTavern is often served over plain LAN HTTP.
    try { if (globalThis.crypto?.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
    return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
        for (const snippet of store.layers[i]) if (typeof snippet.id !== 'string' || !snippet.id) snippet.id = newSnippetId();
    }
    if (!Array.isArray(store.archive)) store.archive = [];
    for (let j = store.archive.length - 1; j >= 0; j--) {
        const entry = store.archive[j];
        if (!entry || typeof entry.text !== 'string' || !Number.isInteger(entry.layer) || entry.layer < 0) store.archive.splice(j, 1);
        else if (typeof entry.id !== 'string' || !entry.id) entry.id = newSnippetId();
    }
    if (typeof store.summarizedUpTo !== 'number') store.summarizedUpTo = -1;
    if (!Array.isArray(store.ghostedIndices)) store.ghostedIndices = [];
    // Retire fact snapshots and legacy recall metadata while preserving prose,
    // ranges, signatures, and visibility ownership from older saves/imports.
    delete store.structuredState;
    delete store.lastFactBatch;
    if (store.lastBatch) delete store.lastBatch.structuredState;
    for (const snippet of store.layers.flat()) delete snippet.recall;
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
            if (processed % TUNING.ghostProgressInterval === 0 || processed === toUnhide.length) {
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
    const revision = storeRevisions.get(store) || 0;
    let newlyGhosted = 0;

    for (let i = rangeStart; i <= rangeEnd; i++) {
        // Finish visibility for an already committed batch even after Stop.
        // A source repair, card switch, or disable still invalidates this work.
        if (!targetIsCurrent(target) || revision !== (storeRevisions.get(store) || 0) || !s.enabled) break;
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
    const keep = sn => sn.turnRange && sn.turnRange[1] < dirty;
    for (let i = 0; i < store.layers.length; i++) {
        store.layers[i] = store.layers[i].filter(keep);
    }
    if (Array.isArray(store.archive)) {
        store.archive = store.archive.filter(keep);
        // A removed promoted snippet no longer represents its children. Children that
        // still predate the change are put back into their original layer, so a late
        // edit only rolls memory back to the last unaffected detail instead of to the
        // start of the condensed parent.
        const liveIds = new Set([...store.layers.flat(), ...store.archive].map(sn => sn.id));
        const orphans = store.archive.filter(entry => entry.parentId && !liveIds.has(entry.parentId));
        if (orphans.length) {
            store.archive = store.archive.filter(entry => !orphans.includes(entry));
            for (const entry of orphans) {
                const { layer, parentId, archivedAt, ...snippet } = entry;
                while (store.layers.length <= layer) store.layers.push([]);
                store.layers[layer].push(snippet);
            }
            for (const layer of store.layers) layer.sort((a, b) => a.turnRange[0] - b.turnRange[0]);
        }
    }
    recalculateSummarizedUpTo(store);
    store.sourceSignatures.length = Math.max(0, store.summarizedUpTo + 1);
    store.ghostedIndices = store.ghostedIndices.filter(i => i <= store.summarizedUpTo);
    invalidateContextCache(store);
    if (store.lastBatch?.range?.[1] >= dirty) delete store.lastBatch;
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
        if (store.summarizedUpTo >= chat.length || futureRanges.length) {
            dirty = dirty < 0 ? chat.length : Math.min(dirty, chat.length);
        }
        if (Number.isInteger(changedHint) && changedHint >= 0
            && store.summarizedUpTo >= changedHint) {
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
        toastr.info('Changed source messages detected. Affected memories were rolled back; original messages are available for rebuilding.', 'Summaryception', { timeOut: TUNING.toastExtended });
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
let promptTogglesHeld = false;
let catchupDismissed = false;
let currentAbortController = null;
let activeRun = null;
let chatEpoch = 0;
let catchupDialogClose = null;
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
    updateProcessingUI();
    return activeRun;
}

function finishSummarization(run) {
    if (activeRun !== run) return;
    activeRun = null;
    currentAbortController = null;
    isSummarizing = false;
    updateProcessingUI();
    if (!run.controller.signal.aborted && targetIsCurrent(run.pendingSummaryTarget)) {
        onMessageReceived(run.pendingSummaryMessageIndex);
    }
}

function abortSummarization() {
    clearTimeout(messageReceivedTimer);
    if (activeRun) delete activeRun.pendingSummaryTarget;
    currentAbortController?.abort();
    catchupDialogClose?.();
    updateProcessingUI();
    // Keep the run locked until its finally block, including promotion/catchup.
}

function updateProcessingUI() {
    const stopping = Boolean(activeRun?.controller.signal.aborted);
    $('#sc_stop_summarize').prop('disabled', !isSummarizing || stopping);
    $('#sc_force_summarize, #sc_regenerate_latest').prop('disabled', isSummarizing);
    $('#sc_backlog_progress').toggle(Boolean(activeRun?.backlog));
    $('#sc_cancel_backlog').prop('disabled', stopping);
    if (activeRun?.backlog) {
        const { completed, total } = activeRun.backlog;
        $('#sc_backlog_status').text(`${stopping ? 'Canceling backlog' : 'Processing backlog'}: ${completed} / ${total} batches saved`);
        $('#sc_backlog_bar').attr('max', Math.max(total, 1)).val(completed);
    }
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

async function callSummarizer(storyTxt, contextStr, extraInstructions = '') {
    const s = structuredClone(getSettings());
    const variables = { player_name: getPlayerName(), context_str: contextStr || '(none yet)', story_txt: storyTxt };
    const prompt = s.summarizerUserPrompt.replace(/{{(player_name|context_str|story_txt)}}/g, (_, key) => variables[key])
        + (extraInstructions ? `\n\n${extraInstructions}` : '');
    const systemPrompt = s.summarizerSystemPrompt;
    const defaultMode = !s.connectionSource || s.connectionSource === 'default';
    // Default mode borrows the user's live connection and prompt manager. Hold the
    // toggles disabled only while a request is in flight, never during backoff, so
    // a user generation in that window still gets the full preset.
    let snapshot = null;
    const holdToggles = () => {
        if (!defaultMode || snapshot) return;
        snapshot = snapshotPromptToggles();
        disableAllPromptToggles();
        promptTogglesHeld = true;
    };
    const releaseToggles = () => {
        if (!snapshot) return;
        restorePromptToggles(snapshot);
        snapshot = null;
        promptTogglesHeld = false;
    };
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
                holdToggles();
                const raw = await Promise.race([
                    sendSummarizerRequest(s, systemPrompt, prompt, { signal: request.signal }), cancelled,
                ]);
                if (parent?.aborted) return '';
                const result = cleanSummarizerOutput(raw);
                if (!result) { const error = new Error('Empty response from summarizer'); error.retryable = true; throw error; }
                return result;
            } catch (error) {
                lastError = error;
                if (parent?.aborted || error.name === 'AbortError') return '';
                if (!(error.retryable === true || isRetryableError(error)) || attempt === RETRY_CONFIG.maxRetries) break;
                const delay = Math.min(parseRetryAfter(error) ?? (RETRY_CONFIG.baseDelay * RETRY_CONFIG.backoffMultiplier ** attempt + Math.random() * RETRY_CONFIG.baseDelay), RETRY_CONFIG.maxDelay);
                toastr.warning(`Summarizer request failed. Retrying in ${(delay / 1000).toFixed(1)}s.`, 'Summaryception', { timeOut: delay });
                // Clean the request resources before backoff, then use the run's signal.
                releaseToggles();
                clearTimeout(timer);
                parent?.removeEventListener('abort', onAbort);
                await delayWithSignal(delay, parent);
            } finally {
                clearTimeout(timer);
                parent?.removeEventListener('abort', onAbort);
            }
        }
        console.error(LOG_PREFIX, 'Summarization failed:', lastError);
        toastr.error(`Summarization failed: ${lastError?.message || 'unknown error'}. Source messages kept for retry.`, 'Summaryception', { timeOut: TUNING.toastError });
        return '';
    } finally {
        releaseToggles();
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

function unsummarizedTurns(chat, store) {
    return getAssistantTurns(chat).filter(turn => turn.index > store.summarizedUpTo
        && !(chat[turn.index].is_hidden && !chat[turn.index].extra?.sc_ghosted));
}

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled || s.pauseSummarization || isSummarizing) return;
    const target = captureMemoryTarget();
    if (s.debugMode && s.traceMode) debugVisibleTurns(target.chat, target.store);
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
    // Hysteresis: wait for a full batch. Summarizing one turn per reply costs a
    // summarizer call per turn and changes the prompt prefix (memory block and
    // oldest visible message) on every generation, defeating backend prompt caching.
    if (!s.strictVerbatimWindow && overflow < s.turnsPerSummary) return;
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
    const { chat, store } = run.target;
    const s = getSettings();
    const batch = visibleTurns.filter(turn => turn.index > store.summarizedUpTo).slice(0, s.turnsPerSummary);
    if (!batch.length) return false;
    // Include the player lead-in and all interleaved messages, including message 0.
    const passageStart = Math.max(0, store.summarizedUpTo + 1);
    const endIdx = batch.at(-1).index;
    const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
    if (!storyTxt.trim()) return false;
    const transaction = captureTransaction(run.target, endIdx);
    const range = [passageStart, endIdx];
    const started = performance.now();
    const result = await callSummarizer(storyTxt, buildFullContext(0));
    if (!result || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return false;
    if (!store.layers[0]) store.layers[0] = [];
    store.layers[0].push({ id: newSnippetId(), text: result, turnRange: range, timestamp: Date.now() });
    store.summarizedUpTo = endIdx;
    for (let i = 0; i <= endIdx; i++) store.sourceSignatures[i] = transaction.signatures[i];
    store.lastBatch = { milliseconds: Math.round(performance.now() - started), range };
    invalidateContextCache(store);
    await saveChatStore();
    if (!runIsCurrent(run)) return true;
    await ghostMessagesUpTo(endIdx, passageStart, run.target);
    if (targetIsCurrent(run.target)) {
        await saveChatStore();
        if (targetIsCurrent(run.target)) await SillyTavern.getContext().saveChat?.();
    }
    if (!runIsCurrent(run)) return true;
    await maybePromoteLayer(0, run);
    if (!runIsCurrent(run)) return true;
    await saveChatStore();
    const ctx = SillyTavern.getContext();
    if (ctx.saveChat) await ctx.saveChat();
    updateInjection();
    return true;
}

/**
 * @param {boolean} [drain] Summarize down to exactly verbatimTurns, including a
 *   final partial batch (explicit Force Summarize). Otherwise automatic catch-up
 *   leaves a partial remainder in the floating verbatim window, unless
 *   strictVerbatimWindow is enabled.
 */
async function runCatchup(visibleTurns, overflow, drain = false) {
    const run = beginSummarization();
    if (!run) return;
    const s = getSettings();
    const fullOnly = !drain && !s.strictVerbatimWindow;
    const total = Math.max(1, fullOnly ? Math.floor(overflow / s.turnsPerSummary) : Math.ceil(overflow / s.turnsPerSummary));
    let completed = 0;
    run.backlog = { completed, total };
    updateProcessingUI();
    const toast = toastr.info(`Processing backlog: 0 / ${total}`, 'Summaryception', {
        timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true, onCloseClick: abortSummarization,
    });
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'menu_button sc-toast-cancel-backlog';
    cancelButton.textContent = 'Cancel Backlog';
    cancelButton.addEventListener('click', event => { event.stopPropagation(); abortSummarization(); cancelButton.disabled = true; });
    $(toast).append(cancelButton);
    try {
        while (runIsCurrent(run)) {
            const turns = unsummarizedTurns(run.target.chat, run.target.store);
            const remaining = turns.length - s.verbatimTurns;
            if (remaining <= 0 || (fullOnly && remaining < s.turnsPerSummary)) break;
            if (!await summarizeOneBatchFromTurns(turns.slice(0, remaining), run)) break;
            completed++;
            run.backlog.completed = completed;
            $(toast).find('.toast-message').text(`Processing backlog: ${completed} / ${total} — click × to stop`);
            updateUI();
            await delayWithSignal(TUNING.catchupInterBatchDelay, run.controller.signal);
        }
        if (targetIsCurrent(run.target)) {
            const left = unsummarizedTurns(run.target.chat, run.target.store).length - s.verbatimTurns;
            const stopped = run.controller.signal.aborted || left >= (fullOnly ? s.turnsPerSummary : 1);
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
        <button id="sc_catchup_cancel" class="menu_button"><i class="fa-solid fa-xmark"></i> Cancel</button>
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
        const cancel = () => {
            currentAbortController?.abort();
            clearTimeout(messageReceivedTimer);
            finish('cancel');
        };
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
        overlay.querySelector('#sc_catchup_cancel').addEventListener('click', cancel);
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
    // Merge only the leading run of unpinned snippets so the merged range stays
    // contiguous. Pinned snippets (and a run of one) move up verbatim.
    let runLength = 0;
    while (runLength < Math.min(s.snippetsPerPromotion, layer.length) && !layer[runLength].pinned) runLength++;
    if (!destLayer.length || runLength <= 1) {
        const seed = layer.shift();
        destLayer.push({ ...seed, promoted: true, seedFromLayer: layerIndex });
        invalidateContextCache(store);
    } else {
        // Keep original snippets in storage throughout the request. A failed or
        // canceled promotion cannot temporarily remove history or need a rollback.
        const toMerge = layer.slice(0, runLength);
        const transaction = captureTransaction(run.target, store.summarizedUpTo);
        const inputs = toMerge.map(snippetText);
        const passage = inputs.join(' ');
        const context = buildFullContext(layerIndex + 1);
        const instructions = 'This is historical memory promotion. Preserve identities, durable facts and unresolved threads. Keep events chronological. Do not describe this older passage as the current scene.';
        let text = await callSummarizer(passage, context, instructions);
        if (!text || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return;
        // Deterministic quality gate: deep layers tend to squeeze names out.
        const checkOptions = { protectedNames: parseNameList(s.protectedNames) };
        let check = s.promotionNameCheck ? checkNameRetention(inputs, text, checkOptions) : null;
        if (check && !check.ok) {
            log(`Promotion from L${layerIndex} dropped names: ${check.missing.join(', ')}. Retrying once.`);
            const names = check.missing.slice(0, 30).join(', ');
            const retry = await callSummarizer(passage, context,
                `${instructions} The merged memories name the following, and your output must keep every one of them: ${names}.`);
            if (!runIsCurrent(run) || !transactionIsCurrent(transaction)) return;
            if (retry) {
                const retryCheck = checkNameRetention(inputs, retry, checkOptions);
                if (retryCheck.missing.length <= check.missing.length) { text = retry; check = retryCheck; }
            }
        }
        const ranges = toMerge.map(sn => sn.turnRange).filter(Boolean);
        layer.splice(0, toMerge.length);
        const id = newSnippetId();
        if (s.archivePromotedSnippets) {
            if (!Array.isArray(store.archive)) store.archive = [];
            const archivedAt = Date.now();
            for (const child of toMerge) store.archive.push({ ...child, layer: layerIndex, parentId: id, archivedAt });
        }
        destLayer.push({ id, text, fromLayer: layerIndex, mergedCount: toMerge.length, timestamp: Date.now(),
            ...(s.archivePromotedSnippets ? { childIds: toMerge.map(child => child.id) } : {}),
            ...(ranges.length === toMerge.length ? { turnRange: [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))] } : {}),
            ...(check && !check.ok ? { lossy: true, missingNames: check.missing } : {}),
        });
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
    // Prioritize canonical deepest history, then newest unpromoted events;
    // render accepted snippets in chronological order.
    const deepest = store.layers.findLastIndex(layer => layer?.length);
    const canonicalCount = deepest >= 0 ? store.layers[deepest].length : 0;
    const narrative = snippets.map((sn, order) => ({ text: snippetText(sn), order, pinned: Boolean(sn.pinned) }));
    const ordered = [...narrative.slice(0, canonicalCount), ...narrative.slice(canonicalCount).reverse()];
    // Pinned snippets are selected first; accepted snippets still render chronologically.
    const prioritized = [...ordered.filter(item => item.pinned), ...ordered.filter(item => !item.pinned)];
    return {
        narrative: prioritized,
        template: s.injectionTemplate || defaultSettings.injectionTemplate,
        meter: getMemoryMeter(),
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

let registeredInjectionReport = null;
let injectionMeasurementSequence = 0;

function injectionConfigurationKey() {
    const s = getSettings();
    return JSON.stringify([s.enabled, s.contextBudget, s.contextBudgetUnit, s.injectionTemplate,
        s.injectionPosition, s.injectionDepth, s.injectionRole, s.injectionScan]);
}

function updateInjectionDebugOverlay() {
    let panel = document.getElementById('sc_injection_debug_overlay');
    if (!getSettings().injectionDebugOverlay) { panel?.remove(); return; }
    if (!panel) {
        panel = document.createElement('section');
        panel.id = 'sc_injection_debug_overlay';
        panel.className = 'sc-injection-debug-overlay';
        panel.setAttribute('aria-label', 'Summaryception injection debug overlay');
        panel.innerHTML = `<div class="sc-debug-header"><strong>Summaryception · Injection Debug</strong><button type="button" class="menu_button sc-debug-close" aria-label="Close injection debug overlay">×</button></div>
            <p class="sc-hint">Live registered memory block. Use SillyTavern's Prompt Inspector to inspect the complete final prompt.</p>
            <div class="sc-debug-metadata"></div><pre class="sc-debug-text"></pre>`;
        panel.querySelector('.sc-debug-close').addEventListener('click', () => {
            getSettings().injectionDebugOverlay = false;
            saveSettings();
            $('#sc_injection_debug_overlay_enabled').prop('checked', false);
            panel.remove();
        });
        document.body.appendChild(panel);
    }
    const registered = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME];
    const value = registered?.value || '';
    const report = registeredInjectionReport;
    panel.querySelector('.sc-debug-metadata').textContent = [
        `Position ${registered?.position ?? 'unregistered'} · depth ${registered?.depth ?? '—'} · role ${registered?.role ?? '—'} · World Info scan ${registered?.scan ? 'on' : 'off'}`,
        `${value.length} characters · ${report?.measuredTokens != null ? `${report.measuredTokens} measured tokens` : `~${estimateTokens(value)} estimated tokens`}`,
        report ? `Budget: ${report.meterLabel}. ${report.omittedSnippets} snippets omitted (still stored).` : '',
    ].filter(Boolean).join('\n');
    // Never interpret model/user memory text as markup.
    panel.querySelector('.sc-debug-text').textContent = value || '(No Summaryception injection registered)';
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
    registeredInjectionReport = value ? injectionReports.get(getChatStore()) || null : null;
    updateInjectionDebugOverlay();

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
        toastr.error(`Summary injection failed: ${e.message || e}`, 'Summaryception', { timeOut: TUNING.toastError });
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
    }, TUNING.chatChangedDelay);
}

async function onGenerationStarted(type, options, dryRun) {
    if (promptTogglesHeld && type && !dryRun && type !== 'quiet') {
        toastr.warning('A summary request is using the default connection with prompt toggles temporarily disabled. This reply may be missing your preset prompts; wait for the summary or use a dedicated summarizer connection.', 'Summaryception', { timeOut: TUNING.toastError });
    }
    updateInjection();
    if (!getSettings().enabled) return;
    const ctx = SillyTavern.getContext();
    const tokenizer = ctx.getTokenCountAsync || ctx.getTokenCount;
    if (typeof tokenizer !== 'function' || getSettings().contextBudgetUnit === 'characters') return;
    const target = captureMemoryTarget();
    const through = target.store.summarizedUpTo;
    const transaction = captureTransaction(target, through);
    const configuration = injectionConfigurationKey();
    const sequence = ++injectionMeasurementSequence;
    const report = await assembleBudgetedMemoryAsync(getMemoryAssemblyOptions(), text => tokenizer.call(ctx, text));
    if (!transactionIsCurrent(transaction) || configuration !== injectionConfigurationKey() || sequence !== injectionMeasurementSequence) return;
    injectionReports.set(target.store, report);
    setSummaryceptionExtensionPrompt(report.text);
    $('#sc_preview').val(report.text || '(empty — budget cannot fit a complete memory item)');
    updateInjectionInspector(report.text);
}

function onSourceMessageChanged(index) {
    const hint = Number.isInteger(index) ? index : null;
    if (reconcileMemorySources(hint)) {
        persistMemoryDatabaseChange().catch(error => log('Could not save repaired memory:', error));
    }
    updateInjection();
    updateUI();
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

function setCatchupDismissed(value) {
    catchupDismissed = Boolean(value);
}

export {
    abortSummarization,
    activateCharacterMemoryStore,
    assembleSummaryBlock,
    beginSummarization,
    buildPassageFromRange,
    callSummarizer,
    captureMemoryTarget,
    captureTransaction,
    clearPersistentToast,
    deleteMemoryBank,
    finishSummarization,
    fitContextParts,
    getAllMemoryStores,
    getCharacterMemoryKey,
    getCharacterMemoryLabel,
    getChatStore,
    getContextBudgetCharacters,
    getCurrentChatAttachmentInfo,
    getInjectionDepthValue,
    getMemorySnippetByPath,
    getMemoryStoreByKey,
    getSummarizedRangeStart,
    ghostMessagesUpTo,
    invalidateContextCache,
    isSummarizing,
    normalizeCardFilename,
    normalizeChatStore,
    onChatChanged,
    onGenerationStarted,
    onMessageReceived,
    onSourceMessageChanged,
    persistMemoryDatabaseChange,
    reconcileMemorySources,
    registerSlashCommands,
    registeredInjectionReport,
    repairIfBranched,
    restoreUncoveredGhosts,
    runCatchup,
    runIsCurrent,
    saveChatStore,
    setCatchupDismissed,
    storeRevisions,
    summarizeOneBatch,
    targetIsCurrent,
    transactionIsCurrent,
    truncateMemoryStore,
    unghostAllMessages,
    unsummarizedTurns,
    updateInjection,
    updateInjectionDebugOverlay,
    updateProcessingUI,
};
