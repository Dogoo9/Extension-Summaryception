/**
 * Summaryception — message hiding (/hide, /unhide) and source-change repair
 * AGPL-3.0
 */

import {
    firstSourceChange,
} from './source-signatures.js';
import {
    LOG_PREFIX,
    TUNING,
} from './constants.js';
import {
    getSettings,
    log,
} from './settings.js';
import {
    clearPersistentToast,
} from './util.js';
import {
    getAllMemoryStores,
    getChatStore,
    invalidateContextCache,
    normalizeChatStore,
    recalculateSummarizedUpTo,
    saveChatStore,
    storeRevisions,
} from './store.js';
import {
    abortSummarization,
    captureMemoryTarget,
    targetIsCurrent,
} from './run.js';

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

export {
    ghostMessagesUpTo,
    reconcileMemorySources,
    repairIfBranched,
    restoreUncoveredGhosts,
    truncateMemoryStore,
    unghostAllMessages,
};
