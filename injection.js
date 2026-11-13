/**
 * Summaryception — budgeted memory block and registration with setExtensionPrompt
 * AGPL-3.0
 */

import {
    assembleBudgetedMemory,
    createMeter,
} from './memory-budget.js';
import {
    EXTENSION_PROMPT_ROLES,
    EXTENSION_PROMPT_TYPES,
    INJECTION_POSITION_LABELS,
    LOG_PREFIX,
    MODULE_NAME,
    TUNING,
    defaultSettings,
} from './constants.js';
import {
    state,
} from './state.js';
import {
    getSettings,
    log,
    saveSettings,
} from './settings.js';
import {
    getChatStore,
    injectionReports,
    saveChatStore,
    snippetText,
} from './store.js';
import {
    reconcileMemorySources,
} from './ghosting.js';
import {
    estimateTokens,
} from './settings-ui.js';

function getMemoryMeter() {
    const ctx = SillyTavern.getContext();
    // Modern ST exposes async token counting. Use a synchronous tokenizer only
    // when one is available; never pretend an estimate is a measured token count.
    const tokenize = typeof ctx.getTokenCount === 'function' && ctx.getTokenCount.constructor.name !== 'AsyncFunction'
        ? text => ctx.getTokenCount(text) : undefined;
    return createMeter(getSettings(), tokenize);
}

function getMemoryAssemblyOptions() {
    const s = getSettings();
    const store = getChatStore();
    const snippets = [];
    for (let i = store.layers.length - 1; i >= 0; i--) snippets.push(...(store.layers[i] || []));
    // Prioritize canonical deepest history, then newest unpromoted events;
    // render accepted snippets in chronological order.
    const deepest = store.layers.findLastIndex(layer => layer?.length);
    const canonicalCount = deepest >= 0 ? store.layers[deepest].length : 0;
    const narrative = snippets.map((sn, order) => ({ text: snippetText(sn), order, pinned: Boolean(sn.pinned) }));
    const ordered = [...narrative.slice(0, canonicalCount), ...narrative.slice(canonicalCount).reverse()];
    // Pinned snippets are selected first; accepted snippets still render chronologically.
    const prioritized = [...ordered.filter(item => item.pinned), ...ordered.filter(item => !item.pinned)];
    return {
        narrative: prioritized,
        template: s.injectionTemplate || defaultSettings.injectionTemplate,
        meter: getMemoryMeter(),
    };
}

function assembleSummaryBlock() {
    const store = getChatStore();
    const report = assembleBudgetedMemory(getMemoryAssemblyOptions());
    injectionReports.set(store, report);
    return report.text;
}

function getInjectionPositionValue(position) {
    switch (position) {
        case 'in_chat':
            return EXTENSION_PROMPT_TYPES.IN_CHAT;
        case 'before_prompt':
            return EXTENSION_PROMPT_TYPES.BEFORE_PROMPT;
        case 'in_prompt':
        default:
            return EXTENSION_PROMPT_TYPES.IN_PROMPT;
    }
}

function getInjectionRoleValue(role) {
    return EXTENSION_PROMPT_ROLES[role] ?? EXTENSION_PROMPT_ROLES.system;
}

function getInjectionDepthValue(settings) {
    const parsed = Number(settings.injectionDepth);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    return defaultSettings.injectionDepth;
}

function getInjectionDebugSummary(value, position, depth, scan, role) {
    return {
        chars: value?.length || 0,
        position,
        positionLabel: INJECTION_POSITION_LABELS[getSettings().injectionPosition] || 'Prompt',
        depth,
        scan,
        role,
        roleLabel: getSettings().injectionRole || 'system',
    };
}

function injectionConfigurationKey() {
    const s = getSettings();
    return JSON.stringify([s.enabled, s.contextBudget, s.contextBudgetUnit, s.injectionTemplate,
        s.injectionPosition, s.injectionDepth, s.injectionRole, s.injectionScan]);
}

