/**
 * Summaryception — current-state block
 *
 * A short plain-text record of how the story stands as of the last summarized
 * message (where/when, who is present, situation, open threads). After each
 * batch it is rewritten whole by one small summarizer call, from the previous
 * record plus what was summarized since. Nothing is merged or tracked by ID, so
 * a bad update is simply replaced by the next one.
 *
 * Each bank keeps its last few versions in store.stateHistory, each tagged with
 * the last message it covers. A source edit or rollback drops versions past the
 * changed message; if none are left, the block is empty until the next batch.
 * AGPL-3.0
 */

import {
    defaultSettings,
} from './constants.js';
import {
    state,
} from './state.js';
import {
    getSettings,
    log,
} from './settings.js';
import {
    getChatStore,
    getSummarizedRangeStart,
    invalidateContextCache,
    saveChatStore,
    snippetText,
} from './store.js';
import {
    buildPassageFromRange,
    fitContextParts,
    getContextBudgetCharacters,
} from './passages.js';
import {
    beginSummarization,
    captureTransaction,
    finishSummarization,
    runIsCurrent,
    transactionIsCurrent,
} from './run.js';
import {
    callSummarizer,
} from './summarize.js';
import {
    updateInjection,
} from './injection.js';
import {
    updateUI,
} from './settings-ui.js';

const STATE_HISTORY_LIMIT = 6;

function currentSceneState(store) {
    const history = store?.stateHistory;
    return Array.isArray(history) && history.length ? history[history.length - 1] : null;
}

function stateTokenLimit(settings = getSettings()) {
    return Math.max(50, Math.floor(Number(settings.stateBlockTokenLimit) || defaultSettings.stateBlockTokenLimit));
}

function pushSceneState(store, entry) {
    if (!Array.isArray(store.stateHistory)) store.stateHistory = [];
    store.stateHistory.push(entry);
    if (store.stateHistory.length > STATE_HISTORY_LIMIT) store.stateHistory.splice(0, store.stateHistory.length - STATE_HISTORY_LIMIT);
    invalidateContextCache(store);
}

/**
 * What the next update reads: the newest summarized batch as original
 * messages, and memory bullets for anything summarized between the previous
 * record and that batch (bounded by the memory budget, newest kept first).
 */
function sceneStateInput(store, chat, { force = false } = {}) {
    const to = store.summarizedUpTo;
    const start = getSummarizedRangeStart(store);
    if (to < start) return null;
    const previous = currentSceneState(store);
    let from = previous ? Math.max(previous.through + 1, start) : start;
    const ranged = store.layers.flat().filter(sn => Array.isArray(sn.turnRange) && sn.turnRange[1] <= to);
    const newest = ranged.reduce((best, sn) => (!best || sn.turnRange[1] > best.turnRange[1]
        || (sn.turnRange[1] === best.turnRange[1] && sn.turnRange[0] > best.turnRange[0]) ? sn : best), null);
    const newestStart = newest ? Math.max(start, newest.turnRange[0]) : from;
    if (to < from) {
        if (!force) return null;
        from = newestStart;
    }
    const rawStart = Math.max(from, Math.min(newestStart, to));
    const budget = getContextBudgetCharacters();
    // With speaker names: "Present" needs them, and "Player"/"Assistant" alone loses them.
    let passage = buildPassageFromRange(chat, rawStart, to, true);
    if (passage.length > budget * 2) {
        // Keep the end of an oversized passage, cut at a line boundary.
        const tail = passage.slice(-budget * 2);
        passage = tail.slice(tail.indexOf('\n') + 1);
    }
    const parts = ranged
        .filter(sn => sn.turnRange[1] >= from && sn.turnRange[0] < rawStart)
        .sort((a, b) => a.turnRange[0] - b.turnRange[0])
        .map((sn, order) => ({ text: snippetText(sn), order }));
    const earlier = fitContextParts([...parts].reverse(), budget)
        .sort((a, b) => a.order - b.order).map(part => part.text).join('\n');
    if (!passage.trim() && !earlier.trim()) return null;
    return { to, passage: passage || '(none)', earlier: earlier || '(none)', previous: previous?.text?.trim() || '' };
}

