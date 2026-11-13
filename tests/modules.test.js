import test from 'node:test';
import assert from 'node:assert/strict';

// The runtime tests evaluate the modules as one concatenated script, which
// cannot catch a missing export. Load the real ES module graph so a broken
// import fails here instead of in SillyTavern.
test('extension modules link as real ES modules', async () => {
    const previous = globalThis.SillyTavern;
    // init() runs on import; park it on a template render that never resolves.
    const context = {
        extensionSettings: {}, eventTypes: {}, saveSettingsDebounced() {},
        eventSource: { on() {} }, renderExtensionTemplateAsync: () => new Promise(() => {}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    try {
        for (const name of ['constants', 'settings', 'prompt-toggles', 'core', 'settings-ui', 'connection-ui', 'index']) {
            await assert.doesNotReject(import(`../${name}.js`), name);
        }
        assert.ok(context.extensionSettings.summaryception, 'index.js ran init() with linked modules');
    } finally {
        globalThis.SillyTavern = previous;
    }
});
