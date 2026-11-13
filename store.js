/**
 * Summaryception — memory banks: storage, normalization, character-card identity and migration
 * AGPL-3.0
 */

import {
    MODULE_NAME,
} from './constants.js';
import {
    state,
} from './state.js';
import {
    getSettings,
    log,
} from './settings.js';
import {
    ghostMessagesUpTo,
    unghostAllMessages,
} from './ghosting.js';
import {
    abortSummarization,
    captureMemoryTarget,
    targetIsCurrent,
} from './run.js';
import {
    updateInjection,
} from './injection.js';
import {
    updateUI,
} from './settings-ui.js';

const shownMigrationWarnings = new Set();

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

async function activateCharacterMemoryStore() {
    const s = getSettings();
    const store = getChatStore();
    const target = captureMemoryTarget();
    // getChatStore() selects the active bank on reads, so activeMemoryKey cannot
    // reliably identify the bank that currently owns the message flags.
    if (!state.displayedMemoryBank || state.displayedMemoryBank.chat !== target.chat || state.displayedMemoryBank.store !== store) {
        await unghostAllMessages(createEmptyChatStore());
    }
    if (!targetIsCurrent(target)) return;
    if (s.enabled && store.summarizedUpTo >= 0) {
        await ghostMessagesUpTo(store.summarizedUpTo, getSummarizedRangeStart(store), target);
    }
    state.displayedMemoryBank = { chat: target.chat, store };
}

async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

async function clearActiveMemory() {
    abortSummarization();
    const target = captureMemoryTarget();
    const store = target.store;
    store.layers = [];
    store.archive = [];
    store.summarizedUpTo = -1;
    store.sourceSignatures = [];
    delete store.lastBatch;
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
    if (store.archive != null) {
        if (!Array.isArray(store.archive)) throw new Error('Invalid snippet archive.');
        for (const entry of store.archive) {
            if (!entry || typeof entry.text !== 'string' || !Number.isInteger(entry.layer) || entry.layer < 0) throw new Error('Invalid archived snippet.');
            if (entry.turnRange && !(Array.isArray(entry.turnRange) && entry.turnRange.length === 2
                && entry.turnRange.every(Number.isInteger) && entry.turnRange[0] >= 0
                && entry.turnRange[1] >= entry.turnRange[0])) throw new Error('Invalid archived snippet source range.');
        }
    }
    if (store.summarizedUpTo != null && (!Number.isInteger(store.summarizedUpTo) || store.summarizedUpTo < -1)) {
        throw new Error('Invalid summarized cutoff.');
    }
    return normalizeChatStore(store);
}

export {
    activateCharacterMemoryStore,
    assembledContextCache,
    clearActiveMemory,
    deleteMemoryBank,
    getAllMemoryStores,
    getCharacterMemoryKey,
    getCharacterMemoryLabel,
    getChatStore,
    getCurrentChatAttachmentInfo,
    getMemorySnippetByPath,
    getMemoryStoreByKey,
    getPlayerName,
    getSummarizedRangeStart,
    injectionReports,
    invalidateContextCache,
    newSnippetId,
    normalizeCardFilename,
    normalizeChatStore,
    persistMemoryDatabaseChange,
    recalculateSummarizedUpTo,
    saveChatStore,
    snippetText,
    storeRevisions,
    validateMemoryImport,
};