function updateInjectionDebugOverlay() {
    let panel = document.getElementById('sc_injection_debug_overlay');
    if (!getSettings().injectionDebugOverlay) { panel?.remove(); return; }
    if (!panel) {
        panel = document.createElement('section');
        panel.id = 'sc_injection_debug_overlay';
        panel.className = 'sc-injection-debug-overlay';
        panel.setAttribute('aria-label', 'Summaryception injection debug overlay');
        panel.innerHTML = `<div class="sc-debug-header"><strong>Summaryception · Injection Debug</strong><button type="button" class="menu_button sc-debug-close" aria-label="Close injection debug overlay">×</button></div>
            <p class="sc-hint">Live registered memory block. Use SillyTavern's Prompt Inspector to inspect the complete final prompt.</p>
            <div class="sc-debug-metadata"></div><pre class="sc-debug-text"></pre>`;
        panel.querySelector('.sc-debug-close').addEventListener('click', () => {
            getSettings().injectionDebugOverlay = false;
            saveSettings();
            $('#sc_injection_debug_overlay_enabled').prop('checked', false);
            panel.remove();
        });
        document.body.appendChild(panel);
    }
    const registered = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME];
    const value = registered?.value || '';
    const report = state.registeredInjectionReport;
    panel.querySelector('.sc-debug-metadata').textContent = [
        `Position ${registered?.position ?? 'unregistered'} · depth ${registered?.depth ?? '—'} · role ${registered?.role ?? '—'} · World Info scan ${registered?.scan ? 'on' : 'off'}`,
        `${value.length} characters · ${report?.measuredTokens != null ? `${report.measuredTokens} measured tokens` : `~${estimateTokens(value)} estimated tokens`}`,
        report ? `Budget: ${report.meterLabel}. ${report.omittedSnippets} snippets omitted (still stored).` : '',
    ].filter(Boolean).join('\n');
    // Never interpret model/user memory text as markup.
    panel.querySelector('.sc-debug-text').textContent = value || '(No Summaryception injection registered)';
}

function setSummaryceptionExtensionPrompt(value) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();

    if (typeof ctx.setExtensionPrompt !== 'function') {
        throw new Error('SillyTavern setExtensionPrompt API is not available. Update SillyTavern or reload the page.');
    }

    const position = getInjectionPositionValue(s.injectionPosition);
    const depth = getInjectionDepthValue(s);
    const scan = Boolean(s.injectionScan);
    const role = getInjectionRoleValue(s.injectionRole);

    ctx.setExtensionPrompt(MODULE_NAME, value || '', position, depth, scan, role);
    state.registeredInjectionReport = value ? injectionReports.get(getChatStore()) || null : null;
    updateInjectionDebugOverlay();

    const registered = ctx.extensionPrompts?.[MODULE_NAME];
    if (registered && registered.value !== String(value || '')) {
        console.warn(LOG_PREFIX, 'Extension prompt registry did not retain the expected value.', registered);
    }

    return getInjectionDebugSummary(value || '', position, depth, scan, role);
}

function updateInjection() {
    try {
        if (reconcileMemorySources()) {
            // Reconciliation is synchronous; persist without delaying prompt assembly.
            saveChatStore().catch(error => log('Could not persist source repair:', error));
        }
        const s = getSettings();

        if (!s.enabled) {
            const info = setSummaryceptionExtensionPrompt('');
            log('Injection cleared because Summaryception is disabled:', info);
            return false;
        }

        const summaryBlock = assembleSummaryBlock();
        if (!summaryBlock) {
            const info = setSummaryceptionExtensionPrompt('');
            log('Injection cleared because there is no summary block:', info);
            return false;
        }

        const info = setSummaryceptionExtensionPrompt(summaryBlock);
        log('Injection updated:', info);
        return true;
    } catch (e) {
        console.error(LOG_PREFIX, 'updateInjection error:', e);
        toastr.error(`Summary injection failed: ${e.message || e}`, 'Summaryception', { timeOut: TUNING.toastError });
        return false;
    }
}

export {
    assembleSummaryBlock,
    getInjectionDepthValue,
    getMemoryAssemblyOptions,
    injectionConfigurationKey,
    setSummaryceptionExtensionPrompt,
    updateInjection,
    updateInjectionDebugOverlay,
};
