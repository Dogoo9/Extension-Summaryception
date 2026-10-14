import test from 'node:test';
import assert from 'node:assert/strict';
import { messageSignature, firstSourceChange } from '../source-signatures.js';
import { createMeter, assembleBudgetedMemory, assembleBudgetedMemoryAsync } from '../memory-budget.js';

test('source signatures detect edits/deletion/swipe but ignore owned hiding flags', () => {
    const chat = [{ mes: 'Hello', is_user: true }, { mes: 'Gate', swipe_id: 0 }];
    const signatures = chat.map(messageSignature);
    chat[1].is_system = true; chat[1].extra = { sc_ghosted: true };
    assert.equal(firstSourceChange(signatures, chat), -1);
    chat[1].mes = 'Castle'; assert.equal(firstSourceChange(signatures, chat), 1);
    chat[1].mes = 'Gate'; chat[1].swipe_id = 1; assert.equal(firstSourceChange(signatures, chat), 1);
    chat.pop(); assert.equal(firstSourceChange(signatures, chat), 1);
});

const options = { narrative: [{ text: 'Earlier memory', order: 0 }, { text: 'x'.repeat(800), order: 1 }, { text: 'Recent event', order: 2 }], template: '<history>{{summary}}</history>' };

test('budget counts wrappers, omits whole snippets, and keeps selected snippets chronological', () => {
    const narrative = [...options.narrative].reverse();
    const meter = createMeter({ contextBudget: 60, contextBudgetUnit: 'characters' });
    const result = assembleBudgetedMemory({ ...options, narrative, meter });
    assert.equal(result.text, '<history>Earlier memory\nRecent event</history>');
    assert.equal(result.omittedSnippets, 1); assert.equal(narrative[1].text.length, 800);
    assert.equal(assembleBudgetedMemory({ ...options, meter: { ...meter, budget: 2 } }).text, '');
});

test('async tokenization enforces measured total; unavailable tokenizers label the fallback', async () => {
    const meter = createMeter({ contextBudget: 60 });
    assert.match(meter.label, /estimated/);
    const result = await assembleBudgetedMemoryAsync({ ...options, meter }, async text => text.length);
    assert.ok(result.text.length <= 60); assert.equal(result.measuredTokens, result.text.length);
    assert.match(result.meterLabel, /active tokenizer/);
    const fallback = await assembleBudgetedMemoryAsync({ ...options, meter }, async () => { throw new Error('Unavailable'); });
    assert.match(fallback.meterLabel, /tokenizer unavailable/);
});

test('missing wrapper placeholders append memory and literal replacement syntax remains literal', () => {
    const meter = createMeter({ contextBudget: 500, contextBudgetUnit: 'characters' });
    assert.equal(assembleBudgetedMemory({ narrative: ['Event'], template: 'History:', meter }).text, 'History:\nEvent');
    assert.equal(assembleBudgetedMemory({ narrative: ['$& $$'], template: '{{summary}}', meter }).text, '$& $$');
});
