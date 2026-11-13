/**
 * Summaryception v5.5.7 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * Module layout:
 *   constants.js       tuning constants, prompts and default settings
 *   state.js           shared mutable runtime state (run lock, abort controller, chat epoch, ...)
 *   settings.js        settings access and logging
 *   util.js            retry, delay and toast helpers
 *   store.js           memory banks: storage, normalization, card identity, migration
 *   ghosting.js        message hiding (/hide, /unhide) and source-change repair
 *   passages.js        turn selection, passage building, summarizer context
 *   run.js             run lifecycle, cancellation and stale-result guards
 *   prompt-toggles.js  prompt-manager toggles for default-connection requests
 *   summarize.js       summarizer calls, batching, catch-up and layer promotion
 *   injection.js       budgeted memory block and setExtensionPrompt registration
 *   events.js          SillyTavern event handlers and slash commands
 *   snippet-browser.js snippet browser (edit, pin, regenerate, delete)
 *   memory-db-ui.js    memory database viewer, bank export, legacy bank cleanup
 *   settings-ui.js     settings panel bindings, stats, injection inspector, import/export
 *   connection-ui.js   summarizer connection settings
 *   connectionutil.js, memory-budget.js, name-check.js, source-signatures.js: standalone helpers
 *
 * AGPL-3.0
 */

import {
    EXTENSION_VERSION,
} from './constants.js';
import {
    getSettings,
    log,
} from './settings.js';
import {
    activateCharacterMemoryStore,
} from './store.js';
import {
    repairIfBranched,
} from './ghosting.js';
import {
    updateInjection,
} from './injection.js';
import {
    onChatChanged,
    onGenerationStarted,
    onMessageReceived,
    onSourceMessageChanged,
    registerSlashCommands,
} from './events.js';
import {
    bindUIEvents,
    updateUI,
} from './settings-ui.js';
import {
    initConnectionUI,
} from './connection-ui.js';

// ─── Initialization ──────────────────────────────────────────────────

(async function init() {
    const context = SillyTavern.getContext();
    const {
        eventSource,
        renderExtensionTemplateAsync,
    } = context;
    const event_types = context.eventTypes || context.event_types;

    getSettings();

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);

    bindUIEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED', 'CHARACTER_MESSAGE_RENDERED']) {
        if (event_types[name]) eventSource.on(event_types[name], name === 'CHARACTER_MESSAGE_RENDERED' ? () => onSourceMessageChanged() : onSourceMessageChanged);
    }

    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        updateUI();
        log(`v${EXTENSION_VERSION} loaded. Connection Settings available`);
    });
    // Extensions can be enabled after APP_READY has already fired.
    await repairIfBranched();
    await activateCharacterMemoryStore();
    updateInjection();
    updateUI();
})();
