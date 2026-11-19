// Whole-snippet selection, including wrapper overhead. AGPL-3.0
export function createMeter(settings, countTokens) {
    const budget = Math.max(1, Math.floor(Number(settings.contextBudget) || 4096));
    if (settings.contextBudgetUnit === 'characters') return { budget, count: text => text.length, label: 'characters' };
    if (typeof countTokens === 'function') {
        try {
            const count = text => {
                const n = countTokens(text);
                if (n && typeof n.then === 'function') {
                    n.catch(() => {});
                    throw new Error('Async tokenizer requires generation-time measurement');
                }
                if (!Number.isFinite(n) || n < 0) throw new Error('Tokenizer unavailable');
                return Math.ceil(n);
            };
            count('Summaryception');
            return { budget, count, label: 'tokens (active tokenizer)' };
        } catch { /* fall back explicitly */ }
    }
    return { budget, count: text => Math.ceil(text.length / 4), label: 'estimated tokens (4 characters/token)' };
}

export function wrapMemory(template, summary) {
    const text = String(template || '').trim();
    return text.includes('{{summary}}') ? text.replaceAll('{{summary}}', () => summary) : `${text}\n${summary}`.trim();
}

// Pinned items, then newest items up to half the budget, then the deepest layer
// oldest-first, then any remaining newest items. Returned in chronological order.
export function selectWithRecencyReserve(items, budget, measure) {
    const chronological = order => [...order].sort((a, b) => a.order - b.order);
    const selected = new Set();
    const tryAdd = (item, limit) => {
        if (selected.has(item)) return true;
        selected.add(item);
        if (measure(chronological(selected)) <= limit) return true;
        selected.delete(item);
        return false;
    };
    for (const item of items) if (item.pinned) tryAdd(item, budget);
    const unpinned = chronological(items.filter(item => !item.pinned));
    const newest = [...unpinned].reverse();
    // The newest item may use the whole budget, so it is never crowded out by the reserve limit.
    if (newest.length) tryAdd(newest[0], budget);
    for (const item of newest.slice(1)) if (!tryAdd(item, budget / 2)) break;
    for (const item of unpinned) if (item.canonical) tryAdd(item, budget);
    for (const item of newest) tryAdd(item, budget);
    return chronological(selected);
}

export function assembleBudgetedMemory({ narrative, template, meter }) {
    const items = narrative
        .map((entry, i) => (typeof entry === 'string' ? { text: entry, order: i } : entry))
        .filter(item => String(item.text).trim())
        .map(item => ({ ...item, text: String(item.text).trim() }));
    const body = list => list.map(item => item.text).join('\n');
    const selected = selectWithRecencyReserve(items, meter.budget, list => meter.count(wrapMemory(template, body(list))));
    return {
        text: selected.length ? wrapMemory(template, body(selected)) : '',
        omittedSnippets: narrative.length - selected.length,
        meterLabel: meter.label,
    };
}

// Measure ST's async tokenizer before generation and shrink whole-snippet
// selections if necessary. All omitted snippets remain in storage.
export async function assembleBudgetedMemoryAsync(options, countTokens) {
    if (!countTokens || options.meter.label === 'characters') return assembleBudgetedMemory(options);
    const budget = options.meter.budget;
    let trialBudget = budget;
    const cache = new Map();
    const count = async text => {
        if (!text) return 0;
        if (cache.has(text)) return cache.get(text);
        const result = await countTokens(text);
        if (!Number.isFinite(result) || result < 0) throw new Error('Invalid token count');
        cache.set(text, Math.ceil(result));
        return Math.ceil(result);
    };
    try {
        for (let attempt = 0; attempt < 8; attempt++) {
            const report = assembleBudgetedMemory({ ...options, meter: { ...options.meter, budget: trialBudget } });
            const total = await count(report.text);
            if (total <= budget) return { ...report, meterLabel: 'tokens (active tokenizer)', measuredTokens: total };
            trialBudget = Math.max(0, Math.floor(trialBudget * budget / total * 0.9));
        }
        return { text: '', omittedSnippets: options.narrative.length,
            meterLabel: 'tokens (active tokenizer)', measuredTokens: 0 };
    } catch {
        const fallback = assembleBudgetedMemory(options);
        return { ...fallback, meterLabel: `${options.meter.label}; tokenizer unavailable` };
    }
}

/**
 * How many of the oldest unsummarized replies must go to fit the verbatim token
 * limit. The newest `keep` replies always stay. Tokens are estimated at 4 characters.
 */
export function turnsOverTokenBudget({ chat, turns, from, budget, keep = 2 }) {
    if (!(budget > 0)) return 0;
    const tokens = message => (message?.is_system && !message.extra?.sc_ghosted) ? 0 : Math.ceil(String(message?.mes || '').length / 4);
    let total = 0;
    for (let i = from; i < chat.length; i++) total += tokens(chat[i]);
    let cursor = from;
    let count = 0;
    while (total > budget && count < turns.length - keep) {
        for (; cursor <= turns[count].index; cursor++) total -= tokens(chat[cursor]);
        count++;
    }
    return count;
}
