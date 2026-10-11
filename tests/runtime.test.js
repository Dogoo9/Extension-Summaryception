import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './runtime-helper.js';
import { emptyState, parseStateResponse, messageSignature, correctState } from '../state-memory.js';

const structured = (range, value = 'East gate') => JSON.stringify({ summary: 'Moved to the gate.', stateChanges: [{ op: 'set', id: 'scene.location', category: 'location', value, source: range }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settledFacts(r) {
    await wait(130); // The actual activation debounce must have fired.
    const deadline = performance.now() + 4000;
    while (r.api.isMemoryRunning() && performance.now() < deadline) await wait(20);
    assert.equal(r.api.isMemoryRunning(), false, 'fact catch-up did not settle');
}
function legacyHistory(r, cutoff = 7) {
    r.addTurns(6);
    const store = r.api.getChatStore();
    store.layers = [[], [{ text: 'Existing promoted narrative', turnRange: [0, cutoff], timestamp: 123 }]];
    store.summarizedUpTo = cutoff;
    store.ghostedIndices = Array.from({ length: cutoff + 1 }, (_, i) => i);
    store.sourceSignatures = r.ctx.chat.slice(0, cutoff + 1).map(messageSignature);
    for (let i = 0; i <= cutoff; i++) Object.assign(r.ctx.chat[i], { extra: { sc_ghosted: true }, is_system: true, is_hidden: true });
    return store;
}
function factReply(_settings, _system, prompt) {
    const match = /message indices (\d+)–(\d+)/.exec(prompt);
    const range = [+match[1], +match[2]];
    return JSON.stringify({ stateChanges: [{ op: 'set', id: 'scene.location', category: 'location', value: `Room ${range[1]}`, source: range }] });
}

test('enabling tracking automatically backfills originals, preserving promoted narrative, pins and verbatim window', async () => {
    const r = runtime({ turnsPerSummary: 2 });
    const store = legacyHistory(r);
    store.structuredState = correctState(emptyState(), { id: 'item.key.owner', category: 'item', value: 'Ivo' }, 7);
    r.api.getSettings().summarizerUserPrompt = 'Custom narrative focus that omits items {{story_txt}}';
    const narrative = JSON.stringify(store.layers), ghosted = JSON.stringify(store.ghostedIndices);
    r.respond(factReply); r.api.bindUIEvents();
    r.$('#sc_state_enabled').prop('checked', true); await r.click('sc_state_enabled', 'change');
    await settledFacts(r);
    assert.equal(store.structuredState.through, 7); assert.equal(store.structuredState.from, 0);
    assert.equal(store.structuredState.overrides[0].fact.value, 'Ivo');
    assert.equal(store.structuredState.facts[0].value, 'Room 7');
    assert.equal(store.summarizedUpTo, 7); assert.equal(JSON.stringify(store.layers), narrative);
    assert.equal(JSON.stringify(store.ghostedIndices), ghosted); assert.equal(r.hides.length, 0);
    assert.equal(r.requests.length, 2);
    assert.ok(r.requests[0][2].includes('Player action 0'));
    assert.ok(r.requests[1][2].includes('Reply 3')); assert.ok(!r.requests[1][2].includes('Player action 4'));
    assert.ok(!r.requests[0][2].includes('Custom narrative focus'));
    const count = r.requests.length;
    await r.api.activateCharacterMemoryStore(); await settledFacts(r); assert.equal(r.requests.length, count);
    // The next normal batch resumes the single-call summary/state contract.
    r.respond(async (_s, _sys, prompt) => {
        assert.ok(prompt.includes('Room 7'));
        return structured([8, 9], 'Room 9');
    });
    await r.api.maybeSummarizeTurns(); // No overflow: exactly two verbatim turns.
    assert.equal(r.requests.length, count);
    r.addTurns(1, 6); await r.api.maybeSummarizeTurns();
    assert.equal(r.requests.length, count + 1); assert.equal(store.structuredState.through, 9);
});

test('missing facts are extracted before the next summary, then updates share its existing call', async () => {
    const r = runtime({ turnsPerSummary: 2, structuredStateEnabled: true });
    const store = legacyHistory(r, 3);
    r.respond(async (s, system, prompt) => system.includes('factual RP memory') ? factReply(s, system, prompt) : structured([4, 7], 'New location'));
    const narrative = store.layers[1][0];
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > 3));
    assert.equal(r.requests.length, 2); assert.equal(store.layers[1][0], narrative);
    assert.equal(store.structuredState.through, 7); assert.equal(store.structuredState.facts[0].value, 'New location');
    assert.ok(r.requests[1][2].includes('Room 3'));
});

test('stop preserves completed fact batches; Extract Missing Facts resumes without rewriting history', async () => {
    const r = runtime({ structuredStateEnabled: true, turnsPerSummary: 2 }); const store = legacyHistory(r);
    const d = deferred(); r.respond((...args) => r.requests.length === 1 ? factReply(...args) : d.promise);
    const narrative = JSON.stringify(store.layers);
    const running = r.api.extractMissingFacts();
    while (r.requests.length < 2) await wait(20);
    assert.equal(store.structuredState.through, 3);
    r.api.abortSummarization(); await running; d.resolve(factReply(...r.requests[1]));
    assert.equal(store.structuredState.through, 3); assert.equal(JSON.stringify(store.layers), narrative);
    r.respond(factReply); r.api.bindUIEvents(); await r.click('sc_state_extract');
    assert.equal(store.structuredState.through, 7); assert.equal(r.requests.length, 3);
    assert.match(r.requests[2][2], /message indices 4–7/); assert.equal(r.hides.length, 0);
});

test('invalid automatic extraction pauses without retry loops, and manual retry preserves narrative', async () => {
    const r = runtime({ structuredStateEnabled: true }); const store = legacyHistory(r, 3);
    const narrative = JSON.stringify(store.layers);
    r.respond(async () => '{"stateChanges":'); await r.api.activateCharacterMemoryStore(); await settledFacts(r);
    assert.equal(store.structuredState.through, -1); assert.equal(JSON.stringify(store.layers), narrative);
    assert.equal(r.requests.length, 1);
    await r.api.activateCharacterMemoryStore(); await settledFacts(r); assert.equal(r.requests.length, 1);
    r.respond(factReply); await r.api.extractMissingFacts(); assert.equal(store.structuredState.through, 3);
});

test('partial old snapshots are replayed from message zero without clearing them on invalid replies', async () => {
    const r = runtime({ structuredStateEnabled: true, turnsPerSummary: 2 }); const store = legacyHistory(r);
    store.structuredState = parseStateResponse(structured([4, 7]), emptyState(), [4, 7]).state;
    const original = JSON.stringify(store.structuredState);
    r.respond(async () => 'invalid'); await r.api.extractMissingFacts();
    assert.equal(JSON.stringify(store.structuredState), original);
    r.respond(factReply); await r.api.extractMissingFacts();
    assert.match(r.requests[1][2], /message indices 0–3/); assert.equal(store.structuredState.from, 0);
    assert.equal(store.structuredState.through, 7);
});

test('reenabling after text-only batches extracts only missing originals and retains earlier facts', async () => {
    const r = runtime({ turnsPerSummary: 2 }); const store = legacyHistory(r, 3);
    store.structuredState = parseStateResponse(structured([0, 3], 'Old room'), emptyState(), [0, 3]).state;
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).filter(turn => turn.index > 3));
    assert.equal(store.summarizedUpTo, 7); assert.equal(store.structuredState.through, 3);
    r.respond(async (_s, _system, prompt) => {
        assert.match(prompt, /message indices 4–7/); assert.ok(prompt.includes('Old room'));
        return '{"stateChanges":[]}';
    });
    r.api.bindUIEvents(); r.$('#sc_state_enabled').prop('checked', true); await r.click('sc_state_enabled', 'change');
    await settledFacts(r);
    assert.equal(r.requests.length, 2); assert.equal(store.structuredState.through, 7);
    assert.equal(store.structuredState.facts[0].value, 'Old room');
});

