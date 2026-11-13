/**
 * Summaryception — settings access and logging
 * AGPL-3.0
 */

import {
    LOG_PREFIX,
    MODULE_NAME,
    defaultSettings,
} from './constants.js';

// ─── Settings access and logging ─────────────────────────────────────

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function trace(...args) {
    const s = getSettings();
    if (s.debugMode && s.traceMode) {
        const normalized = args.map((arg, idx) => (idx === 0 && typeof arg === 'string')
            ? arg.toUpperCase()
            : arg);
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    const settings = extensionSettings[MODULE_NAME];
    if (Object.hasOwn(settings, 'structuredStateEnabled') || Object.hasOwn(settings, 'stateTokenAllowance')) {
        delete settings.structuredStateEnabled;
        delete settings.stateTokenAllowance;
        SillyTavern.getContext().saveSettingsDebounced();
    }
    return settings;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

export {
    getSettings,
    log,
    saveSettings,
    trace,
};
