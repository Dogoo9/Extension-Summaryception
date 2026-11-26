import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './runtime-helper.js';
import { messageSignature } from '../source-signatures.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('normal batch includes player lead-in, replaces all variables and preserves verbatim turns', async () => {
    const r = runtime(); r.addTurns(5);
    r.api.getSettings().summarizerUserPrompt = '{{player_name}} / {{player_name}} / {{context_str}} / {{story_txt}}';
    await r.api.maybeSummarizeTurns();
    const store = r.api.getChatStore();
    assert.deepEqual(plain(store.layers[0][0].turnRange), [0, 5]);
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
    // Automatic catch-up only writes full batches; the partial remainder floats in the verbatim window.
    assert.deepEqual(plain(store.layers[0].map(s => s.turnRange)), [[0, 3], [4, 7]]);
    for (const [i, request] of r.requests.entries()) assert.ok(request[2].includes(`Player: Player action ${i * 2}`));
    assert.equal(r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > store.summarizedUpTo).length, 3);
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
    assert.ok(r.$('#sc_backlog_status').text().includes('1 / 2'));
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
    r.api.getChatStore(); // normalize (assigns stable snippet ids) before tests snapshot the layers
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

test('the memory database pins and regenerates snippets', async () => {
    const r = runtime(); const store = regenerationHistory(r); r.api.showMemoryDatabaseModal();
    const doc = r.dom.window.document;
    const settle = async done => { for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
    doc.querySelector('.sc-db-snippet[data-layer="1"] .sc-db-snippet-pin-btn').click();
    await settle(() => store.layers[1][0].pinned);
    assert.equal(store.layers[1][0].pinned, true);
    await settle(() => doc.querySelector('.sc-db-snippet[data-layer="1"] .sc-db-snippet-pin-btn')?.textContent.includes('Unpin'));
    doc.querySelector('.sc-db-snippet[data-layer="1"] .sc-db-snippet-redo-btn').click();
    await settle(() => store.layers[1][0].regenerated);
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

test('steady state waits for a full batch past the verbatim window (hysteresis)', async () => {
    const r = runtime({ verbatimTurns: 2, turnsPerSummary: 3 });
    const covered = [];
    for (let i = 0; i < 11; i++) {
        r.addTurns(1, i);
        await r.api.maybeSummarizeTurns();
        const visible = r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > r.api.getChatStore().summarizedUpTo).length;
        assert.ok(visible >= Math.min(2, i + 1) && visible <= 4, `visible window ${visible} after turn ${i}`);
        covered.push(r.requests.length);
    }
    // 11 turns, 2 verbatim: 9 overflow turns -> exactly 3 calls, each covering 3 assistant turns.
    assert.equal(r.requests.length, 3);
    for (const sn of r.api.getChatStore().layers[0]) assert.equal(sn.turnRange[1] - sn.turnRange[0] + 1, 6);
    assert.deepEqual(covered, [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3]);
});

test('strictVerbatimWindow restores one-summary-per-turn behaviour', async () => {
    const r = runtime({ verbatimTurns: 2, turnsPerSummary: 3, strictVerbatimWindow: true });
    for (let i = 0; i < 6; i++) { r.addTurns(1, i); await r.api.maybeSummarizeTurns(); }
    assert.equal(r.requests.length, 4);
    assert.equal(r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > r.api.getChatStore().summarizedUpTo).length, 2);
});

test('Force Summarize still drains a partial batch down to the verbatim window', async () => {
    const r = runtime({ verbatimTurns: 2, turnsPerSummary: 3 }); r.addTurns(4); r.api.bindUIEvents();
    await r.api.maybeSummarizeTurns();
    assert.equal(r.requests.length, 0);
    await r.click('sc_force_summarize');
    assert.equal(r.requests.length, 1);
    assert.equal(r.api.getAssistantTurns(r.ctx.chat).filter(t => t.index > r.api.getChatStore().summarizedUpTo).length, 2);
});

test('default-connection prompt toggles are restored during retry backoff', async () => {
    const r = runtime({ connectionSource: 'default', verbatimTurns: 1, turnsPerSummary: 1 }); r.addTurns(2);
    const entries = [{ identifier: 'main', enabled: true }, { identifier: 'nsfw', enabled: true }];
    r.ctx.promptManager = { getPromptCollection: () => ({ collection: entries.map(e => ({ identifier: e.identifier })) }), getPromptOrderEntries: () => entries };
    const seen = [];
    let backoffState;
    r.respond(async () => {
        seen.push(entries.map(e => e.enabled));
        if (seen.length === 1) {
            setTimeout(() => { backoffState = entries.map(e => e.enabled); }, 20);
            throw Object.assign(new Error('busy'), { retryable: true, retryAfter: 0.1 });
        }
        return 'Recovered summary.';
    });
    await r.api.maybeSummarizeTurns();
    assert.deepEqual(seen, [[false, false], [false, false]]);
    assert.deepEqual(backoffState, [true, true]);
    assert.deepEqual(entries.map(e => e.enabled), [true, true]);
    assert.equal(r.api.getChatStore().layers[0].length, 1);
});

const promotionSetup = (settings = {}) => {
    const r = runtime({ snippetsPerLayer: 2, snippetsPerPromotion: 2, maxLayers: 3, ...settings }); r.addTurns(4);
    const store = r.api.getChatStore();
    store.layers = [[
        { text: 'Alex meets Mara at Saltmarsh; Captain Renn watches.', turnRange: [2, 3] },
        { text: 'Mara hands Alex the key; Renn follows them to Gullhaven.', turnRange: [4, 5] },
        { text: 'Alex rests.', turnRange: [6, 7] },
    ], [{ text: 'Seed history.', turnRange: [0, 1] }]];
    store.summarizedUpTo = 7;
    r.api.getChatStore(); // assign stable snippet ids
    return { r, store };
};
const promote = async r => {
    const run = r.api.beginSummarization();
    try { await r.api.maybePromoteLayer(0, run); } finally { r.api.finishSummarization(run); }
};

test('promotion retries once with the missing names and accepts the fixed text', async () => {
    const { r, store } = promotionSetup({ protectedNames: 'Mara' });
    r.respond(async () => r.requests.length === 1 ? 'Alex got a key.' : 'Alex met Mara at Saltmarsh; Mara gave the key; Captain Renn followed to Gullhaven.');
    await promote(r);
    assert.equal(r.requests.length, 2);
    assert.ok(r.requests[1][2].includes('Mara'));
    const merged = store.layers[1].at(-1);
    assert.equal(merged.text, 'Alex met Mara at Saltmarsh; Mara gave the key; Captain Renn followed to Gullhaven.');
    assert.equal(merged.lossy, undefined);
});

test('promotion keeps a still-lossy result but flags it with the missing names', async () => {
    const { r, store } = promotionSetup({ protectedNames: 'Mara' });
    r.respond(async () => 'Alex got a key.');
    await promote(r);
    assert.equal(r.requests.length, 2);
    const merged = store.layers[1].at(-1);
    assert.equal(merged.text, 'Alex got a key.');
    assert.equal(merged.lossy, true);
    assert.ok(merged.missingNames.includes('Mara'));
    assert.deepEqual(plain(merged.turnRange), [2, 5]);
});

test('promotion name check can be disabled and passes clean output without a retry', async () => {
    const off = promotionSetup({ promotionNameCheck: false, protectedNames: 'Mara' });
    off.r.respond(async () => 'Alex got a key.');
    await promote(off.r);
    assert.equal(off.r.requests.length, 1);
    assert.equal(off.store.layers[1].at(-1).lossy, undefined);
    const clean = promotionSetup();
    clean.r.respond(async () => 'Alex met Mara at Saltmarsh; Captain Renn trailed them to Gullhaven with the key.');
    await promote(clean.r);
    assert.equal(clean.r.requests.length, 1);
});

test('promotion archives merged children with layer, parent id and childIds', async () => {
    const { r, store } = promotionSetup();
    r.respond(async () => 'Alex met Mara at Saltmarsh; Captain Renn trailed them to Gullhaven with the key.');
    const childIds = store.layers[0].slice(0, 2).map(sn => sn.id);
    assert.ok(childIds.every(id => typeof id === 'string' && id));
    await promote(r);
    const merged = store.layers[1].at(-1);
    assert.deepEqual(plain(merged.childIds), childIds);
    assert.deepEqual(plain(store.archive.map(entry => entry.id)), childIds);
    for (const entry of store.archive) { assert.equal(entry.layer, 0); assert.equal(entry.parentId, merged.id); }
    assert.equal(store.layers[0].length, 1);
});

test('archivePromotedSnippets=false discards merged children as before', async () => {
    const { r, store } = promotionSetup({ archivePromotedSnippets: false });
    r.respond(async () => 'Alex met Mara at Saltmarsh; Captain Renn trailed them to Gullhaven with the key.');
    await promote(r);
    assert.equal(store.archive.length, 0);
    assert.equal(store.layers[1].at(-1).childIds, undefined);
});

test('a source change inside a promoted range restores its unaffected archived children', async () => {
    const { r, store } = promotionSetup();
    r.respond(async () => 'Alex met Mara at Saltmarsh; Captain Renn trailed them to Gullhaven with the key.');
    await promote(r);
    store.sourceSignatures = r.ctx.chat.slice(0, 8).map(messageSignature);
    // Edit message 4: the merged parent [2,5] and its child [4,5] are affected; child [2,3] is not.
    r.ctx.chat[4].mes = 'Changed';
    r.api.reconcileMemorySources();
    assert.deepEqual(plain(store.layers.flat().map(sn => sn.turnRange).sort((a, b) => a[0] - b[0])), [[0, 1], [2, 3]]);
    assert.equal(store.summarizedUpTo, 3);
    assert.equal(store.archive.length, 0);
    assert.ok(store.layers[0].some(sn => sn.text.startsWith('Alex meets Mara')));
});

test('pinned snippets are never merged and move up verbatim', async () => {
    const { r, store } = promotionSetup();
    store.layers[0][0].pinned = true;
    r.respond(async () => 'Mara hands Alex the key; Renn follows them to Gullhaven; Alex rests.');
    await promote(r);
    const pinned = store.layers[1].find(sn => sn.pinned);
    assert.equal(pinned.text, 'Alex meets Mara at Saltmarsh; Captain Renn watches.');
    assert.equal(r.requests.length, 0, 'moving the pinned snippet and a run of one needs no merge');
    assert.ok(store.layers[0].length <= 2);
});

test('pinned snippets are selected first for the injection budget', () => {
    const r = runtime({ contextBudget: 40, contextBudgetUnit: 'characters', injectionTemplate: '{{summary}}' });
    const store = r.api.getChatStore();
    store.layers = [[{ text: 'Pinned fact.', turnRange: [2, 3] }, { text: 'Newest event.', turnRange: [4, 5] }],
        [{ text: 'Deep history line.', turnRange: [0, 1] }]];
    store.summarizedUpTo = 5;
    // Without a pin, the budget keeps the deep layer plus the newest snippet.
    assert.equal(r.api.assembleSummaryBlock(), 'Deep history line.\nNewest event.');
    store.layers[0][0].pinned = true; r.api.invalidateContextCache(store);
    assert.equal(r.api.assembleSummaryBlock(), 'Pinned fact.\nNewest event.');
});

test('imports validate and replace the archive', () => {
    const r = runtime();
    assert.throws(() => r.api.validateMemoryImport({ layers: [[]], archive: [{ text: 'x' }] }), /archived/);
    assert.throws(() => r.api.validateMemoryImport({ layers: [[]], archive: 'nope' }), /archive/);
    const imported = r.api.validateMemoryImport({ layers: [[{ text: 'A', turnRange: [0, 1] }]] });
    assert.deepEqual(plain(imported.archive), []);
    assert.equal(typeof imported.layers[0][0].id, 'string');
});

test('editing a skipped message keeps later memory, and a rollback keeps the skip cutoff', async () => {
    const r = runtime({ turnsPerSummary: 1 }); r.addTurns(8);
    const dialog = r.api.maybeSummarizeTurns();
    r.dom.window.document.getElementById('sc_catchup_skip').click(); await dialog;
    r.addTurns(1, 8); await r.api.maybeSummarizeTurns();
    const store = r.api.getChatStore();
    assert.equal(JSON.stringify(store.layers[0].map(sn => sn.turnRange)), '[[12,13]]');
    r.ctx.chat[3].mes = 'Typo fixed.'; r.api.onSourceMessageChanged(3); await wait(10);
    assert.equal(store.layers[0].length, 1); assert.equal(store.summarizedUpTo, 13);
    r.ctx.chat[13].mes = 'Rewritten.'; r.api.onSourceMessageChanged(13); await wait(10);
    assert.equal(store.layers[0].length, 0); assert.equal(store.summarizedUpTo, 11);
    assert.equal(r.ctx.chat.some(m => m.extra?.sc_ghosted), false);
});

test('reopening a chat leaves matching visibility untouched and never hides a skipped backlog', async () => {
    const r = runtime(); r.addTurns(11);
    await r.api.runCatchup(r.api.getAssistantTurns(r.ctx.chat), 9);
    assert.equal(r.ctx.chat.filter(m => m.extra?.sc_ghosted).length, 18);
    let before = r.hides.length;
    await r.api.activateCharacterMemoryStore();
    assert.equal(r.hides.length, before);
    // A stray flag past the cutoff and a ghost someone unhid are both corrected.
    r.ctx.chat[20].extra = { sc_ghosted: true }; r.ctx.chat[20].is_system = true;
    r.ctx.chat[4].is_system = false; delete r.ctx.chat[4].is_hidden; r.api.getChatStore().ghostedIndices = [];
    before = r.hides.length;
    await r.api.activateCharacterMemoryStore();
    assert.equal(r.hides.slice(before).sort().join(), '/hide 4,/unhide 20');
    assert.equal(r.ctx.chat[20].extra.sc_ghosted, undefined);
    assert.equal(r.api.getChatStore().ghostedIndices.join(), [...Array(18).keys()].join());

    const skipped = runtime({ turnsPerSummary: 1 }); skipped.addTurns(8);
    const dialog = skipped.api.maybeSummarizeTurns();
    skipped.dom.window.document.getElementById('sc_catchup_skip').click(); await dialog;
    await skipped.api.activateCharacterMemoryStore();
    assert.equal(skipped.ctx.chat.some(m => m.is_system), false);
});

test('layer merges use the promotion prompt while new batches use the summary prompt', async () => {
    const { r } = promotionSetup();
    Object.assign(r.api.getSettings(), { summarizerUserPrompt: 'BATCH {{story_txt}}', summarizerPromotionPrompt: 'MERGE {{story_txt}}' });
    await promote(r);
    assert.ok(r.requests.length > 0); assert.ok(r.requests.every(request => request[2].startsWith('MERGE ')));
});

test('summarizer context keeps the newest snippet when old history fills its budget', () => {
    const r = runtime({ contextBudget: 100, contextBudgetUnit: 'characters' });
    r.api.getChatStore().layers = [Array.from({ length: 8 }, (_, i) => ({ text: `S${i} ${'x'.repeat(30)}` }))];
    assert.match(r.api.buildFullContext(0), /S7 /);
});

test('exact old built-in prompts upgrade and custom text is left alone', () => {
    const r = runtime(); const s = r.api.getSettings();
    r.api.bindUIEvents(); r.$('#sc_prompt_preset').val('concise').trigger('change');
    const concise = s.summarizerUserPrompt;
    s.summarizerUserPrompt = concise.replace('Output only bullets, one fact or beat in each, with no headings or commentary.', 'Output only a compact summary on one line, no headings or commentary, at most 20 short phrases.');
    r.api.updateUI(); assert.equal(s.summarizerUserPrompt, concise);
    s.summarizerSystemPrompt = 'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.';
    s.promptPreset = 'custom'; s.summarizerUserPrompt = 'Mine {{story_txt}}';
    r.api.updateUI();
    assert.match(s.summarizerSystemPrompt, /appended/); assert.equal(s.summarizerUserPrompt, 'Mine {{story_txt}}');
});

test('settings tabs show one panel at a time and remember the last one', async () => {
    const r = runtime();
    r.api.bindUIEvents(); r.api.updateUI();
    const doc = r.dom.window.document;
    const visible = () => [...doc.querySelectorAll('.sc-tab-panel')].filter(p => !p.hidden).map(p => p.dataset.tab);
    assert.deepEqual(visible(), ['timing']);
    doc.querySelector('.sc-tab[data-tab="tools"]').id = 'tab_tools';
    await r.click('tab_tools');
    assert.deepEqual(visible(), ['tools']);
    assert.equal(r.api.getSettings().activeTab, 'tools');
    assert.ok(doc.querySelector('.sc-primary-actions #sc_clear_memory'), 'Clear Memory sits in the top row');
    r.api.getSettings().activeTab = 'gone'; r.api.updateUI();
    assert.deepEqual(visible(), ['timing'], 'an unknown saved tab falls back to the first');
});

const hiddenIndices = r => r.ctx.chat.flatMap((m, i) => m.is_system ? [i] : []);
const flaggedIndices = r => r.ctx.chat.flatMap((m, i) => m.extra?.sc_ghosted ? [i] : []);

test('summarized messages are hidden with one range command per contiguous run', async () => {
    const r = runtime(); r.addTurns(5);
    await r.api.maybeSummarizeTurns();
    assert.deepEqual(r.hides, ['/hide 0-5']);
    await r.api.clearActiveMemory();
    assert.deepEqual(r.hides, ['/hide 0-5', '/unhide 0-5']);
});

test('clear unhides every flagged message even when the saved index list is stale', async () => {
    const r = runtime(); r.addTurns(5);
    await r.api.maybeSummarizeTurns();
    r.api.getChatStore().ghostedIndices = [0, 1, 2];
    await r.api.clearActiveMemory();
    assert.deepEqual(hiddenIndices(r), []); assert.deepEqual(flaggedIndices(r), []);
    assert.deepEqual(plain(r.api.getChatStore().ghostedIndices), []);
});

test('a failed unhide keeps the message owned so a later clear finishes it', async () => {
    const r = runtime(); r.addTurns(5);
    await r.api.maybeSummarizeTurns();
    const original = r.ctx.executeSlashCommandsWithOptions;
    r.ctx.executeSlashCommandsWithOptions = async command => {
        if (command === '/unhide 0-5' || command === '/unhide 0') throw new Error('busy');
        return original(command);
    };
    await r.api.clearActiveMemory();
    assert.deepEqual(hiddenIndices(r), [0]); assert.deepEqual(flaggedIndices(r), [0]);
    assert.ok(r.messages.some(m => m.type === 'warning' && m.text.includes('could not be unhidden')));
    r.ctx.executeSlashCommandsWithOptions = original;
    await r.api.clearActiveMemory();
    assert.deepEqual(hiddenIndices(r), []); assert.deepEqual(flaggedIndices(r), []);
});

test('source repair unhides rolled-back messages in the rendered chat too', async () => {
    const r = runtime(); r.addTurns(5);
    await r.api.maybeSummarizeTurns();
    const doc = r.dom.window.document;
    const chatEl = doc.createElement('div'); chatEl.id = 'chat'; doc.body.append(chatEl);
    for (let i = 0; i < r.ctx.chat.length; i++) chatEl.insertAdjacentHTML('beforeend', `<div class="mes" mesid="${i}" is_system="${r.ctx.chat[i].is_system}"></div>`);
    r.ctx.chat[3].mes = 'Edited';
    assert.equal(r.api.reconcileMemorySources(3), true);
    assert.deepEqual(hiddenIndices(r), []); assert.deepEqual(flaggedIndices(r), []);
    assert.equal(doc.querySelectorAll('#chat .mes[is_system="true"]').length, 0);
});

test('clearing while messages are being hidden leaves nothing hidden', async () => {
    const r = runtime(); r.addTurns(5);
    const original = r.ctx.executeSlashCommandsWithOptions;
    const gate = deferred(); let reached;
    const atHide = new Promise(resolve => { reached = resolve; });
    r.ctx.executeSlashCommandsWithOptions = async command => {
        if (command.startsWith('/hide')) { reached(); await gate.promise; }
        return original(command);
    };
    const work = r.api.maybeSummarizeTurns();
    await atHide;
    const clearing = r.api.clearActiveMemory();
    gate.resolve();
    await clearing; await work;
    assert.deepEqual(hiddenIndices(r), []); assert.deepEqual(flaggedIndices(r), []);
    assert.deepEqual(plain(r.api.getChatStore().ghostedIndices), []);
});

test('clear asks about the backlog again instead of silently re-hiding old messages', async () => {
    const r = runtime({ turnsPerSummary: 1 }); r.addTurns(8);
    const doc = r.dom.window.document;
    let dialog = r.api.maybeSummarizeTurns();
    doc.getElementById('sc_catchup_skip').click(); await dialog;
    await r.api.clearActiveMemory();
    dialog = r.api.maybeSummarizeTurns();
    assert.ok(doc.getElementById('sc_catchup_cancel'), 'backlog dialog is shown again');
    doc.getElementById('sc_catchup_cancel').click(); await dialog;
    assert.deepEqual(hiddenIndices(r), []); assert.equal(r.requests.length, 0);
});

test('memory database escapes quotes in attribute values from chat metadata', () => {
    const r = runtime({ separateMemoryByCharacterCard: true });
    r.api.getChatStore();
    const key = 'evil" onmouseover="alert(1)';
    const root = r.ctx.chatMetadata.summaryception;
    root.memories[key] = { layers: [[{ text: 'x', turnRange: [0, 0] }]], summarizedUpTo: 0 };
    r.api.showMemoryDatabaseModal();
    const doc = r.dom.window.document;
    assert.equal(doc.querySelectorAll('[onmouseover]').length, 0);
    assert.ok([...doc.querySelectorAll('.sc-db-bank')].some(el => el.dataset.bankKey === key));
});