test('fact catch-up skips manually hidden passages and completes empty ranges without model calls', async () => {
    const r = runtime({ structuredStateEnabled: true }); const store = legacyHistory(r, 3);
    for (const message of r.ctx.chat.slice(0, 4)) delete message.extra.sc_ghosted;
    await r.api.extractMissingFacts();
    assert.equal(r.requests.length, 0); assert.equal(store.structuredState.through, 3);
    assert.equal(store.structuredState.facts.length, 0); assert.equal(r.hides.length, 0);
});

test('queued fact catch-up waits for active run, respects pause/disable, and cannot spill into another chat', async () => {
    const r = runtime({ structuredStateEnabled: true, pauseSummarization: true }); const store = legacyHistory(r, 3);
    r.respond(factReply); r.api.scheduleFactBackfill(); await settledFacts(r); assert.equal(r.requests.length, 0);
    r.api.getSettings().pauseSummarization = false;
    const run = r.api.beginSummarization(); r.api.scheduleFactBackfill(); await wait(130);
    assert.equal(r.requests.length, 0); r.api.finishSummarization(run); await settledFacts(r);
    assert.equal(store.structuredState.through, 3);
    store.structuredState = emptyState(); r.api.scheduleFactBackfill();
    r.api.getSettings().structuredStateEnabled = false; await settledFacts(r); assert.equal(r.requests.length, 1);
    r.api.getSettings().structuredStateEnabled = true; r.api.scheduleFactBackfill(true);
    r.switchContext({ ...r.ctx, chat: [], chatMetadata: {} }); await settledFacts(r);
    assert.equal(r.requests.length, 1); assert.equal(store.structuredState.through, -1);
});

