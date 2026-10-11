// Whole-item selection, including wrapper overhead. AGPL-3.0
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
        } catch { /* fall back explicitly; asynchronous tokenizers cannot run here */ }
    }
    return { budget, count: text => Math.ceil(text.length / 4), label: 'estimated tokens (4 characters/token)' };
}

export function wrapMemory(template, summary) {
    const text = String(template || '').trim();
    return text.includes('{{summary}}') ? text.replaceAll('{{summary}}', () => summary) : `${text}\n${summary}`.trim();
}

export function assembleBudgetedMemory({ narrative, facts, state, template, meter, stateAllowance = 600 }) {
    const selectedFacts = [], selectedNarrative = [];
    const stateHeader = state.through >= 0
        ? `State snapshot through message ${state.through} (coverage from ${state.from}); later visible messages take precedence. Manual pins are user corrections.`
        : 'Manual corrections; no validated passage snapshot yet. Later visible messages take precedence.';
    const stateText = () => selectedFacts.length ? `${stateHeader}\n${selectedFacts.map(fact => `${fact.pinned ? `[pin at ${fact.source[1]}] ` : ''}${fact.id}: ${fact.value}`).join('\n')}` : '';
    const body = () => [stateText(), ...[...selectedNarrative].sort((a, b) => a.order - b.order).map(item => item.text)].filter(Boolean).join('\n');
    const fits = () => meter.count(wrapMemory(template, body())) <= meter.budget;
    const allowance = Math.min(meter.budget, meter.label === 'characters' ? stateAllowance * 4 : stateAllowance);
    const priority = { goal: 0, injury: 1, item: 2, location: 3, time: 4, present: 5, relationship: 6, fact: 7 };
    const ordered = [...facts].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
        || priority[a.category] - priority[b.category] || a.id.localeCompare(b.id, 'en'));
    for (const fact of ordered) {
        selectedFacts.push(fact);
        if (meter.count(stateText()) > allowance || !fits()) selectedFacts.pop();
    }
    for (let i = 0; i < narrative.length; i++) {
        const item = typeof narrative[i] === 'string' ? { text: narrative[i], order: i } : narrative[i];
        if (!String(item.text).trim()) continue;
        selectedNarrative.push({ ...item, text: String(item.text).trim() });
        if (!fits()) selectedNarrative.pop();
    }
    return {
        text: body() && fits() ? wrapMemory(template, body()) : '',
        omittedFacts: facts.length - selectedFacts.length,
        omittedSnippets: narrative.length - selectedNarrative.length,
        meterLabel: meter.label,
        stateText: stateText(),
    };
}

// ST's async tokenizer is measured at generation time. Start with a conservative
// estimate, then shrink whole-item selections to satisfy the measured total and
// state allowance. Usually 1–2 calls; no per-fact remote tokenization loop.
export async function assembleBudgetedMemoryAsync(options, countTokens) {
    if (!countTokens || options.meter.label === 'characters') return assembleBudgetedMemory(options);
    const budget = options.meter.budget;
    const allowance = Math.min(budget, options.stateAllowance);
    let trialBudget = budget, trialAllowance = allowance;
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
            const report = assembleBudgetedMemory({ ...options, stateAllowance: trialAllowance,
                meter: { ...options.meter, budget: trialBudget } });
            const [total, stateCount] = await Promise.all([count(report.text), count(report.stateText)]);
            if (total <= budget && stateCount <= allowance) return { ...report, meterLabel: 'tokens (active tokenizer)', measuredTokens: total };
            if (total > budget) trialBudget = Math.max(0, Math.floor(trialBudget * budget / total * 0.9));
            if (stateCount > allowance) trialAllowance = Math.max(0, Math.floor(trialAllowance * allowance / stateCount * 0.9));
        }
        // No valid whole-item fit. Preserve all facts/snippets in storage.
        return { text: '', stateText: '', omittedFacts: options.facts.length,
            omittedSnippets: options.narrative.length, meterLabel: 'tokens (active tokenizer)', measuredTokens: 0 };
    } catch {
        const fallback = assembleBudgetedMemory(options);
        return { ...fallback, meterLabel: `${options.meter.label}; tokenizer unavailable` };
    }
}
