import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './runtime-helper.js';
import { messageSignature } from '../source-signatures.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        const r = runtime({ separateMemoryByCharacterCard: true }); r.addTurns(3);
        const oldStore = r.api.getChatStore(); const d = deferred(); r.respond(() => d.promise);
        const work = r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
        await Promise.resolve();
        if (change === 'chat') r.switchContext({ ...r.ctx, chat: [], chatMetadata: {} });
        if (change === 'card') r.ctx.characterId = 1;
        if (change === 'source') r.ctx.chat[0].mes = 'Changed action';
        if (change === 'memory') r.api.invalidateContextCache(oldStore);
        d.resolve('New narrative'); await work;
        assert.equal(oldStore.layers.length, 0, change);
        assert.equal(r.hides.length, 0, change);
    }
});

test('multiple promotions retain every source range', async () => {
    const r = runtime({ snippetsPerLayer: 1, snippetsPerPromotion: 2, maxLayers: 4 }); r.addTurns(8);
    const store = r.api.getChatStore();
    store.layers = [Array.from({ length: 7 }, (_, i) => ({ text: `History ${i}`, turnRange: [i * 2, i * 2 + 1] }))];
    store.summarizedUpTo = 13;
    const run = r.api.beginSummarization();
    try { await r.api.maybePromoteLayer(0, run); } finally { r.api.finishSummarization(run); }
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

test('backlog summaries use every original player passage and keeps verbatim window', async () => {
    const r = runtime({ turnsPerSummary: 2 }); r.addTurns(7);
    await r.api.runCatchup(r.api.getAssistantTurns(r.ctx.chat), 5);
    const store = r.api.getChatStore();
    assert.deepEqual(plain(store.layers[0].map(s => s.turnRange)), [[0, 3], [4, 7], [8, 9]]);
    for (const [i, request] of r.requests.entries()) assert.ok(request[2].includes(`Player: Player action ${i * 2}`));
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

test('edits roll back affected snippets and restore originals', async () => {
    const r = runtime({  }); r.addTurns(4);
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(0, 1));
    await r.api.summarizeOneBatch(r.api.getAssistantTurns(r.ctx.chat).slice(1, 2));
    const store = r.api.getChatStore(); r.ctx.chat[2].mes = 'Retconned'; r.api.reconcileMemorySources();
    assert.equal(store.summarizedUpTo, 1);
    assert.equal(r.ctx.chat[2].extra?.sc_ghosted, undefined); assert.equal(r.ctx.chat[2].is_system, false);
});

test('legacy text-only and database exports import; invalid snippets are rejected', () => {
    const r = runtime(); r.addTurns(3);
    assert.equal(r.api.validateMemoryImport({ layers: [['Legacy']], summarizedUpTo: -1 }).layers[0][0].text, 'Legacy');
    assert.equal(r.api.validateMemoryImport({ layers: [{ snippets: [{ text: 'DB legacy' }] }], summarizedUpTo: -1 }).layers[0][0].text, 'DB legacy');
    assert.throws(() => r.api.validateMemoryImport({ layers: [[{ nope: true }]] }), /snippet/);
});

test('shared bank is copied; card banks remain isolated', () => {
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
    const r = runtime({ contextBudget: 450 }); r.addTurns(2);
    const store = r.api.getChatStore(); store.layers = [[{ text: 'Narrative '.repeat(100), turnRange: [0, 1] }, { text: 'Short recent event.', turnRange: [2, 3] }]]; store.summarizedUpTo = 3;
    r.ctx.getTokenCountAsync = async text => text.length;
    await r.api.onGenerationStarted();
    assert.ok(r.ctx.extensionPrompts.summaryception.value.length <= 450);
    assert.ok(r.$('#sc_injection_inspector').text().includes('active tokenizer'));
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
    assert.equal(r.dom.window.document.getElementById('sc_state_enabled'), null);
});


test('retired facts and recall are dropped from old banks/imports without losing narrative or source ranges', async () => {
    const r = runtime(); r.addTurns(3);
    const store = r.api.getChatStore();
    store.layers = [[{ text: 'Existing prose.', turnRange: [0, 1], recall: { durableFacts: ['Do not inject this'] } }]];
    store.summarizedUpTo = 1;
    store.structuredState = { version: 99, facts: [{ value: 'Retired fact' }] };
    store.lastFactBatch = { range: [0, 1] };
    Object.assign(r.api.getSettings(), { structuredStateEnabled: true, stateTokenAllowance: 800 });
    const imported = r.api.validateMemoryImport({ store });
    assert.equal(imported.structuredState, undefined);
    assert.equal(imported.layers[0][0].recall, undefined);
    assert.deepEqual(plain(imported.layers[0][0].turnRange), [0, 1]);
    await r.api.activateCharacterMemoryStore(); await wait(150);
    assert.equal(r.requests.length, 0);
    const text = r.api.assembleSummaryBlock();
    assert.ok(text.includes('Existing prose.'));
    assert.ok(!text.includes('Retired fact') && !text.includes('Do not inject this'));
    assert.equal(store.structuredState, undefined); assert.equal(store.lastFactBatch, undefined);
    assert.equal(r.api.getSettings().structuredStateEnabled, undefined);
});

test('Cancel Backlog aborts the in-flight batch, keeps completed batches, and Force can resume', async () => {
    const r = runtime({ turnsPerSummary: 2 }); r.addTurns(7); r.api.bindUIEvents();
    const d = deferred(); r.respond(() => r.requests.length === 1 ? 'First saved summary.' : d.promise);
    const work = r.api.runCatchup(r.api.getAssistantTurns(r.ctx.chat), 5);
    while (r.requests.length < 2) await wait(10);
    assert.equal(r.$('#sc_backlog_progress')[0].style.display, '');
    assert.ok(r.$('#sc_backlog_status').text().includes('1 / 3'));
    await r.click('sc_cancel_backlog'); await work;
    assert.equal(r.requests[1][3].signal.aborted, true);
    assert.equal(r.api.getChatStore().layers[0].length, 1);
    assert.equal(r.api.getChatStore().summarizedUpTo, 3);
    assert.equal(r.$('#sc_backlog_progress')[0].style.display, 'none');
    d.resolve('Late response'); r.respond(async () => 'Resumed summary.');
    await r.click('sc_force_summarize');
    assert.equal(r.api.getChatStore().summarizedUpTo, 9);
    assert.equal(r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > 9).length, 2);
});

test('explicit dialog Cancel makes no requests and releases the run', async () => {
    const r = runtime({ turnsPerSummary: 1 }); r.addTurns(8);
    const work = r.api.maybeSummarizeTurns();
    r.dom.window.document.getElementById('sc_catchup_cancel').click(); await work;
    assert.equal(r.requests.length, 0); assert.equal(r.api.isMemoryRunning(), false);
    assert.equal(r.api.getChatStore().summarizedUpTo, -1);
});

test('cancel after a batch commit finishes and saves its visibility without starting another batch', async () => {
    const r = runtime(); r.addTurns(6);
    const original = r.ctx.executeSlashCommandsWithOptions;
    r.ctx.executeSlashCommandsWithOptions = async (...args) => {
        await original(...args);
        if (r.hides.length === 1) r.api.abortSummarization();
    };
    const saves = []; r.ctx.saveMetadata = async () => saves.push(plain(r.api.getChatStore().ghostedIndices));
    await r.api.runCatchup(r.api.getAssistantTurns(r.ctx.chat), 4);
    assert.equal(r.requests.length, 1);
    assert.deepEqual(plain(r.api.getChatStore().ghostedIndices), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(saves.at(-1), [0, 1, 2, 3, 4, 5]);
});

function regenerationHistory(r) {
    r.addTurns(5); const store = r.api.getChatStore();
    store.layers = [[{ text: 'Later events.', turnRange: [4, 5] }, { text: 'Latest events.', turnRange: [6, 7] }],
        [{ text: 'Earlier events.', turnRange: [0, 3], promoted: true }]];
    store.summarizedUpTo = 7;
    return store;
}

test('latest regeneration includes ghosted originals, bounded earlier context, and no future memory', async () => {
    const r = runtime({ contextBudget: 30, contextBudgetUnit: 'characters' }); const store = regenerationHistory(r);
    store.layers[1][0].text = 'x'.repeat(300);
    for (const m of r.ctx.chat.slice(0, 8)) { m.is_system = true; m.is_hidden = true; m.extra = { sc_ghosted: true }; }
    r.api.bindUIEvents(); r.respond(async () => 'Fresh summary.');
    await r.click('sc_regenerate_latest');
    const prompt = r.requests[0][2];
    assert.ok(prompt.includes('Player action 3') && prompt.includes('Reply 3'));
    const prior = /<prior_context>(.*?)<\/prior_context>/s.exec(prompt)[1];
    assert.ok(prior.length <= 30); assert.ok(!prior.includes('Latest events'));
    assert.equal(store.layers[0][1].text, 'Fresh summary.');
    assert.equal(store.layers[0][0].text, 'Later events.');
    assert.equal(store.summarizedUpTo, 7); assert.equal(r.hides.length, 0);
});

test('all regeneration stages replacements chronologically and commits every layer together', async () => {
    const r = runtime(); const store = regenerationHistory(r); r.api.bindUIEvents();
    const original = JSON.stringify(store.layers);
    r.respond(async (_s, _sys, prompt) => {
        assert.equal(JSON.stringify(store.layers), original);
        if (r.requests.length === 2) assert.ok(prompt.includes('New summary 1'));
        return `New summary ${r.requests.length}`;
    });
    r.$('#sc_regenerate_scope').val('all'); await r.click('sc_regenerate_latest');
    assert.equal(r.requests.length, 3);
    assert.equal(store.layers[1][0].text, 'New summary 1');
    assert.equal(store.layers[0][0].text, 'New summary 2');
    assert.equal(store.layers[0][1].text, 'New summary 3');
    assert.equal(store.layers[1][0].promoted, true);
});

test('canceling all regeneration preserves every original and later responses cannot overwrite them', async () => {
    const r = runtime(); const store = regenerationHistory(r);
    const original = JSON.stringify(store.layers); const d = deferred();
    r.respond(() => r.requests.length === 1 ? 'Staged text' : d.promise);
    const work = r.api.regenerateSnippets(store.layers.flat());
    while (r.requests.length < 2) await wait(5);
    r.api.abortSummarization(); assert.equal(await work, false); d.resolve('Late');
    assert.equal(JSON.stringify(store.layers), original); assert.equal(r.hides.length, 0);
});

test('regeneration retains originals on invalid sources, model errors, edits and chat/card changes', async () => {
    for (const change of ['error', 'empty', 'source', 'chat', 'card', 'memory']) {
        const r = runtime({ separateMemoryByCharacterCard: true }); const store = regenerationHistory(r);
        const original = JSON.stringify(store.layers); const d = deferred();
        if (change === 'empty') r.ctx.chat.slice(0, 4).forEach(m => { m.mes = ''; });
        r.respond(() => change === 'error' ? Promise.reject(new Error('Invalid model')) : d.promise);
        const work = r.api.regenerateSnippets([store.layers[1][0]]);
        if (change === 'source') r.ctx.chat[0].mes = 'Retconned';
        if (change === 'chat') r.switchContext({ ...r.ctx, chat: [], chatMetadata: {} });
        if (change === 'card') r.ctx.characterId = 1;
        if (change === 'memory') r.api.invalidateContextCache(store);
        d.resolve('Replacement'); assert.equal(await work, false, change);
        assert.equal(JSON.stringify(store.layers), original, change);
    }
});

test('promoted snippets expose regeneration through the snippet browser', async () => {
    const r = runtime(); const store = regenerationHistory(r); r.api.updateUI();
    const button = r.dom.window.document.querySelector('.sc-snippet[data-layer="1"] .sc-snippet-redo');
    assert.ok(button);
    await r.$._data(button, 'events').click[0].handler.call(button);
    assert.equal(store.layers[1][0].regenerated, true);
});

test('each added preset keeps supported incremental continuity and editing switches to custom', async () => {
    const r = runtime(); r.api.bindUIEvents();
    for (const preset of ['concise', 'chronological', 'relationships', 'plotthreads', 'continuity']) {
        r.$('#sc_prompt_preset').val(preset); await r.click('sc_prompt_preset', 'change');
        const prompt = r.api.getSettings().summarizerUserPrompt;
        assert.ok(prompt.includes('{{story_txt}}') && prompt.includes('{{context_str}}'));
        assert.ok(prompt.includes('Do not continue the roleplay'));
        r.$('#sc_summarizer_user_prompt').val('My custom focus {{story_txt}}');
        await r.click('sc_summarizer_user_prompt', 'input');
        assert.equal(r.api.getSettings().promptPreset, 'custom');
    }
});

test('debug overlay is opt-in, shows actual registry text safely, follows changes and closes', async () => {
    const r = runtime(); const store = regenerationHistory(r); r.api.bindUIEvents(); r.api.updateInjection();
    const doc = r.dom.window.document;
    assert.equal(doc.getElementById('sc_injection_debug_overlay'), null);
    r.$('#sc_injection_debug_overlay_enabled').prop('checked', true); await r.click('sc_injection_debug_overlay_enabled', 'change');
    const panel = doc.getElementById('sc_injection_debug_overlay');
    assert.equal(panel.querySelector('pre').textContent, r.ctx.extensionPrompts.summaryception.value);
    store.layers[0][1].text = '<img src=x onerror="alert(1)">'; r.api.updateInjection();
    assert.ok(panel.querySelector('pre').textContent.includes('<img')); assert.equal(panel.querySelector('img'), null);
    r.$('#sc_enabled').prop('checked', false); await r.click('sc_enabled', 'change');
    assert.match(panel.querySelector('pre').textContent, /No Summaryception injection/);
    panel.querySelector('.sc-debug-close').click();
    assert.equal(doc.getElementById('sc_injection_debug_overlay'), null);
    assert.equal(r.api.getSettings().injectionDebugOverlay, false);
});

test('debug overlay retains measured injection report after preview refresh', async () => {
    const r = runtime({ contextBudget: 450, injectionDebugOverlay: true }); regenerationHistory(r);
    r.ctx.getTokenCountAsync = async text => text.length;
    await r.api.onGenerationStarted(); r.api.updateUI();
    const panel = r.dom.window.document.getElementById('sc_injection_debug_overlay');
    assert.ok(panel.textContent.includes('measured tokens'));
    assert.equal(panel.querySelector('pre').textContent, r.ctx.extensionPrompts.summaryception.value);
});

test('changing settings during async tokenization cannot register stale injection', async () => {
    for (const change of ['disable', 'budget', 'placement']) {
        const r = runtime({ contextBudget: 450 }); regenerationHistory(r);
        const d = deferred(); r.ctx.getTokenCountAsync = () => d.promise;
        const work = r.api.onGenerationStarted();
        const s = r.api.getSettings();
        if (change === 'disable') s.enabled = false;
        if (change === 'budget') s.contextBudget = 1;
        if (change === 'placement') s.injectionPosition = 'in_chat';
        r.api.updateInjection(); const expected = plain(r.ctx.extensionPrompts.summaryception);
        d.resolve(10); await work;
        assert.deepEqual(plain(r.ctx.extensionPrompts.summaryception), expected, change);
    }
});

test('connection test aborts on timeout and clears the timeout after success', async () => {
    const r = runtime({ summarizerTimeoutMs: 20 });
    await r.api.testCurrentConnectionHandler(); await wait(30);
    assert.equal(r.requests[0][3].signal.aborted, false, 'successful request timeout was not cleared');
    const d = deferred(); r.respond(() => d.promise);
    await r.api.testCurrentConnectionHandler();
    assert.equal(r.requests[1][3].signal.aborted, true);
    assert.ok(r.messages.at(-1).text.includes('timed out')); d.resolve('Late');
});

test('regeneration restores original snippets when persistence rejects the commit', async () => {
    const r = runtime(); const store = regenerationHistory(r);
    const original = JSON.stringify(store.layers);
    r.ctx.saveMetadata = async () => { throw new Error('Cannot save metadata'); };
    assert.equal(await r.api.regenerateSnippets(store.layers.flat()), false);
    assert.equal(JSON.stringify(store.layers), original);
    assert.equal(r.api.isMemoryRunning(), false);
});