test('fact catch-up rejects pending replies after source changes and card switches', async () => {
    for (const change of ['source', 'card']) {
        const r = runtime({ structuredStateEnabled: true, separateMemoryByCharacterCard: true }); const store = legacyHistory(r, 3);
        const d = deferred(); r.respond(() => d.promise); const running = r.api.extractMissingFacts();
        await Promise.resolve();
        if (change === 'source') r.ctx.chat[0].mes = 'Retconned'; else r.ctx.characterId = 1;
        d.resolve(factReply(...r.requests[0])); await running;
        assert.equal(store.structuredState.through, -1, change);
        // Source edits invalidate the old narrative too; a card switch preserves
        // the inactive bank while discarding only the pending response.
        assert.equal(store.layers.flat().length, change === 'source' ? 0 : 1, change);
    }
});

test('new replies arriving during fact catch-up trigger their deferred summary afterwards', async () => {
    const r = runtime({ structuredStateEnabled: true, turnsPerSummary: 2 }); const store = legacyHistory(r, 3);
    const d = deferred();
    r.respond((...args) => r.requests.length === 1 ? d.promise : structured([4, 7], 'New scene'));
    const running = r.api.extractMissingFacts();
    r.addTurns(1, 6); r.api.onMessageReceived(r.ctx.chat.length - 1);
    await wait(550); assert.equal(r.requests.length, 1);
    d.resolve(factReply(...r.requests[0])); await running;
    await wait(600); await settledFacts(r);
    assert.equal(r.requests.length, 2); assert.equal(store.summarizedUpTo, 7);
    assert.equal(store.structuredState.facts[0].value, 'New scene');
});

