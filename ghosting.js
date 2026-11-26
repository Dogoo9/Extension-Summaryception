/**
 * Summaryception — message hiding (/hide, /unhide) and source-change repair
 * AGPL-3.0
 */

import {
    firstSourceChange,
} from './source-signatures.js';
import {
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
    getSummarizedRangeStart,
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

// The sc_ghosted flag on each message is the only record of what Summaryception
// hid. store.ghostedIndices is derived from it (for display and old saves) and
// is rebuilt after every visibility change instead of being trusted.
function flaggedIndices(chat) {
    return (chat || []).flatMap((msg, i) => msg?.extra?.sc_ghosted ? [i] : []);
}

function syncGhostedIndices(store, chat) {
    if (store) store.ghostedIndices = flaggedIndices(chat);
}

function toRanges(indices) {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const ranges = [];
    for (const i of sorted) {
        const last = ranges.at(-1);
        if (last && i === last[1] + 1) last[1] = i;
        else ranges.push([i, i]);
    }
    return ranges;
}

// One /hide or /unhide per contiguous run: SillyTavern saves the chat after each
// command, so per-message commands made long chats slow to clear. Runs only ever
// contain messages this extension owns, so a range never touches anything else.
// A failed range is retried message by message. Returns the indices that changed.
async function setRangeVisibility(start, end, hide) {
    const run = async arg => {
        await SillyTavern.getContext().executeSlashCommandsWithOptions(`/${hide ? 'hide' : 'unhide'} ${arg}`, { showOutput: false });
    };
    try {
        await run(start === end ? `${start}` : `${start}-${end}`);
        return Array.from({ length: end - start + 1 }, (_, k) => start + k);
    } catch (e) {
        if (start === end) {
            log(`Failed to ${hide ? 'hide' : 'unhide'} message ${start}:`, e);
            return [];
        }
    }
    const done = [];
    for (let i = start; i <= end; i++) {
        try { await run(`${i}`); done.push(i); } catch (e) { log(`Failed to ${hide ? 'hide' : 'unhide'} message ${i}:`, e); }
    }
    return done;
}

/**
 * Unhide every message Summaryception hid. A message keeps its flag until its
 * /unhide succeeds, so a failure never leaves it hidden and unowned.
 */
async function unghostAllMessages(storeOverride = null) {
    const { chat } = SillyTavern.getContext();
    const store = storeOverride ? normalizeChatStore(storeOverride) : getChatStore();
    const target = captureMemoryTarget();
    const flagged = flaggedIndices(chat);
    const hidden = flagged.filter(i => chat[i].is_system);
    // Flagged but visible (hiding disabled, or unhidden by hand): just release.
    for (const i of flagged) if (!chat[i].is_system) delete chat[i].extra.sc_ghosted;
    if (!hidden.length) { syncGhostedIndices(store, chat); return; }

    const progressToast = toastr.info(
        `Unhiding messages: 0 / ${hidden.length}`,
        'Summaryception — Clearing',
        { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false },
    );
    let processed = 0;
    let failed = 0;
    try {
        for (const [start, end] of toRanges(hidden)) {
            if (!targetIsCurrent(target)) return;
            const done = await setRangeVisibility(start, end, false);
            if (target.chat !== SillyTavern.getContext().chat) return;
            for (const i of done) delete chat[i]?.extra?.sc_ghosted;
            failed += end - start + 1 - done.length;
            processed += end - start + 1;
            const pct = Math.round((processed / hidden.length) * 100);
            $(progressToast).find('.toast-message').text(`Unhiding messages: ${processed} / ${hidden.length} (${pct}%)`);
        }
        log(`Unghosted ${hidden.length - failed} messages (only Summaryception-hidden ones)`);
        if (failed) toastr.warning(`${failed} message(s) could not be unhidden. They stay marked, so Clear Memory or Repair can try again.`, 'Summaryception');
    } finally {
        syncGhostedIndices(store, chat);
        clearPersistentToast(progressToast);
    }
}

/**
 * Clear Summaryception's flag from messages outside [startIndex, endIndex], and
 * from messages inside it whose visibility does not match the hiding setting
 * (ghostMessagesUpTo then re-marks those). Matching messages are left untouched.
 */
async function releaseStaleGhosts(startIndex, endIndex, target = captureMemoryTarget()) {
    const { chat, store } = target;
    const hide = !getSettings().disableGhosting;
    const toUnhide = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg?.extra?.sc_ghosted) continue;
        const hidden = Boolean(msg.is_system);
        if (i >= startIndex && i <= endIndex && hidden === hide) continue;
        if (hidden) toUnhide.push(i);
        else delete msg.extra.sc_ghosted;
    }
    for (const [start, end] of toRanges(toUnhide)) {
        if (!targetIsCurrent(target)) break;
        for (const i of await setRangeVisibility(start, end, false)) delete chat[i]?.extra?.sc_ghosted;
    }
    syncGhostedIndices(store, chat);
}

