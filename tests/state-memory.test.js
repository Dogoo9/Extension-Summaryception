import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, parseStateResponse, correctState, effectiveFacts, rollbackState, validateStoredState, MAX_CHECKPOINTS, messageSignature, firstSourceChange } from '../state-memory.js';
import { assembleBudgetedMemory, assembleBudgetedMemoryAsync, createMeter } from '../memory-budget.js';

const set = (id, category, value, source) => ({ op: 'set', id, category, value, source });
const apply = (state, range, changes = []) => parseStateResponse(JSON.stringify({ summary: 'Narrative delta.', stateChanges: changes }), state, range).state;

test('item transfers, location changes, injury persistence and explicit goal resolution', () => {
    const initial = apply(emptyState(), [0, 3], [set('scene.location', 'location', 'Tavern', [0, 3]), set('item.key.owner', 'item', 'Mara', [1, 3]), set('injury.mara.hand', 'injury', 'Cut, unhealed', [2, 3]), set('goal.find_ivo', 'goal', 'Find Ivo', [0, 3])]);
    const next = apply(initial, [4, 7], [set('scene.location', 'location', 'East gate', [4, 7]), set('item.key.owner', 'item', 'Ivo', [5, 7]), { op: 'remove', id: 'goal.find_ivo', source: [6, 7] }]);
    assert.deepEqual(next.facts.map(f => [f.id, f.value]), [['injury.mara.hand', 'Cut, unhealed'], ['item.key.owner', 'Ivo'], ['scene.location', 'East gate']]);
    assert.equal(initial.facts.length, 4);
    const noChange = apply(next, [8, 9]);
    assert.deepEqual(noChange.facts, next.facts);
    assert.equal(noChange.through, 9);
});

test('strict malformed/partial changes never mutate previous state', () => {
    const state = apply(emptyState(), [0, 1], [set('scene.location', 'location', 'Gate', [0, 1])]);
    const before = JSON.stringify(state);
    for (const raw of ['{"summary":"partial"', '{"summary":"ok"}', '{"summary":"","stateChanges":[]}', '{"summary":"ok","stateChanges":[{"op":"remove","id":"missing","source":[2,3]}]}', JSON.stringify({ summary: 'ok', stateChanges: [set('x', 'invalid', 'v', [2, 3])] }), JSON.stringify({ summary: 'ok', stateChanges: [set('x', 'fact', 'v', [0, 3])] })]) {
        assert.throws(() => parseStateResponse(raw, state, [2, 3]));
        assert.equal(JSON.stringify(state), before);
    }
    assert.throws(() => parseStateResponse('{"summary":"ok","stateChanges":[]}', state, [0, 1]), /overlapping/);
});

test('manual corrections and removals lock ids until explicitly unlocked', () => {
    let state = apply(emptyState(), [0, 1], [set('item.key.owner', 'item', 'Mara', [0, 1])]);
    state = correctState(state, { id: 'item.key.owner', category: 'item', value: 'Ivo' }, 1);
    state = apply(state, [2, 3], [set('item.key.owner', 'item', 'Nobody', [2, 3])]);
    assert.equal(effectiveFacts(state)[0].value, 'Ivo');
    state = correctState(state, { id: 'item.key.owner', remove: true }, 3);
    state = apply(state, [4, 5], [set('item.key.owner', 'item', 'Mara', [4, 5])]);
    assert.deepEqual(effectiveFacts(state), []);
    state = correctState(state, { id: 'item.key.owner', unlock: true }, 5);
    state = apply(state, [6, 7], [set('item.key.owner', 'item', 'Ivo', [6, 7])]);
    assert.equal(effectiveFacts(state)[0].value, 'Ivo');
});

test('checkpoints are bounded, rollback removes later facts and manual pins', () => {
    let state = emptyState();
    for (let i = 0; i < 20; i++) state = apply(state, [i, i], [set('scene.location', 'location', `Room ${i}`, [i, i])]);
    state = correctState(state, { id: 'goal.later', category: 'goal', value: 'Future goal' }, 19);
    assert.equal(state.checkpoints.length, MAX_CHECKPOINTS);
    const restored = rollbackState(state, 15);
    assert.equal(restored.through, 14);
    assert.equal(restored.facts[0].value, 'Room 14');
    assert.equal(restored.overrides.length, 0);
    assert.equal(rollbackState(state, 0).through, -1);
    assert.deepEqual(validateStoredState(JSON.parse(JSON.stringify(state))), state);
    assert.throws(() => validateStoredState({ ...state, version: 99 }), /version/);
});

test('signatures detect edits, deletion and swipe but ignore owned hiding flags', () => {
    const chat = [{ mes: 'Hello', is_user: true }, { mes: 'Gate', swipe_id: 0 }];
    const signatures = chat.map(messageSignature);
    chat[1].is_system = true; chat[1].extra = { sc_ghosted: true };
    assert.equal(firstSourceChange(signatures, chat), -1);
    chat[1].mes = 'Castle'; assert.equal(firstSourceChange(signatures, chat), 1);
    chat[1].mes = 'Gate'; chat[1].swipe_id = 1; assert.equal(firstSourceChange(signatures, chat), 1);
    chat.pop(); assert.equal(firstSourceChange(signatures, chat), 1);
});

const facts = Array.from({ length: 30 }, (_, i) => ({ id: `goal.g${i}`, category: 'goal', value: 'Remember this complete goal '+i, source: [0, 1] }));
const options = { narrative: ['A'.repeat(600), 'Recent important event.'], facts, state: { through: 1, from: 0 }, template: '<history>{{summary}}</history>', stateAllowance: 400 };

test('budget includes wrapper, selects whole facts, surfaces overflow and preserves storage', () => {
    const meter = createMeter({ contextBudget: 250, contextBudgetUnit: 'characters' });
    const result = assembleBudgetedMemory({ ...options, meter });
    assert.ok(result.text.length <= 250);
    assert.ok(result.omittedFacts > 0);
    assert.equal(facts.length, 30);
    for (const fact of facts) if (result.text.includes(`${fact.id}:`)) assert.ok(result.text.includes(fact.value));
    assert.equal(assembleBudgetedMemory({ ...options, meter: { ...meter, budget: 2 } }).text, '');
});

test('estimated/native meters and async tokenizer enforce measured budget and state allowance', async () => {
    assert.match(createMeter({ contextBudget: 10 }).label, /estimated/);
    assert.match(createMeter({ contextBudget: 10 }, text => text.length).label, /active/);
    const count = async text => text.length; // Deliberately much denser than chars/4.
    const report = await assembleBudgetedMemoryAsync({ ...options, meter: createMeter({ contextBudget: 450 }), stateAllowance: 400 }, count);
    assert.ok(report.text.length <= 450);
    assert.ok(report.stateText.length <= 400);
    assert.equal(report.measuredTokens, report.text.length);
    assert.match(report.meterLabel, /active tokenizer/);
});

test('facts too large for allowance remain stored; missing wrapper placeholders still include memory', () => {
    const result = assembleBudgetedMemory({ ...options, facts: [{ ...facts[0], value: 'x'.repeat(400) }],
        stateAllowance: 1, template: 'Historical memory:', meter: createMeter({ contextBudget: 500, contextBudgetUnit: 'characters' }) });
    assert.equal(result.omittedFacts, 1);
    assert.ok(result.text.includes('Recent important event.'));
    assert.ok(result.text.startsWith('Historical memory:'));
});
