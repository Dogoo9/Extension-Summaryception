/**
 * Summaryception — summarizer calls, batching, catch-up and layer promotion
 * AGPL-3.0
 */

import {
    sendSummarizerRequest,
} from './connectionutil.js';
import {
    checkNameRetention,
    parseNameList,
} from './name-check.js';
import {
    LOG_PREFIX,
    RETRY_CONFIG,
    TUNING,
} from './constants.js';
import {
    state,
} from './state.js';
import {
    getSettings,
    log,
} from './settings.js';
import {
    clearPersistentToast,
    delayWithSignal,
    isRetryableError,
    parseRetryAfter,
} from './util.js';
import {
    getPlayerName,
    invalidateContextCache,
    newSnippetId,
    saveChatStore,
    snippetText,
    storeRevisions,
} from './store.js';
import {
    ghostMessagesUpTo,
} from './ghosting.js';
import {
    buildFullContext,
    buildPassageFromRange,
    cleanSummarizerOutput,
    debugVisibleTurns,
    fitContextParts,
    getContextBudgetCharacters,
    unsummarizedTurns,
} from './passages.js';
import {
    abortSummarization,
    beginSummarization,
    captureMemoryTarget,
    captureTransaction,
    finishSummarization,
    runIsCurrent,
    targetIsCurrent,
    transactionIsCurrent,
    updateProcessingUI,
} from './run.js';
import {
    disableAllPromptToggles,
    restorePromptToggles,
    snapshotPromptToggles,
} from './prompt-toggles.js';
import {
    updateInjection,
} from './injection.js';
import {
    updateUI,
} from './settings-ui.js';

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
        state.promptTogglesHeld = true;
    };
    const releaseToggles = () => {
        if (!snapshot) return;
        restorePromptToggles(snapshot);
        snapshot = null;
        state.promptTogglesHeld = false;
    };
    const parent = state.currentAbortController?.signal;
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

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled || s.pauseSummarization || state.isSummarizing) return;
    const target = captureMemoryTarget();
    if (s.debugMode && s.traceMode) debugVisibleTurns(target.chat, target.store);
    const visible = unsummarizedTurns(target.chat, target.store);
    const overflow = visible.length - s.verbatimTurns;
    if (overflow <= 0) return;
    if (overflow > s.turnsPerSummary * TUNING.backlogMultiplier && !state.catchupDismissed) {
        const run = beginSummarization();
        if (!run) return;
        let choice;
        try { choice = await showCatchupDialog(overflow, Math.ceil(overflow / s.turnsPerSummary)); }
        finally { finishSummarization(run); }
        if (!targetIsCurrent(target) || run.controller.signal.aborted) return;
        if (choice === 'skip') {
            target.store.summarizedUpTo = visible[overflow - 1].index;
            invalidateContextCache(target.store);
            state.catchupDismissed = true;
            await saveChatStore();
            return;
        }
        if (choice === 'catchup') return runCatchup(visible, overflow);
        if (choice !== 'partial') return;
        state.catchupDismissed = true;
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

async function summarizeOneBatchFromTurns(visibleTurns, run = state.activeRun) {
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
            if (state.catchupDialogClose === cancel) state.catchupDialogClose = null;
            resolve(choice);
        };
        const cancel = () => {
            state.currentAbortController?.abort();
            clearTimeout(state.messageReceivedTimer);
            finish('cancel');
        };
        const keyHandler = event => { if (event.key === 'Escape') cancel(); };
        state.catchupDialogClose = cancel;
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

async function maybePromoteLayer(layerIndex, run = state.activeRun) {
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

// Regenerate from originals, with bounded earlier context and an atomic commit.
// A canceled/failed multi-snippet run keeps every original snippet.
async function regenerateSnippets(snippets) {
    if (!getSettings().enabled) { toastr.warning('Enable Summaryception first.', 'Summaryception'); return false; }
    if (state.isSummarizing) { toastr.warning('Stop the current run before regenerating.', 'Summaryception'); return false; }
    const target = captureMemoryTarget();
    const validRange = sn => Array.isArray(sn.turnRange) && sn.turnRange.length === 2
        && sn.turnRange.every(Number.isInteger) && sn.turnRange[0] >= 0
        && sn.turnRange[1] >= sn.turnRange[0] && sn.turnRange[1] < target.chat.length;
    if (!snippets.length || snippets.some(sn => !validRange(sn) || !target.store.layers.flat().includes(sn))) {
        toastr.warning('No summaries with available original messages to regenerate.', 'Summaryception');
        return false;
    }
    const ordered = [...snippets].sort((a, b) => a.turnRange[0] - b.turnRange[0]);
    const through = Math.max(target.store.summarizedUpTo, ...ordered.map(sn => sn.turnRange[1]));
    const run = beginSummarization();
    if (!run) return false;
    const transaction = captureTransaction(target, through);
    const replacements = new Map();
    const toast = toastr.info(`Regenerating ${ordered.length} summary snippet(s)… Use Stop to cancel.`, 'Summaryception', { timeOut: 0, extendedTimeOut: 0 });
    try {
        for (const sn of ordered) {
            const [start, end] = sn.turnRange;
            const passage = buildPassageFromRange(target.chat, start, end);
            if (!passage.trim()) { toastr.warning('Source messages are empty or hidden. Original summaries kept.', 'Summaryception'); return false; }
            const prior = target.store.layers.flat().filter(item => validRange(item) && item.turnRange[1] < start)
                .sort((a, b) => a.turnRange[0] - b.turnRange[0])
                .map((item, order) => ({ text: replacements.get(item) || item.text, order }));
            // Prefer recent earlier context, then render it chronologically.
            const context = fitContextParts(prior.reverse(), getContextBudgetCharacters())
                .sort((a, b) => a.order - b.order).map(item => item.text).join(' ') || '(none yet)';
            const text = await callSummarizer(passage, context);
            if (!text || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return false;
            replacements.set(sn, text);
            $(toast).find('.toast-message').text(`Regenerating summaries: ${replacements.size} / ${ordered.length} — Use Stop to cancel`);
        }
        const originals = new Map([...replacements.keys()].map(sn => [sn, { ...sn }]));
        for (const [sn, text] of replacements) {
            Object.assign(sn, { text, timestamp: Date.now(), regenerated: true });
            delete sn.lossy;
            delete sn.missingNames;
        }
        invalidateContextCache(target.store);
        const committedRevision = storeRevisions.get(target.store);
        try {
            await saveChatStore();
        } catch (error) {
            // Restore local originals on persistence failure without overwriting
            // an edit/source repair that occurred while saving.
            if (storeRevisions.get(target.store) === committedRevision) {
                for (const [sn, original] of originals) {
                    delete sn.timestamp;
                    delete sn.regenerated;
                    Object.assign(sn, original);
                }
                invalidateContextCache(target.store);
            }
            throw error;
        }
        toastr.success(`${replacements.size} summary snippet(s) regenerated.`, 'Summaryception');
        return true;
    } catch (error) {
        toastr.error(`Regeneration failed: ${error.message}. Check saved memory before continuing.`, 'Summaryception');
        return false;
    } finally {
        clearPersistentToast(toast);
        finishSummarization(run);
        updateInjection(); updateUI();
    }
}

export {
    maybeSummarizeTurns,
    regenerateSnippets,
    runCatchup,
    summarizeOneBatch,
};
