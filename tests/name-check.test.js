import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProperNouns, checkNameRetention, containsName, parseNameList } from '../name-check.js';

test('extractProperNouns keeps recurring or mid-phrase names and skips ordinary capitals', () => {
    const found = extractProperNouns([
        'Later, Alex meets Mara at the Gilded Anchor. The rain falls; Rain soaks Mara.',
        'She trusts Ivo. NEVER again, says Ivo.',
    ]);
    for (const name of ['Alex', 'Mara', 'Gilded', 'Anchor', 'Ivo']) assert.ok(found.includes(name), name);
    for (const word of ['Later', 'The', 'Rain', 'She', 'NEVER']) assert.ok(!found.includes(word), word);
});

test('containsName matches whole words, possessives and is case-insensitive', () => {
    assert.ok(containsName("Mara's knife", 'Mara'));
    assert.ok(containsName('met MARA', 'Mara'));
    assert.ok(!containsName('Marathon runner', 'Mara'));
    assert.ok(containsName('Ana Voss arrived', 'Ana Voss'));
});

test('parseNameList splits commas and newlines and dedupes', () => {
    assert.deepEqual(parseNameList('Mara, Ivo\nmara\n\n Captain Renn '), ['Mara', 'Ivo', 'Captain Renn']);
});

test('protected names must survive; heuristic names allow a quarter to drop', () => {
    const inputs = ['Alex meets Mara near Saltmarsh with Ivo, Renn, Odile, Pell and Quill.'];
    const keepsMostButDropsProtected = checkNameRetention(inputs, 'Alex met Ivo, Renn, Odile, Pell, Quill at Saltmarsh.', { protectedNames: ['Mara'] });
    assert.equal(keepsMostButDropsProtected.ok, false);
    assert.deepEqual(keepsMostButDropsProtected.missingProtected, ['Mara']);
    const dropsOneMinor = checkNameRetention(inputs, 'Alex met Mara, Ivo, Renn, Odile, Pell at Saltmarsh.', { protectedNames: ['Mara'] });
    assert.equal(dropsOneMinor.ok, true);
    const dropsMany = checkNameRetention(inputs, 'Alex met Mara.', { protectedNames: ['Mara'] });
    assert.equal(dropsMany.ok, false);
    assert.ok(dropsMany.missing.includes('Quill'));
    // A protected name absent from the inputs is not required.
    assert.equal(checkNameRetention(['Alex waits.'], 'Alex waits.', { protectedNames: ['Mara'] }).ok, true);
});
