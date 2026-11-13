/**
 * Summaryception — settings panel, snippet browser and memory database viewer
 * AGPL-3.0
 */

import {
    INJECTION_POSITION_LABELS,
    MODULE_NAME,
    PREVIOUS_NARRATIVE_PROMPT,
    PROMPT_PRESETS,
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
    escapeHtml,
} from './util.js';
import {
    activateCharacterMemoryStore,
    clearActiveMemory,
    getAllMemoryStores,
    getCharacterMemoryKey,
    getCharacterMemoryLabel,
    getChatStore,
    getSummarizedRangeStart,
    invalidateContextCache,
    persistMemoryDatabaseChange,
    validateMemoryImport,
} from './store.js';
import {
    ghostMessagesUpTo,
    reconcileMemorySources,
    repairIfBranched,
    unghostAllMessages,
} from './ghosting.js';
import {
    unsummarizedTurns,
} from './passages.js';
import {
    abortSummarization,
    captureMemoryTarget,
    targetIsCurrent,
    updateProcessingUI,
} from './run.js';
import {
    regenerateSnippets,
    runCatchup,
    summarizeOneBatch,
} from './summarize.js';
import {
    assembleSummaryBlock,
    getInjectionDepthValue,
    updateInjection,
    updateInjectionDebugOverlay,
} from './injection.js';
import {
    updateSnippetBrowser,
} from './snippet-browser.js';
import {
    confirmAndCleanupLegacyMemoryBanks,
    getMemoryBankAttachment,
    getMemoryBankLabel,
    showMemoryDatabaseModal,
} from './memory-db-ui.js';
import {
    syncConnectionUIFromSettings,
} from './connection-ui.js';

// ─── Settings UI ─────────────────────────────────────────────────────

function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
        $('#sc_strict_verbatim_window').prop('checked', s.strictVerbatimWindow);
        $('#sc_promotion_name_check').prop('checked', s.promotionNameCheck);
        $('#sc_archive_promoted').prop('checked', s.archivePromotedSnippets);
        $('#sc_protected_names').val(s.protectedNames || '');
        $('#sc_separate_by_character').prop('checked', s.separateMemoryByCharacterCard);
        $('#sc_verbatim_turns').val(s.verbatimTurns);
        $('#sc_verbatim_turns_val').text(s.verbatimTurns);
        $('#sc_turns_per_summary').val(s.turnsPerSummary);
        $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
        $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
        $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
        $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
        $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
        $('#sc_max_layers').val(s.maxLayers);
        $('#sc_max_layers_val').text(s.maxLayers);
        $('#sc_context_budget').val(s.contextBudget);
        $('#sc_context_budget_unit').val(s.contextBudgetUnit);
        $('#sc_injection_template').val(s.injectionTemplate);
        $('#sc_injection_position').val(s.injectionPosition || defaultSettings.injectionPosition);
        $('#sc_injection_depth').val(getInjectionDepthValue(s));
        $('#sc_injection_depth_val').text(getInjectionDepthValue(s));
        $('#sc_injection_role').val(s.injectionRole || defaultSettings.injectionRole);
        $('#sc_injection_scan').prop('checked', Boolean(s.injectionScan));
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        // ── Prompt preset migration & sync ──
        // Upgrade only exact prior built-ins. Never replace user-authored text.
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();
            const previousNarrativePrompt = PREVIOUS_NARRATIVE_PROMPT.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt || currentPrompt === previousNarrativePrompt) {
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                // User customized their prompt — mark as custom
                s.promptPreset = 'custom';
                saveSettings();
            }
        } else if (s.promptPreset === 'narrative'
            && (s.summarizerUserPrompt || '').trim() === PREVIOUS_NARRATIVE_PROMPT.trim()) {
            // The preset field already existed when this built-in prompt changed.
            s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
            saveSettings();
        }

        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_injection_debug_overlay_enabled').prop('checked', s.injectionDebugOverlay);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        let ghostedCount = 0;
        try {
            const { chat } = SillyTavern.getContext();
            ghostedCount = chat.filter(m => m.extra?.sc_ghosted).length;
        } catch (e) { /* no chat loaded */ }

        let statsHtml = '';
        if (s.separateMemoryByCharacterCard) {
            statsHtml += `<div class="sc-layer-stat">🃏 Active card memory: <strong>${escapeHtml(getCharacterMemoryLabel())}</strong></div>`;
            statsHtml += `<div class="sc-layer-stat sc-muted">Memory banks in this chat: ${getAllMemoryStores().length}</div>`;
        }
        const injectionPositionLabel = INJECTION_POSITION_LABELS[s.injectionPosition] || INJECTION_POSITION_LABELS.in_prompt;
        const injectionSuffix = s.injectionPosition === 'in_chat'
            ? ` at depth ${getInjectionDepthValue(s)}`
            : '';
        statsHtml += `<div class="sc-layer-stat">📌 Injection: <strong>${escapeHtml(injectionPositionLabel)}</strong>${escapeHtml(injectionSuffix)} as ${escapeHtml(s.injectionRole || 'system')}</div>`;
        statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }
        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');
        updateInjectionInspector(preview);

        updateProcessingUI();
        updateSnippetBrowser();
        renderCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
}

