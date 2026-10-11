// Pure, backend-independent state maintenance. AGPL-3.0
export const STATE_VERSION = 1;
export const MAX_CHECKPOINTS = 12;
export const MAX_FACTS = 256;
const CATEGORIES = ['location', 'time', 'present', 'relationship', 'item', 'injury', 'goal', 'fact'];
const ID = /^[a-z][a-z0-9_.:-]{0,95}$/;

export function emptyState() {
    return { version: STATE_VERSION, through: -1, from: 0, facts: [], overrides: [], checkpoints: [] };
}

function requireValue(ok, message) {
    if (!ok) throw new Error(`Invalid state response: ${message}`);
}

function validRange(range) {
    return Array.isArray(range) && range.length === 2 && range.every(Number.isInteger)
        && range[0] >= 0 && range[1] >= range[0];
}

function validateFact(fact, through) {
    requireValue(fact && ID.test(fact.id), 'invalid fact id');
    requireValue(CATEGORIES.includes(fact.category), 'unknown fact category');
    requireValue(typeof fact.value === 'string' && fact.value.trim().length > 0
        && fact.value.length <= 400, 'fact value must contain 1–400 characters');
    requireValue(validRange(fact.source) && fact.source[1] <= through, 'invalid fact source');
    return { id: fact.id, category: fact.category, value: fact.value.trim(), source: [...fact.source] };
}