test('normal batch includes player lead-in, replaces all variables and preserves verbatim turns', async () => {
    const r = runtime(); r.addTurns(3);
    r.api.getSettings().summarizerUserPrompt = '{{player_name}} / {{player_name}} / {{context_str}} / {{story_txt}}';
    await r.api.maybeSummarizeTurns();
    const store = r.api.getChatStore();
    assert.deepEqual(plain(store.layers[0][0].turnRange), [0, 1]);
    assert.ok(r.requests[0][2].includes('Alex / Alex'));
    assert.ok(r.requests[0][2].includes('Player: Player action 0'));
    assert.equal(r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > store.summarizedUpTo).length, 2);
});

test('routine normalization preserves array identities used during promotion', () => {
    const r = runtime(); const store = r.api.getChatStore(); store.layers = [[{ text: 'A' }], [{ text: 'B' }]];
    const layer = store.layers[0]; const dest = store.layers[1];
    r.api.getChatStore(); r.api.buildFullContext();
    assert.equal(store.layers[0], layer); assert.equal(store.layers[1], dest);
});

test('structured batch commits state and summary atomically; malformed extraction ghosts nothing', async () => {
    const r = runtime({ structuredStateEnabled: true }); r.addTurns(4);
    r.respond(async () => '{"summary":"Partial"');
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
    const store = r.api.getChatStore();
    assert.equal(store.structuredState.through, -1); assert.equal(store.summarizedUpTo, -1);
    assert.equal(store.layers.length, 0); assert.equal(r.hides.length, 0);
    r.respond(async () => structured([0, 1]));
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
    assert.equal(store.structuredState.through, 1); assert.equal(store.layers[0].length, 1);
    assert.equal(r.hides.length, 2); assert.equal(store.sourceSignatures.length, 2);
});

test('stop locks the run until completion, aborts its request and catchup does not resume', async () => {
    const r = runtime(); r.addTurns(10);
    const d = deferred(); r.respond(() => d.promise);
    const work = r.api.runCatchup(r.api.getAssistantTurns(r.ctx.chat), 8);
    await Promise.resolve();
    const signal = r.requests[0][3].signal;
    r.api.abortSummarization();
    assert.equal(signal.aborted, true);
    assert.equal(r.api.beginSummarization(), null);
    await work;
    d.resolve('Late response');
    assert.equal(r.requests.length, 1); assert.equal(r.api.getChatStore().layers.length, 0);
});

test('pending response is discarded on chat/card changes or source edits', async () => {
    for (const change of ['chat', 'card', 'source', 'memory']) {
        const r = runtime({ separateMemoryByCharacterCard: true, structuredStateEnabled: true }); r.addTurns(3);
        const oldStore = r.api.getChatStore(); const d = deferred(); r.respond(() => d.promise);
        const work = r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
        await Promise.resolve();
        if (change === 'chat') r.switchContext({ ...r.ctx, chat: [], chatMetadata: {} });
        if (change === 'card') r.ctx.characterId = 1;
        if (change === 'source') r.ctx.chat[0].mes = 'Changed action';
        if (change === 'memory') r.api.invalidateContextCache(oldStore);
        d.resolve(structured([0, 1])); await work;
        assert.equal(oldStore.layers.length, 0, change); assert.equal(oldStore.structuredState.through, -1, change);
        assert.equal(r.hides.length, 0, change);
    }
});

test('multiple promotions retain source ranges and never revert newer state', async () => {
    const r = runtime({ snippetsPerLayer: 1, snippetsPerPromotion: 2, maxLayers: 4 }); r.addTurns(8);
    const store = r.api.getChatStore();
    store.layers = [Array.from({ length: 7 }, (_, i) => ({ text: `History ${i}`, turnRange: [i * 2, i * 2 + 1] }))];
    store.summarizedUpTo = 13;
    store.structuredState = parseStateResponse(structured([0, 13], 'Current castle'), emptyState(), [0, 13]).state;
    const before = JSON.stringify(store.structuredState);
    const run = r.api.beginSummarization();
    try { await r.api.maybePromoteLayer(0, run); } finally { r.api.finishSummarization(run); }
    assert.equal(JSON.stringify(store.structuredState), before);
    assert.ok(store.layers.length >= 3);
    const ranges = store.layers.flat().map(sn => sn.turnRange).sort((a, b) => a[0] - b[0]);
    assert.equal(ranges[0][0], 0); assert.equal(ranges.at(-1)[1], 13);
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
});