function updateInjectionInspector(preview = assembleSummaryBlock()) {
    const s = getSettings();
    const registered = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME];
    const registeredValue = registered?.value || '';
    const matches = registeredValue === String(preview || '');
    const positionLabel = INJECTION_POSITION_LABELS[s.injectionPosition] || 'Prompt';
    const html = [
        `<div class="sc-layer-stat">🔎 Registered: <strong>${registeredValue ? 'yes' : 'no'}</strong> · matches preview: <strong>${matches ? 'yes' : 'no'}</strong></div>`,
        `<div class="sc-layer-stat">📌 Position: <strong>${escapeHtml(positionLabel)}</strong>${s.injectionPosition === 'in_chat' ? ` at depth ${getInjectionDepthValue(s)}` : ''} · role: <strong>${escapeHtml(s.injectionRole || 'system')}</strong> · World Info scan: <strong>${s.injectionScan ? 'on' : 'off'}</strong></div>`,
        `<div class="sc-layer-stat">📏 Preview: <strong>${(preview || '').length}</strong> chars / ~${estimateTokens(preview)} tokens · Registered: <strong>${registeredValue.length}</strong> chars / ~${estimateTokens(registeredValue)} tokens</div>`,
        (() => {
            const report = state.registeredInjectionReport;
            return report ? `<div class="sc-layer-stat">Budget: ${escapeHtml(report.meterLabel)}${report.measuredTokens != null ? ` · measured injection: ${report.measuredTokens} tokens` : ''}. Omitted from injection: ${report.omittedSnippets} snippets (still stored).</div>` : '';
        })(),
        registered && typeof registered === 'object'
            ? `<details><summary>Raw registered extension prompt object</summary><pre>${escapeHtml(JSON.stringify(registered, null, 2))}</pre></details>`
            : '',
    ].join('');
    $('#sc_injection_inspector').html(html);
}

function renderCustomPromptSlots() {
    const s = getSettings();
    const select = document.getElementById('sc_custom_prompt_slot');
    if (!select) return;
    const selected = select.value;
    select.replaceChildren(new Option('-- Load a saved prompt --', ''));
    for (const prompt of s.savedCustomPrompts) select.add(new Option(prompt.name, prompt.id));
    select.value = selected;
    $('#sc_custom_prompt_manager').toggle(s.promptPreset === 'custom');
}