async function ghostMessagesUpTo(endIndex, startIndex = 0, target = captureMemoryTarget()) {
    const { chat, store } = target;
    const s = getSettings();

    const rangeStart = Math.max(0, Number.isInteger(startIndex) ? startIndex : 0);
    const rangeEnd = Math.min(chat.length - 1, Number.isInteger(endIndex) ? endIndex : -1);
    if (rangeStart > rangeEnd) return;

    const eligible = [];
    for (let i = rangeStart; i <= rangeEnd; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.extra?.sc_ghosted) continue;      // already ours
        if (msg.is_system) continue;              // hidden by the user, or a system message
        if (msg.is_hidden) {                      // legacy hidden marker
            log(`Skipping message ${i} — already hidden by user`);
            continue;
        }
        eligible.push(i);
    }

    const revision = storeRevisions.get(store) || 0;
    // Finish visibility for an already committed batch even after Stop.
    // A source repair, card switch, clear, or disable still invalidates this work.
    const stillWanted = () => targetIsCurrent(target) && revision === (storeRevisions.get(store) || 0) && s.enabled;
    const covers = i => targetIsCurrent(target) && s.enabled
        && i <= store.summarizedUpTo && i >= getSummarizedRangeStart(store);
    let newlyGhosted = 0;

    for (const [start, end] of toRanges(eligible)) {
        if (!stillWanted()) break;
        const done = s.disableGhosting
            ? Array.from({ length: end - start + 1 }, (_, k) => start + k)
            : await setRangeVisibility(start, end, true);
        // The chat closed while /hide ran: mark what was hidden so the old chat
        // still owns it, and stop (indices would now point into the new chat).
        const chatChanged = target.chat !== SillyTavern.getContext().chat;
        // Memory was cleared or rolled back while /hide ran: put those messages back.
        const unwanted = chatChanged ? [] : done.filter(i => !covers(i));
        if (unwanted.length && !s.disableGhosting) {
            for (const [a, b] of toRanges(unwanted)) await setRangeVisibility(a, b, false);
        }
        for (const i of done) {
            if (unwanted.includes(i)) continue;
            chat[i].extra ||= {};
            chat[i].extra.sc_ghosted = true;
            newlyGhosted++;
        }
        if (chatChanged || unwanted.length) break;
    }

    syncGhostedIndices(store, chat);
    log(`Ghosted messages ${rangeStart}–${rangeEnd} (${newlyGhosted} newly marked)${s.disableGhosting ? ' (hiding disabled — metadata only)' : ''}`);
}

/**
 * Detect chat branches that copied Summaryception metadata past the new chat's
 * end and trim stale snippets/ghost markers from every memory bank.
 */
// First message any snippet was built from. Messages before it were skipped
// (Skip Backlog), not summarized. Snippets without a range have unknown sources.
function firstSourceIndex(store) {
    const snippets = store.layers.flat();
    if (!snippets.length) return store.summarizedUpTo + 1;
    const starts = snippets.map(sn => sn.turnRange?.[0]);
    return starts.every(Number.isInteger) ? Math.min(...starts) : 0;
}

function truncateMemoryStore(store, dirty) {
    const skippedThrough = firstSourceIndex(store) - 1;
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
    // Rolling back summaries must not bring a skipped backlog back.
    store.summarizedUpTo = Math.max(store.summarizedUpTo, Math.min(skippedThrough, dirty - 1));
    store.sourceSignatures.length = Math.max(0, store.summarizedUpTo + 1);
    store.ghostedIndices = store.ghostedIndices.filter(i => i <= store.summarizedUpTo);
    // A state version built from a changed message is dropped with it.
    if (Array.isArray(store.stateHistory)) store.stateHistory = store.stateHistory.filter(entry => entry.through < dirty);
    invalidateContextCache(store);
    if (store.lastBatch?.range?.[1] >= dirty) delete store.lastBatch;
}

// Synchronous (source repair runs inside prompt assembly), so it updates the
// message and its rendered block the way /unhide would.
function restoreUncoveredGhosts() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const start = getSummarizedRangeStart(store);
    const end = store.summarizedUpTo;
    const hidingDisabled = getSettings().disableGhosting;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message?.extra?.sc_ghosted || (i >= start && i <= end)) continue;
        delete message.extra.sc_ghosted;
        if (hidingDisabled) continue;
        delete message.is_hidden;
        if (message.is_system) {
            message.is_system = false;
            $(`#chat .mes[mesid="${i}"]`).attr('is_system', 'false');
        }
    }
    syncGhostedIndices(store, chat);
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
        if (Number.isInteger(changedHint) && changedHint >= firstSourceIndex(store)
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
    flaggedIndices,
    ghostMessagesUpTo,
    reconcileMemorySources,
    releaseStaleGhosts,
    repairIfBranched,
    restoreUncoveredGhosts,
    truncateMemoryStore,
    unghostAllMessages,
};