/** Rewrite the active bank's state record inside an existing run. */
async function updateSceneState(run, { force = false } = {}) {
    const s = getSettings();
    if (!s.stateBlockEnabled || !runIsCurrent(run)) return false;
    const { chat, store } = run.target;
    const input = sceneStateInput(store, chat, { force });
    if (!input) return false;
    const transaction = captureTransaction(run.target, input.to);
    const text = await callSummarizer(input.passage, input.earlier, {
        template: s.stateBlockPrompt?.trim() ? s.stateBlockPrompt : defaultSettings.stateBlockPrompt,
        systemPrompt: s.stateBlockSystemPrompt?.trim() ? s.stateBlockSystemPrompt : defaultSettings.stateBlockSystemPrompt,
        variables: { previous_state: input.previous || '(none yet)', word_limit: Math.round(stateTokenLimit(s) * 0.75) },
        failureLabel: 'Current-state update failed',
        failureHint: 'Summaries are saved; the state is updated again after the next batch.',
    });
    if (!text || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return false;
    pushSceneState(store, { text, through: input.to, timestamp: Date.now() });
    await saveChatStore();
    log(`Current state updated through message ${input.to}`);
    return true;
}

/** Memory Database / slash command: update now, even when nothing new was summarized. */
async function refreshSceneState() {
    const s = getSettings();
    if (!s.enabled) { toastr.warning('Enable Summaryception first.', 'Summaryception'); return false; }
    if (!s.stateBlockEnabled) { toastr.warning('Turn on the current-state block first (Memory tab).', 'Summaryception'); return false; }
    if (state.isSummarizing) { toastr.warning('Stop the current run before updating the state.', 'Summaryception'); return false; }
    const run = beginSummarization();
    if (!run) return false;
    try {
        if (!sceneStateInput(run.target.store, run.target.chat, { force: true })) {
            toastr.info('Nothing has been summarized yet, so there is no state to build.', 'Summaryception');
            return false;
        }
        const ok = await updateSceneState(run, { force: true });
        if (ok) toastr.success('Current state updated.', 'Summaryception');
        return ok;
    } finally {
        finishSummarization(run);
        updateInjection();
        updateUI();
    }
}

/** A hand edit replaces the newest version; the next update starts from it. */
function editSceneState(store, text) {
    const value = String(text || '').trim();
    const latest = currentSceneState(store);
    if (!value) {
        if (latest) store.stateHistory.pop();
        invalidateContextCache(store);
        return;
    }
    if (latest) {
        Object.assign(latest, { text: value, edited: true, timestamp: Date.now() });
        invalidateContextCache(store);
    } else {
        pushSceneState(store, { text: value, through: store.summarizedUpTo, edited: true, timestamp: Date.now() });
    }
}

/**
 * The injected block, trimmed by whole lines from the end to fit its cap.
 * Empty when the feature is off, no record exists, or the first line alone
 * does not fit.
 */
function sceneStateInjectionText(store, meter) {
    if (!getSettings().stateBlockEnabled) return '';
    const latest = currentSceneState(store);
    if (!latest?.text?.trim()) return '';
    const limit = stateTokenLimit();
    const cap = meter.label === 'characters' ? limit * 4 : limit;
    const wrap = body => `<current_state as_of_message="${latest.through}">\n[How the story stands as of message ${latest.through}. Messages after it take precedence.]\n${body}\n</current_state>`;
    const lines = latest.text.trim().split('\n');
    while (lines.length > 1 && meter.count(wrap(lines.join('\n'))) > cap) lines.pop();
    const text = wrap(lines.join('\n'));
    return meter.count(text) > cap ? '' : text;
}

function activeSceneState() {
    return currentSceneState(getChatStore());
}

export {
    STATE_HISTORY_LIMIT,
    activeSceneState,
    currentSceneState,
    editSceneState,
    refreshSceneState,
    sceneStateInjectionText,
    sceneStateInput,
    updateSceneState,
};