test('failed promotion leaves original arrays/snippets intact throughout request', async () => {
    const r = runtime({ snippetsPerLayer: 1 }); r.addTurns(3);
    const store = r.api.getChatStore(); store.layers = [[{ text: 'A', turnRange: [2, 3] }, { text: 'B', turnRange: [4, 5] }], [{ text: 'Seed', turnRange: [0, 1] }]];
    const d = deferred(); r.respond(() => d.promise);
    const run = r.api.beginSummarization(); const work = r.api.maybePromoteLayer(0, run);
    assert.equal(store.layers[0].length, 2);
    r.api.abortSummarization(); await work; r.api.finishSummarization(run);
    d.resolve('Late'); assert.equal(store.layers[0].length, 2);
});

test('backlog state extraction uses every original player passage and keeps verbatim window', async () => {
    const r = runtime({ structuredStateEnabled: true, turnsPerSummary: 2 }); r.addTurns(7);
    r.respond(async (_s, _system, prompt) => {
        const range = /message indices (\d+)–(\d+)/.exec(prompt);
        return structured([Number(range[1]), Number(range[2])]);
    });
    await r.api.runCatchup(r.api.getAssistantTurns(r.ctx.chat), 5);
    const store = r.api.getChatStore();
    assert.deepEqual(plain(store.layers[0].map(s => s.turnRange)), [[0, 3], [4, 7], [8, 9]]);
    for (const [i, request] of r.requests.entries()) assert.ok(request[2].includes(`Player: Player action ${i * 2}`));
    assert.equal(store.structuredState.through, 9);
    assert.equal(r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > store.summarizedUpTo).length, 2);
});

test('edits, swipe, deletion, branches repair every layer and inactive bank', async () => {
    for (const change of ['edit', 'swipe', 'delete', 'branch']) {
        const r = runtime({ separateMemoryByCharacterCard: true }); r.addTurns(4);
        const a = r.api.getChatStore();
        a.layers = [[], [{ text: 'Older promoted memory', turnRange: [0, 5] }]];
        a.summarizedUpTo = 5; a.sourceSignatures = r.ctx.chat.slice(0, 6).map(messageSignature);
        a.ghostedIndices = [0, 1, 2, 3, 4, 5];
        r.ctx.characterId = 1; const b = r.api.getChatStore();
        b.layers = [[{ text: 'Other card', turnRange: [0, 5] }]]; b.summarizedUpTo = 5; b.sourceSignatures = [...a.sourceSignatures];
        if (change === 'edit') r.ctx.chat[2].mes = 'Changed';
        if (change === 'swipe') r.ctx.chat[3].swipe_id = 1;
        if (change === 'delete') r.ctx.chat.splice(2, 1);
        if (change === 'branch') r.ctx.chat.length = 4;
        assert.equal(r.api.reconcileMemorySources(), true, change);
        assert.equal(a.summarizedUpTo, -1, change); assert.equal(b.summarizedUpTo, -1, change);
        assert.equal(a.layers.flat().length, 0, change); assert.equal(b.layers.flat().length, 0, change);
    }
});

test('aligned edits restore checkpoint; old promoted histories rebuild conservatively', async () => {
    const r = runtime({ structuredStateEnabled: true }); r.addTurns(4);
    r.respond(async (_s, _sys, prompt) => { const m = /message indices (\d+)–(\d+)/.exec(prompt); return structured([+m[1], +m[2]], `Location ${m[2]}`); });
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(1, 2));
    const store = r.api.getChatStore(); r.ctx.chat[2].mes = 'Retconned'; r.api.reconcileMemorySources();
    assert.equal(store.structuredState.through, 1); assert.equal(store.summarizedUpTo, 1);
    assert.equal(store.structuredState.facts[0].value, 'Location 1');
    assert.equal(r.ctx.chat[2].extra?.sc_ghosted, undefined); assert.equal(r.ctx.chat[2].is_system, false);
});

