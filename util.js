/**
 * Summaryception — retry, delay and toast helpers
 * AGPL-3.0
 */

import {
    RETRY_CONFIG,
} from './constants.js';
import {
    log,
} from './settings.js';

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

function delayWithSignal(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export {
    clearPersistentToast,
    delayWithSignal,
    escapeHtml,
    isRetryableError,
    parseRetryAfter,
};