function bindCustomPromptUI() {
    const apply = text => {
        const s = getSettings();
        s.summarizerUserPrompt = text;
        s.promptPreset = 'custom';
        saveSettings();
        updateUI();
    };
    $('#sc_custom_prompt_save').on('click', () => {
        const name = String($('#sc_custom_prompt_name').val() || '').trim();
        if (!name) { toastr.warning('Enter a prompt name.', 'Summaryception'); return; }
        const s = getSettings();
        const existing = s.savedCustomPrompts.find(prompt => prompt.name === name);
        if (existing && !confirm(`Replace saved prompt "${name}"?`)) return;
        if (existing) existing.text = s.summarizerUserPrompt;
        else s.savedCustomPrompts.push({ id: crypto.randomUUID(), name, text: s.summarizerUserPrompt });
        saveSettings();
        renderCustomPromptSlots();
        toastr.success('Custom prompt saved.', 'Summaryception');
    });
    $('#sc_custom_prompt_load').on('click', () => {
        const prompt = getSettings().savedCustomPrompts.find(item => item.id === $('#sc_custom_prompt_slot').val());
        if (!prompt) { toastr.warning('Select a saved prompt.', 'Summaryception'); return; }
        apply(prompt.text);
    });
    $('#sc_custom_prompt_delete_slot').on('click', () => {
        const s = getSettings();
        const id = $('#sc_custom_prompt_slot').val();
        const prompt = s.savedCustomPrompts.find(item => item.id === id);
        if (!prompt || !confirm(`Delete saved prompt "${prompt.name}"?`)) return;
        s.savedCustomPrompts = s.savedCustomPrompts.filter(item => item.id !== id);
        saveSettings(); renderCustomPromptSlots();
    });
    $('#sc_custom_prompt_export').on('click', () => {
        const blob = new Blob([getSettings().summarizerUserPrompt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = 'summaryception_prompt.txt'; link.click(); URL.revokeObjectURL(url);
    });
    $('#sc_custom_prompt_import').on('click', () => {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.txt';
        input.onchange = async event => {
            try {
                const file = event.target.files[0];
                if (!file) return;
                const text = await file.text();
                if (!text.trim()) throw new Error('The prompt file is empty.');
                apply(text);
            } catch (error) { toastr.error(error.message, 'Summaryception'); }
        };
        input.click();
    });
}

function bindUIEvents() {
    $('#sc_enabled').on('change', async function () {
        abortSummarization();
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        if (getSettings().enabled) await activateCharacterMemoryStore();
        else await unghostAllMessages();
        await persistMemoryDatabaseChange();
    });

    $('#sc_pause_summarization').on('change', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            abortSummarization();
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: TUNING.toastMedium }
            );
        }
    });

    $('#sc_archive_promoted').on('change', function () {
        getSettings().archivePromotedSnippets = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_promotion_name_check').on('change', function () {
        getSettings().promotionNameCheck = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_protected_names').on('change', function () {
        getSettings().protectedNames = String($(this).val() || '');
        saveSettings();
    });

    $('#sc_strict_verbatim_window').on('change', function () {
        getSettings().strictVerbatimWindow = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_disable_ghosting').on('change', async function () {
        abortSummarization();
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();
        await unghostAllMessages();
        await activateCharacterMemoryStore();
        await persistMemoryDatabaseChange();
    });

    $('#sc_separate_by_character').on('change', async function () {
        abortSummarization();
        const previousStore = getChatStore();
        await unghostAllMessages(previousStore);
        const s = getSettings();
        s.separateMemoryByCharacterCard = $(this).prop('checked');
        saveSettings();
        await activateCharacterMemoryStore();
        updateInjection();
        updateUI();
        toastr.info(
            s.separateMemoryByCharacterCard
                ? 'Character-card memory separation enabled for this chat. The active card now has its own memory bank.'
                : 'Character-card memory separation disabled. This chat will use one shared memory bank.',
            'Summaryception',
            { timeOut: TUNING.toastLonger }
        );
    });

    $('#sc_summarizer_response_length').on('input', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    bindCustomPromptUI();

    $('#sc_reset_defaults').on('click', async () => {
        if (!confirm('Reset Summaryception settings? This preserves chat memory and saved profiles/prompts, but resets active connection settings.')) return;
        abortSummarization();
        const s = getSettings();
        const saved = { savedConnectionProfiles: s.savedConnectionProfiles, savedCustomPrompts: s.savedCustomPrompts };
        await unghostAllMessages();
        Object.assign(s, structuredClone(defaultSettings), saved);
        saveSettings();
        await activateCharacterMemoryStore();
        syncConnectionUIFromSettings();
        await persistMemoryDatabaseChange();
    });

    $('#sc_context_budget').on('change', function () {
        getSettings().contextBudget = Math.max(1, parseInt($(this).val(), 10) || defaultSettings.contextBudget);
        saveSettings();
        updateInjection();
    });

    $('#sc_context_budget_unit').on('change', function () {
        getSettings().contextBudgetUnit = $(this).val() === 'characters' ? 'characters' : 'tokens';
        saveSettings();
        updateInjection();
    });

    $('#sc_strip_patterns').on('change', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });

    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        { id: '#sc_turns_per_summary', key: 'turnsPerSummary', display: '#sc_turns_per_summary_val' },
        { id: '#sc_snippets_per_layer', key: 'snippetsPerLayer', display: '#sc_snippets_per_layer_val' },
        { id: '#sc_snippets_per_promotion', key: 'snippetsPerPromotion', display: '#sc_snippets_per_promotion_val' },
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
    ];

    for (const sl of sliders) {
        $(sl.id).on('input', function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val;
            $(sl.display).text(val);
            saveSettings();
            updateInjection();
        });
    }

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(ta.id).on('change', function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
            if (ta.key === 'injectionTemplate') updateInjection();
        });
    }

    $('#sc_injection_position').on('change', function () {
        getSettings().injectionPosition = $(this).val();
        saveSettings();
        updateInjection();
        updateUI();
    });

    $('#sc_injection_depth').on('input', function () {
        const val = parseInt($(this).val(), 10);
        getSettings().injectionDepth = Number.isFinite(val) ? val : defaultSettings.injectionDepth;
        $('#sc_injection_depth_val').text(getSettings().injectionDepth);
        saveSettings();
        updateInjection();
    });

    $('#sc_injection_role').on('change', function () {
        getSettings().injectionRole = $(this).val();
        saveSettings();
        updateInjection();
        updateUI();
    });

    $('#sc_injection_scan').on('change', function () {
        getSettings().injectionScan = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $('#sc_test_injection').on('click', function () {
        const hadSummary = updateInjection();
        const ctx = SillyTavern.getContext();
        const registered = ctx.extensionPrompts?.[MODULE_NAME];
        if (!hadSummary || !registered?.value) {
            toastr.warning('No Summaryception summary is currently available to inject. Create or import a summary first.', 'Summaryception', { timeOut: TUNING.toastLonger });
            return;
        }
        const positionLabel = INJECTION_POSITION_LABELS[getSettings().injectionPosition] || 'Prompt';
        toastr.success(
            `Injection registered (${registered.value.length} chars, ${positionLabel}, role ${getSettings().injectionRole}). Check Prompt Inspector on the next generation to verify placement.`,
            'Summaryception',
            { timeOut: 7000 }
        );
    });

    $('#sc_debug_mode').on('change', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_injection_debug_overlay_enabled').on('change', function () {
        getSettings().injectionDebugOverlay = $(this).prop('checked');
        saveSettings();
        updateInjectionDebugOverlay();
    });

    $('#sc_trace_mode').on('change', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_repair').on('click', async function () {
        abortSummarization();
        await repairIfBranched();
        const { chat } = SillyTavern.getContext();
        const store = getChatStore();
        const covered = new Set(store.ghostedIndices);
        const target = captureMemoryTarget();
        for (let i = 0; i < chat.length && targetIsCurrent(target); i++) {
            if (chat[i]?.extra?.sc_ghosted && (!covered.has(i) || i > store.summarizedUpTo)) {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, { showOutput: false });
                delete chat[i].extra.sc_ghosted;
            }
        }
        if (!targetIsCurrent(target)) return;
        await ghostMessagesUpTo(store.summarizedUpTo, getSummarizedRangeStart(store));
        await persistMemoryDatabaseChange();
        toastr.success('Summaryception-owned visibility repaired. Manually hidden messages preserved.', 'Summaryception');
    });

    $('#sc_view_database').on('click', function () {
        showMemoryDatabaseModal();
    });

    $('#sc_cleanup_legacy_banks').on('click', async function () {
        await confirmAndCleanupLegacyMemoryBanks();
    });

    $('#sc_clear_memory').on('click', async function () {
        if (!confirm('Clear Summaryception memory for the active memory bank and unghost its messages?')) return;
        await clearActiveMemory();
        toastr.success('Active Summaryception memory cleared and messages unghosted.', 'Summaryception');
    });

    $('#sc_force_summarize').on('click', async function () {
        const s = getSettings();
        if (!s.enabled) { toastr.warning('Enable Summaryception first.'); return; }
        if (state.isSummarizing) { toastr.warning('Already summarizing. Please wait.'); return; }
        await repairIfBranched();
        const target = captureMemoryTarget();
        if (target.store.summarizedUpTo < 0) await unghostAllMessages();
        if (!targetIsCurrent(target)) return;
        const turns = unsummarizedTurns(target.chat, target.store);
        $(this).prop('disabled', true).text(' Working…');
        try {
            state.catchupDismissed = true;
            if (turns.length > s.verbatimTurns) await runCatchup(turns, turns.length - s.verbatimTurns, true);
            else if (turns.length) await summarizeOneBatch(turns); // Explicit force may use the verbatim window.
            else toastr.info('Nothing to summarize.', 'Summaryception');
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateInjection();
            updateUI();
        }
    });

    $('#sc_stop_summarize, #sc_cancel_backlog').on('click', function () {
        if (!state.isSummarizing) return;
        abortSummarization();
        toastr.info('Canceling summarization. Completed backlog batches are kept.', 'Summaryception');
    });

    $('#sc_regenerate_latest').on('click', async () => {
        const snippets = getChatStore().layers.flat().filter(sn => sn.turnRange)
            .sort((a, b) => a.turnRange[1] - b.turnRange[1]);
        const all = $('#sc_regenerate_scope').val() === 'all';
        if (all && snippets.length && !confirm(`Regenerate all ${snippets.length} summaries from original messages using the current prompt? This uses one call per snippet; originals are kept if canceled or failed.`)) return;
        await regenerateSnippets(all ? snippets : snippets.slice(-1));
    });

    $('#sc_refresh_preview').on('click', () => updateUI());
    $('#sc_copy_injected').on('click', async () => {
        const value = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME]?.value || '';
        if (!value) {
            toastr.warning('No Summaryception injection is currently registered.', 'Summaryception');
            return;
        }
        await navigator.clipboard.writeText(value);
        toastr.success('Registered Summaryception injection copied.', 'Summaryception');
    });

    $('#sc_export').on('click', function () {
        const store = getChatStore();
        const key = getSettings().separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat';
        const exportedBank = {
            format: 'summaryception-memory-bank-v3',
            key,
            label: getMemoryBankLabel(key),
            attachment: getMemoryBankAttachment(key),
            store,
        };
        const blob = new Blob([JSON.stringify(exportedBank, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $('#sc_import').on('click', function () {
        const target = captureMemoryTarget();
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = async event => {
            const file = event.target.files[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                if (!targetIsCurrent(target)) throw new Error('Chat/card changed while selecting an import.');
                const imported = validateMemoryImport(data);
                abortSummarization();
                invalidateContextCache(target.store);
                await unghostAllMessages();
                if (!targetIsCurrent(target)) return;
                Object.assign(target.store, imported, { ghostedIndices: [] });
                invalidateContextCache(target.store);
                reconcileMemorySources();
                if (getSettings().enabled) await ghostMessagesUpTo(target.store.summarizedUpTo, getSummarizedRangeStart(target.store));
                if (!targetIsCurrent(target)) return;
                await persistMemoryDatabaseChange();
                toastr.success('Memory imported into the active bank.', 'Summaryception');
            } catch (error) { toastr.error(`Import failed: ${error.message}`, 'Summaryception'); }
        };
        input.click();
    });

    // ── Prompt Preset dropdown ──
    $('#sc_prompt_preset').on('change', function () {
        const selected = $(this).val();
        const s = getSettings();
        s.promptPreset = selected;

        if (selected !== 'custom') {
            // Overwrite textarea with the selected preset
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
        }
        // 'custom' leaves the textarea untouched for user editing

        saveSettings();
        renderCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $('#sc_summarizer_user_prompt').on('input', function () {
        const currentText = $(this).val();
        const s = getSettings();

        // Always sync the prompt text
        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                s.promptPreset = 'custom';
                $('#sc_prompt_preset').val('custom');
                renderCustomPromptSlots();
            }
        }

        saveSettings();
    });
}

export {
    bindUIEvents,
    estimateTokens,
    updateInjectionInspector,
    updateUI,
};