test('legacy text-only and database exports import; state import validates before mutating memory', () => {
    const r = runtime(); r.addTurns(3);
    assert.equal(r.api.validateMemoryImport({ layers: [['Legacy']], summarizedUpTo: -1 }).layers[0][0].text, 'Legacy');
    assert.equal(r.api.validateMemoryImport({ layers: [{ snippets: [{ text: 'DB legacy' }] }], summarizedUpTo: -1 }).layers[0][0].text, 'DB legacy');
    const state = parseStateResponse(structured([0, 1]), emptyState(), [0, 1]).state;
    const bank = { layers: [[{ text: 'Saved', turnRange: [0, 1] }]], summarizedUpTo: 1, structuredState: state, sourceSignatures: r.ctx.chat.slice(0, 2).map(messageSignature) };
    assert.deepEqual(plain(r.api.validateMemoryImport({ store: bank }).structuredState), state);
    assert.throws(() => r.api.validateMemoryImport({ store: { ...bank, sourceSignatures: [] } }), /signatures/);
    assert.throws(() => r.api.validateMemoryImport({ layers: [[{ nope: true }]] }), /snippet/);
});

test('shared bank is copied; card banks and state remain isolated', () => {
    const r = runtime({ separateMemoryByCharacterCard: true });
    const a = r.api.getChatStore(); a.layers = [[{ text: 'Mara memory' }]];
    r.ctx.characterId = 1; const b = r.api.getChatStore(); assert.equal(b.layers.length, 0);
    r.api.getSettings().separateMemoryByCharacterCard = false;
    const shared = r.api.getChatStore(); shared.layers.push([{ text: 'Shared' }]);
    assert.notEqual(shared, b); assert.equal(b.layers.length, 0); assert.equal(a.layers[0][0].text, 'Mara memory');
});

test('all settings buttons have handlers and saved prompts/reset/cleanup operate', async () => {
    const r = runtime(); const clicks = new Set();
    const nativeAdd = r.dom.window.EventTarget.prototype.addEventListener;
    r.dom.window.EventTarget.prototype.addEventListener = function(type, ...rest) {
        if (type === 'click' && this.id) clicks.add(this.id); return nativeAdd.call(this, type, ...rest);
    };
    r.api.bindUIEvents(); r.api.initConnectionUI(); r.api.updateUI();
    for (const button of r.dom.window.document.querySelectorAll('button[id]')) {
        assert.ok(clicks.has(button.id) || r.$._data(button, 'events')?.click?.length, `Unbound button ${button.id}`);
    }
    const s = r.api.getSettings(); s.promptPreset = 'custom'; s.summarizerUserPrompt = 'Saved prompt {{story_txt}}';
    r.$('#sc_custom_prompt_name').val('My prompt'); await r.click('sc_custom_prompt_save');
    assert.equal(s.savedCustomPrompts.length, 1);
    s.summarizerUserPrompt = 'Changed'; r.$('#sc_custom_prompt_slot').val(s.savedCustomPrompts[0].id); await r.click('sc_custom_prompt_load');
    assert.equal(s.summarizerUserPrompt, 'Saved prompt {{story_txt}}');
    await r.click('sc_cleanup_legacy_banks'); assert.ok(r.messages.at(-1).text.includes('No inactive'));
    s.verbatimTurns = 49; await r.click('sc_reset_defaults'); assert.equal(s.verbatimTurns, 10); assert.equal(s.savedCustomPrompts.length, 1);
});

