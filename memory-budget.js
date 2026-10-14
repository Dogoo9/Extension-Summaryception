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

export function assembleBudgetedMemory({ narrative, template, meter }) {
    const selected = [];
    const body = () => [...selected].sort((a, b) => a.order - b.order).map(item => item.text).join('\n');
    const fits = () => meter.count(wrapMemory(template, body())) <= meter.budget;
    for (let i = 0; i < narrative.length; i++) {
        const item = typeof narrative[i] === 'string' ? { text: narrative[i], order: i } : narrative[i];
        if (!String(item.text).trim()) continue;
        selected.push({ ...item, text: String(item.text).trim() });
        if (!fits()) selected.pop();
    }
    return {
        text: body() && fits() ? wrapMemory(template, body()) : '',
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
