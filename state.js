/**
 * Summaryception — shared mutable runtime state
 * ES modules cannot assign another module's bindings, so everything that more
 * than one module reads or writes lives on this single object.
 * AGPL-3.0
 */

const state = {
    // Summarization run lifecycle
    isSummarizing: false,           // a run holds the lock (summary, catch-up, promotion, regeneration)
    activeRun: null,                // { target, controller, backlog?, pendingSummaryTarget?, pendingSummaryMessageIndex? }
    currentAbortController: null,   // the active run's AbortController
    promptTogglesHeld: false,       // default-connection request has the preset's prompt toggles disabled
    catchupDismissed: false,        // backlog dialog answered for this chat; do not ask again
    catchupDialogClose: null,       // closes the open backlog dialog, if any
    messageReceivedTimer: null,     // debounce timer for MESSAGE_RECEIVED

    // Chat identity
    chatEpoch: 0,                   // incremented on every chat change; stale work compares against it

    // Injection
    registeredInjectionReport: null,     // last block registered with setExtensionPrompt
    injectionMeasurementSequence: 0,     // latest async token measurement wins

    // UI
    displayedMemoryBank: null,      // bank key last shown in the stats panel
};

export {
    state,
};