test('state correction controls pin/remove/unlock and clear removes dormant state', async () => {
    const r = runtime({ structuredStateEnabled: true }); r.addTurns(1); r.api.bindUIEvents();
    r.$('#sc_state_id').val('item.key.owner'); r.$('#sc_state_category').val('item'); r.$('#sc_state_value').val('Ivo');
    await r.click('sc_state_pin'); assert.equal(r.api.getChatStore().structuredState.overrides[0].fact.value, 'Ivo');
    await r.click('sc_state_remove'); assert.equal(r.api.getChatStore().structuredState.overrides[0].fact, null);
    await r.click('sc_state_unlock'); assert.equal(r.api.getChatStore().structuredState.overrides.length, 0);
    await r.click('sc_state_pin'); await r.api.clearActiveMemory(); assert.equal(r.api.getChatStore().structuredState.overrides.length, 0);
});

test('repair and disable-message-hiding preserve manual hidden messages', async () => {
    const r = runtime(); r.addTurns(2); r.api.bindUIEvents();
    r.ctx.chat[1].is_system = true; r.ctx.chat[1].is_hidden = true;
    await r.click('sc_repair'); assert.equal(r.ctx.chat[1].is_system, true); assert.equal(r.hides.length, 0);
    r.$('#sc_disable_ghosting').prop('checked', true); await r.click('sc_disable_ghosting', 'change');
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat));
    assert.equal(r.hides.filter(x => x.startsWith('/hide')).length, 0);
});

test('reasoning is removed before strip delimiters, without leaking internal thought', () => {
    const r = runtime(); assert.equal(r.api.cleanSummarizerOutput('<thinking>Secret thoughts</thinking><output>Summary</output>'), 'Summary');
    assert.equal(r.api.cleanSummarizerOutput('<think>More thoughts</think>Summary'), 'Summary');
});

test('generation-time async token count bounds registered injection including wrapper', async () => {
    const r = runtime({ structuredStateEnabled: true, contextBudget: 450 }); r.addTurns(2);
    const store = r.api.getChatStore(); store.layers = [[{ text: 'Narrative '.repeat(100), turnRange: [0, 1] }, { text: 'Short recent event.', turnRange: [2, 3] }]]; store.summarizedUpTo = 3;
    store.structuredState = parseStateResponse(structured([0, 3]), emptyState(), [0, 3]).state;
    r.ctx.getTokenCountAsync = async text => text.length;
    await r.api.onGenerationStarted();
    assert.ok(r.ctx.extensionPrompts.summaryception.value.length <= 450);
    assert.ok(r.$('#sc_state_status').text().includes('active tokenizer'));
});

test('canceling backlog dialog releases the run; skip excludes old turns on later triggers', async () => {
    const r = runtime({ turnsPerSummary: 1 }); r.addTurns(8);
    const first = r.api.maybeSummarizeTurns();
    assert.ok(r.dom.window.document.querySelector('.sc-catchup-overlay'));
    r.api.abortSummarization(); await first;
    assert.equal(r.dom.window.document.querySelector('.sc-catchup-overlay'), null);
    const second = r.api.maybeSummarizeTurns();
    r.dom.window.document.getElementById('sc_catchup_skip').click(); await second;
    assert.equal(r.api.getChatStore().summarizedUpTo, 11);
    await r.api.maybeSummarizeTurns(); assert.equal(r.requests.length, 0);
});

test('card activation clears old owned visibility even when active key changed on a read', async () => {
    const r = runtime({ separateMemoryByCharacterCard: true }); r.addTurns(3);
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
    assert.equal(r.ctx.chat[0].extra.sc_ghosted, true);
    r.ctx.characterId = 1;
    r.api.getChatStore(); // Mimics a UI read before the card-change handler.
    await r.api.activateCharacterMemoryStore();
    assert.equal(r.ctx.chat[0].extra.sc_ghosted, undefined); assert.equal(r.ctx.chat[0].is_system, false);
});