function validateFacts(facts, through) {
    requireValue(Array.isArray(facts) && facts.length <= MAX_FACTS, 'too many facts');
    const validated = facts.map(fact => validateFact(fact, through));
    requireValue(new Set(validated.map(fact => fact.id)).size === validated.length, 'duplicate fact ids');
    return validated.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

// Strict on import: reject the whole import rather than silently dropping bad facts.
export function validateStoredState(state) {
    if (state == null) return emptyState();
    requireValue(state.version === STATE_VERSION, 'unsupported state version');
    requireValue(Number.isInteger(state.through) && state.through >= -1, 'invalid cutoff');
    requireValue(Number.isInteger(state.from) && state.from >= 0 && state.from <= state.through + 1, 'invalid start');
    const facts = validateFacts(state.facts, state.through);
    requireValue(Array.isArray(state.overrides) && state.overrides.length <= MAX_FACTS, 'invalid overrides');
    const overrides = state.overrides.map(override => {
        requireValue(override && ID.test(override.id) && Number.isInteger(override.anchor)
            && override.anchor >= -1, 'invalid manual correction');
        const fact = override.fact === null ? null : validateFact(override.fact, Math.max(state.through, override.anchor));
        requireValue(!fact || fact.id === override.id, 'manual correction id mismatch');
        return { id: override.id, anchor: override.anchor, fact };
    });
    requireValue(new Set(overrides.map(item => item.id)).size === overrides.length, 'duplicate overrides');
    requireValue(Array.isArray(state.checkpoints), 'invalid checkpoints');
    const checkpoints = state.checkpoints.slice(-MAX_CHECKPOINTS).map(checkpoint => {
        requireValue(Number.isInteger(checkpoint.through) && checkpoint.through >= -1
            && checkpoint.through < state.through, 'invalid checkpoint cutoff');
        requireValue(Number.isInteger(checkpoint.from) && checkpoint.from >= 0
            && checkpoint.from <= checkpoint.through + 1, 'invalid checkpoint start');
        return { through: checkpoint.through, from: checkpoint.from, facts: validateFacts(checkpoint.facts, checkpoint.through) };
    });
    return { version: STATE_VERSION, through: state.through, from: state.from, facts, overrides, checkpoints };
}

export function effectiveFacts(state) {
    const facts = new Map(state.facts.map(fact => [fact.id, fact]));
    for (const override of state.overrides) {
        if (override.fact) facts.set(override.id, { ...override.fact, pinned: true });
        else facts.delete(override.id);
    }
    return [...facts.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export function stateInstructions(state, range) {
    return `Return ONLY a complete JSON object with exactly two fields: "summary" (a nonempty compact narrative summary following the user's focus) and "stateChanges" (an array, [] for no changes). This output format replaces any instruction to return a plain summary line.\n${factChangeInstructions(state, range)}`;
}

function factChangeInstructions(state, range) {
    return `Maintain a compact historical state snapshot using the original passage, not guesses. Track location/time, present characters, relationships, important item ownership, injuries, immediate goals/unresolved threads, and durable facts. Never invent numerical relationship scores. Keep injuries/goals until explicitly healed/resolved; omission is NOT removal. Reuse the existing stable id for a changed fact, regardless of wording. Use semantic ids such as scene.location, item.brass_key.owner, injury.mara.hand, goal.find_ivo. New ids must be lowercase ASCII, start with a letter, and use only letters, digits, _, ., :, - (max 96 characters).
Changes use {"op":"set","id":"scene.location","category":"location","value":"East gate","source":[${range[0]},${range[1]}]} or {"op":"remove","id":"goal.find_ivo","source":[${range[0]},${range[1]}]}. Categories: ${CATEGORIES.join(', ')}. Values: 1–400 characters. Source ranges must be within this passage's message indices ${range[0]}–${range[1]}. Use explicit remove for previously recorded resolved goals or obsolete facts. Emit at most one change per ID, reflecting the final supported state of this passage. A goal introduced and resolved wholly within this passage need not enter state; capture its completion in the narrative. No other fields. At most 64 changes. Manual corrections are locked; do not change them.
Previous validated snapshot at message ${state.through} (partial coverage begins at ${state.from}; later passage takes precedence): ${JSON.stringify(effectiveFacts(state))}
Locked ids (including manual removals): ${JSON.stringify(state.overrides.map(item => item.id))}`;
}

export function factInstructions(state, range) {
    return 'Return ONLY a complete JSON object with exactly one field: "stateChanges" (an array, [] for no changes). Extract facts only; do not write a narrative summary.\n'
        + factChangeInstructions(state, range);
}

export function parseFactResponse(raw, state, range) {
    let response;
    try {
        response = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch { throw new Error('Invalid state response: expected complete JSON'); }
    requireValue(response && Object.keys(response).join(',') === 'stateChanges', 'missing or unexpected fact fields');
    return parseStateResponse(JSON.stringify({ summary: 'Fact extraction', stateChanges: response.stateChanges }), state, range).state;
}

// Validate and construct a new state without mutating anything. The caller commits
// this and the narrative together after checking chat/bank/source freshness.
export function parseStateResponse(raw, state, range) {
    requireValue(validRange(range) && range[0] > state.through, 'duplicate or overlapping processing');
    let response;
    try {
        const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        response = JSON.parse(text);
    } catch { throw new Error('Invalid state response: expected complete JSON'); }
    requireValue(response && Object.keys(response).sort().join(',') === 'stateChanges,summary', 'missing or unexpected fields');
    requireValue(typeof response.summary === 'string' && response.summary.trim().length > 0, 'empty summary');
    requireValue(Array.isArray(response.stateChanges) && response.stateChanges.length <= 64, 'invalid changes');
    const facts = new Map(state.facts.map(fact => [fact.id, structuredClone(fact)]));
    const locked = new Set(state.overrides.map(item => item.id));
    const seen = new Set();
    for (const change of response.stateChanges) {
        requireValue(change && ID.test(change.id) && !seen.has(change.id), 'invalid or repeated change id');
        seen.add(change.id);
        requireValue(validRange(change.source) && change.source[0] >= range[0]
            && change.source[1] <= range[1], 'change outside passage');
        if (change.op === 'set') {
            requireValue(Object.keys(change).sort().join(',') === 'category,id,op,source,value', 'invalid set fields');
            const fact = validateFact(change, range[1]);
            if (!locked.has(change.id)) facts.set(change.id, fact);
        } else if (change.op === 'remove') {
            requireValue(Object.keys(change).sort().join(',') === 'id,op,source', 'invalid remove fields');
            requireValue(facts.has(change.id) || locked.has(change.id), 'remove references unknown id');
            if (!locked.has(change.id)) facts.delete(change.id);
        } else { throw new Error('Invalid state response: unknown operation'); }
    }
    requireValue(facts.size <= MAX_FACTS, 'state capacity exceeded; inspect and prune facts');
    const checkpoint = { through: state.through, from: state.from, facts: structuredClone(state.facts) };
    return {
        summary: response.summary.trim(),
        state: {
            ...structuredClone(state),
            from: state.through < 0 ? range[0] : state.from,
            through: range[1],
            facts: [...facts.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')),
            checkpoints: [...state.checkpoints, checkpoint].slice(-MAX_CHECKPOINTS),
        },
    };
}

export function rollbackState(state, changedIndex) {
    const overrides = state.overrides.filter(item => item.anchor < changedIndex);
    if (state.through < changedIndex) return { ...state, overrides };
    const checkpoint = state.checkpoints.filter(item => item.through < changedIndex).at(-1);
    return {
        ...emptyState(),
        ...(checkpoint ? structuredClone(checkpoint) : {}),
        overrides,
        checkpoints: checkpoint ? state.checkpoints.filter(item => item.through < checkpoint.through) : [],
    };
}

export function correctState(state, { id, category, value, remove = false, unlock = false }, anchor) {
    requireValue(ID.test(id), 'invalid fact id');
    const next = structuredClone(state);
    next.overrides = next.overrides.filter(item => item.id !== id);
    if (remove) next.facts = next.facts.filter(item => item.id !== id);
    if (!unlock) {
        const fact = remove ? null : validateFact({ id, category, value, source: [Math.max(0, anchor), Math.max(0, anchor)] }, Math.max(0, anchor));
        next.overrides.push({ id, anchor, fact });
    }
    requireValue(next.overrides.length <= MAX_FACTS, 'too many manual corrections');
    next.overrides.sort((a, b) => a.id.localeCompare(b.id, 'en'));
    return next;
}

// Two independent 32-bit hashes avoid storing copies of every original passage.
// Ghost visibility flags are excluded because /hide changes them as a side effect.
const signatureCache = new WeakMap();

export function messageSignature(message) {
    const cached = message && signatureCache.get(message);
    if (cached && cached.mes === message.mes && cached.name === message.name
        && cached.user === message.is_user && cached.swipe === message.swipe_id) return cached.signature;
    const text = JSON.stringify([message?.is_user, message?.name, message?.mes, message?.swipe_id]);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    const signature = `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
    if (message && typeof message === 'object') signatureCache.set(message,
        { mes: message.mes, name: message.name, user: message.is_user, swipe: message.swipe_id, signature });
    return signature;
}

export function firstSourceChange(signatures, chat) {
    for (let i = 0; i < signatures.length; i++) {
        if (signatures[i] != null && (i >= chat.length || signatures[i] !== messageSignature(chat[i]))) return i;
    }
    return -1;
}
