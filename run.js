/**
 * Summaryception — summarization run lifecycle, cancellation and stale-result guards
 * AGPL-3.0
 */

import {
    firstSourceChange,
    messageSignature,
} from './source-signatures.js';
import {
    state,
} from './state.js';
import {
    getSettings,
} from './settings.js';
import {
    getCharacterMemoryKey,
    getChatStore,
    storeRevisions,
} from './store.js';
import {
    onMessageReceived,
} from './events.js';

function captureMemoryTarget() {
    const ctx = SillyTavern.getContext();
    return {
        chat: ctx.chat, metadata: ctx.chatMetadata, epoch: state.chatEpoch,
        key: getSettings().separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat',
        store: getChatStore(),
    };
}

function targetIsCurrent(target) {
    const ctx = SillyTavern.getContext();
    const key = getSettings().separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat';
    return target && target.epoch === state.chatEpoch && target.chat === ctx.chat
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
        && !state.currentAbortController?.signal.aborted;
}

function beginSummarization() {
    if (state.isSummarizing) return null;
    state.currentAbortController = new AbortController();
    state.activeRun = { target: captureMemoryTarget(), controller: state.currentAbortController };
    state.isSummarizing = true;
    updateProcessingUI();
    return state.activeRun;
}

function finishSummarization(run) {
    if (state.activeRun !== run) return;
    state.activeRun = null;
    state.currentAbortController = null;
    state.isSummarizing = false;
    updateProcessingUI();
    if (!run.controller.signal.aborted && targetIsCurrent(run.pendingSummaryTarget)) {
        onMessageReceived(run.pendingSummaryMessageIndex);
    }
}

function abortSummarization() {
    clearTimeout(state.messageReceivedTimer);
    if (state.activeRun) delete state.activeRun.pendingSummaryTarget;
    state.currentAbortController?.abort();
    state.catchupDialogClose?.();
    updateProcessingUI();
    // Keep the run locked until its finally block, including promotion/catchup.
}

function updateProcessingUI() {
    const stopping = Boolean(state.activeRun?.controller.signal.aborted);
    $('#sc_stop_summarize').prop('disabled', !state.isSummarizing || stopping);
    $('#sc_force_summarize, #sc_regenerate_latest').prop('disabled', state.isSummarizing);
    $('#sc_backlog_progress').toggle(Boolean(state.activeRun?.backlog));
    $('#sc_cancel_backlog').prop('disabled', stopping);
    if (state.activeRun?.backlog) {
        const { completed, total } = state.activeRun.backlog;
        $('#sc_backlog_status').text(`${stopping ? 'Canceling backlog' : 'Processing backlog'}: ${completed} / ${total} batches saved`);
        $('#sc_backlog_bar').attr('max', Math.max(total, 1)).val(completed);
    }
}

function runIsCurrent(run) {
    return run && state.activeRun === run && !run.controller.signal.aborted && targetIsCurrent(run.target);
}

export {
    abortSummarization,
    beginSummarization,
    captureMemoryTarget,
    captureTransaction,
    finishSummarization,
    runIsCurrent,
    targetIsCurrent,
    transactionIsCurrent,
    updateProcessingUI,
};