test('disabled state mode sends original custom prompt without extraction, dormant state survives', async () => {
    const r = runtime({ structuredStateEnabled: false }); r.addTurns(3);
    const store = r.api.getChatStore(); store.structuredState = emptyState();
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
    assert.ok(!r.requests[0][2].includes('stateChanges'));
    assert.equal(store.structuredState.through, -1);
});

test('stop restores the original prompt-order objects without changing a newly selected preset', async () => {
    const r = runtime({ connectionSource: 'default' }); r.addTurns(2);
    const oldOrder = [{ identifier: 'creative', enabled: true }];
    r.ctx.promptManager = { getPromptCollection: () => ({ collection: oldOrder }), getPromptOrderEntries: () => oldOrder };
    const d = deferred(); r.respond(() => d.promise);
    const work = r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
    assert.equal(oldOrder[0].enabled, false);
    const newOrder = [{ identifier: 'creative', enabled: false }];
    r.ctx.promptManager = { getPromptCollection: () => ({ collection: newOrder }), getPromptOrderEntries: () => newOrder };
    r.api.abortSummarization(); await work; d.resolve('Late');
    assert.equal(oldOrder[0].enabled, true); assert.equal(newOrder[0].enabled, false);
});

test('module initialization accepts eventTypes and initializes UI after APP_READY already fired', async () => {
    const r = runtime({}, true);
    await r.ready;
    for (const name of ['MESSAGE_RECEIVED', 'CHAT_CHANGED', 'GENERATION_STARTED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPE_DELETED']) assert.ok(r.events.has(name), name);
    assert.equal(r.$('#sc_enabled').prop('checked'), true);
    assert.equal(r.$('#sc_state_enabled').prop('checked'), false);
});

test('legacy recall metadata remains available when structured state is disabled', () => {
    const r = runtime(); const store = r.api.getChatStore();
    store.layers = [[{ text: 'Old narrative.', recall: { durableFacts: ['Mara swore an oath'], currentLocation: 'Archive' } }]];
    const injection = r.api.assembleSummaryBlock();
    assert.ok(injection.includes('Mara swore an oath'));
    assert.ok(injection.includes('Historical recalled scene: Archive'));
});

test('fixed replay preserves ownership, injury, scene, relationships and unresolved task across promotions', async () => {
    const { readFileSync } = await import('node:fs');
    const fixture = JSON.parse(readFileSync(new URL('../docs/replay-narrative.json', import.meta.url), 'utf8'));
    const r = runtime({ ...fixture.settings, structuredStateEnabled: true });
    for (const turn of fixture.turns) r.ctx.chat.push({ is_user: true, name: 'Alex', mes: turn.user }, { is_user: false, name: 'Mara', mes: turn.assistant });
    r.respond(async (_s, _sys, prompt) => {
        const range = /message indices (\d+)–(\d+)/.exec(prompt);
        if (!range) return 'Compressed historical narrative.';
        const deltas = fixture.turns.flatMap(turn => turn.expectedChanges).filter(change => change.source[0] >= +range[1] && change.source[1] <= +range[2]);
        const recorded = new Set(r.api.getChatStore().structuredState.facts.map(fact => fact.id));
        const changes = [...new Map(deltas.map(change => [change.id, change])).values()]
            .filter(change => change.op !== 'remove' || recorded.has(change.id));
        return JSON.stringify({ summary: `Narrative messages ${range[1]}–${range[2]}.`, stateChanges: changes });
    });
    await r.api.runCatchup(r.api.getAssistantTurns(r.ctx.chat), 14);
    const state = r.api.getChatStore().structuredState;
    assert.equal(state.through, 27);
    assert.deepEqual(Object.fromEntries(state.facts.map(fact => [fact.id, fact.value])), fixture.expectedAtCutoff);
    for (const id of fixture.resolvedIds) assert.ok(!state.facts.some(fact => fact.id === id));
    assert.ok(r.api.getChatStore().layers[1].length > 0);
    assert.equal(r.api.getAssistantTurns(r.ctx.chat).filter(turn => turn.index > 27).length, 4);
});
