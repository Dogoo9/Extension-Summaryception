/**
 * Summaryception — turn selection, passage building and summarizer context
 * AGPL-3.0
 */

import {
    defaultSettings,
} from './constants.js';
import {
    getSettings,
    trace,
} from './settings.js';
import {
    assembledContextCache,
    getChatStore,
    snippetText,
} from './store.js';

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

function unsummarizedTurns(chat, store) {
    return getAssistantTurns(chat).filter(turn => turn.index > store.summarizedUpTo
        && !(chat[turn.index].is_hidden && !chat[turn.index].extra?.sc_ghosted));
}

export {
    buildFullContext,
    buildPassageFromRange,
    cleanSummarizerOutput,
    debugVisibleTurns,
    fitContextParts,
    getContextBudgetCharacters,
    unsummarizedTurns,
};
