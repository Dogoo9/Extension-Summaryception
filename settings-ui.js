/**
 * Summaryception — settings panel, snippet browser and memory database viewer
 * AGPL-3.0
 */

import {
    INJECTION_POSITION_LABELS,
    LOG_PREFIX,
    MODULE_NAME,
    PREVIOUS_NARRATIVE_PROMPT,
    PROMPT_PRESETS,
    TUNING,
    defaultSettings,
} from './constants.js';
import {
    getSettings,
    log,
    saveSettings,
} from './settings.js';
import {
    abortSummarization,
    activateCharacterMemoryStore,
    assembleSummaryBlock,
    beginSummarization,
    buildPassageFromRange,
    callSummarizer,
    captureMemoryTarget,
    captureTransaction,
    clearPersistentToast,
    deleteMemoryBank,
    finishSummarization,
    fitContextParts,
    getAllMemoryStores,
    getCharacterMemoryKey,
    getCharacterMemoryLabel,
    getChatStore,
    getContextBudgetCharacters,
    getCurrentChatAttachmentInfo,
    getInjectionDepthValue,
    getMemorySnippetByPath,
    getMemoryStoreByKey,
    getSummarizedRangeStart,
    ghostMessagesUpTo,
    invalidateContextCache,
    isSummarizing,
    normalizeCardFilename,
    normalizeChatStore,
    persistMemoryDatabaseChange,
    reconcileMemorySources,
    registeredInjectionReport,
    repairIfBranched,
    restoreUncoveredGhosts,
    runCatchup,
    runIsCurrent,
    saveChatStore,
    setCatchupDismissed,
    storeRevisions,
    summarizeOneBatch,
    targetIsCurrent,
    transactionIsCurrent,
    truncateMemoryStore,
    unghostAllMessages,
    unsummarizedTurns,
    updateInjection,
    updateInjectionDebugOverlay,
    updateProcessingUI,
} from './core.js';
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
            const report = registeredInjectionReport;
            return report ? `<div class="sc-layer-stat">Budget: ${escapeHtml(report.meterLabel)}${report.measuredTokens != null ? ` · measured injection: ${report.measuredTokens} tokens` : ''}. Omitted from injection: ${report.omittedSnippets} snippets (still stored).</div>` : '';
        })(),
        registered && typeof registered === 'object'
            ? `<details><summary>Raw registered extension prompt object</summary><pre>${escapeHtml(JSON.stringify(registered, null, 2))}</pre></details>`
            : '',
    ].join('');
    $('#sc_injection_inspector').html(html);
}

function getMemoryBankLabel(key) {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    if (root?.memoryIdentities?.[key]?.characterName) return root.memoryIdentities[key].characterName;
    if (root?.memoryLabels?.[key]) return root.memoryLabels[key];
    if (root?.memoryAttachments?.[key]?.characterName) return root.memoryAttachments[key].characterName;
    if (key === getCharacterMemoryKey()) return getCharacterMemoryLabel();
    if (key === 'chat') return 'Shared chat memory';
    return key.replace(/^character:/, 'Character ');
}

function getMemoryBankAttachment(key) {
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    const currentAttachment = getCurrentChatAttachmentInfo();

    if (key === 'chat') {
        return {
            ...currentAttachment,
            characterName: 'All characters in this chat',
            stableIdentifier: null,
            avatarFilename: null,
            formerKeys: [],
            migrationStatus: 'shared',
        };
    }

    const identity = root?.memoryIdentities?.[key] || {};
    const isActive = key === getCharacterMemoryKey();
    return {
        ...(isActive ? currentAttachment : {}),
        ...(root?.memoryAttachments?.[key] || {}),
        stableIdentifier: identity.stableIdentifier || root?.memoryAttachments?.[key]?.stableIdentifier || null,
        avatarFilename: identity.avatarFilename || normalizeCardFilename(root?.memoryAttachments?.[key]?.characterAvatar),
        formerKeys: Array.isArray(identity.formerKeys) ? identity.formerKeys : [],
        migrationStatus: identity.migrationStatus || 'unmigrated',
        characterName: getMemoryBankLabel(key),
    };
}

function getMemoryDatabaseSnapshot() {
    // Ensure metadata exists and the active bank label/attachment are current before snapshotting.
    getChatStore();

    const s = getSettings();
    const { chatMetadata } = SillyTavern.getContext();
    const root = chatMetadata[MODULE_NAME];
    const activeKey = s.separateMemoryByCharacterCard ? getCharacterMemoryKey() : 'chat';
    const currentChat = getCurrentChatAttachmentInfo();
    const banks = getAllMemoryStores().map(([key, store]) => {
        const layers = (store.layers || []).map((layer, layerIndex) => ({
            layerIndex,
            snippets: (layer || []).map((snippet, snippetIndex) => ({
                snippetIndex,
                ...snippet,
            })),
        }));

        const attachment = getMemoryBankAttachment(key);

        return {
            key,
            label: getMemoryBankLabel(key),
            active: s.separateMemoryByCharacterCard ? key === activeKey : key === 'chat',
            chatId: attachment.chatId,
            chatName: attachment.chatName,
            characterId: attachment.characterId,
            characterName: attachment.characterName,
            characterAvatar: attachment.characterAvatar,
            stableIdentifier: attachment.stableIdentifier,
            avatarFilename: attachment.avatarFilename,
            formerKeys: attachment.formerKeys,
            migrationStatus: attachment.migrationStatus,
            groupId: attachment.groupId,
            groupName: attachment.groupName,
            summarizedUpTo: store.summarizedUpTo ?? -1,
            ghostedIndices: [...(store.ghostedIndices || [])],
            sourceSignatures: [...store.sourceSignatures],
            snippetCount: layers.reduce((sum, layer) => sum + layer.snippets.length, 0),
            layers,
            archive: (store.archive || []).map(entry => ({ ...entry })),
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        module: MODULE_NAME,
        memoryMode: s.separateMemoryByCharacterCard ? 'perCharacterCard' : 'perChat',
        currentChat,
        activeKey,
        activeLabel: getMemoryBankLabel(activeKey),
        bankCount: banks.length,
        migrationWarnings: [...(root?.migrationWarnings || [])],
        banks,
    };
}

function buildMemoryDatabaseHtml(snapshot) {
    if (!snapshot.banks.length) {
        return '<div class="sc-muted">No memory banks found.</div>';
    }

    const warningsHtml = snapshot.migrationWarnings?.length
        ? `<div class="sc-db-migration-warning">⚠️ ${snapshot.migrationWarnings.map(escapeHtml).join('<br>')}</div>`
        : '';
    return warningsHtml + snapshot.banks.map((bank) => {
        const layerHtml = bank.layers
            .filter(layer => layer.snippets.length > 0)
            .map(layer => {
                const snippetsHtml = layer.snippets.map(sn => {
                    const rangeStr = sn.turnRange
                        ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                        : sn.mergedCount
                            ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                            : 'meta';
                    const timestamp = sn.timestamp ? new Date(sn.timestamp).toLocaleString() : 'unknown time';
                    const flags = [sn.pinned ? 'pinned' : '', sn.promoted ? 'promoted' : '', sn.regenerated ? 'regenerated' : '', sn.edited ? 'edited' : '',
                        sn.childIds?.length ? `${sn.childIds.length} archived children` : '',
                        sn.lossy ? `lossy: dropped ${(sn.missingNames || []).join(', ') || 'names'}` : '']
                        .filter(Boolean)
                        .join(', ');
                    return `
                    <div class="sc-db-snippet" data-bank-key="${escapeHtml(bank.key)}" data-layer="${layer.layerIndex}" data-idx="${sn.snippetIndex}">
                        <div class="sc-db-snippet-meta">#${sn.snippetIndex + 1} · ${escapeHtml(rangeStr)} · ${escapeHtml(timestamp)}${flags ? ` · ${escapeHtml(flags)}` : ''}</div>
                        <div class="sc-db-snippet-text">${escapeHtml(sn.text || '')}</div>
                        <div class="sc-db-snippet-actions">
                            <button class="menu_button sc-db-snippet-edit-btn" type="button" title="Edit this memory snippet">
                                <i class="fa-solid fa-pen-to-square"></i> Edit Memory
                            </button>
                            <button class="menu_button menu_button_danger sc-db-snippet-delete-btn" type="button" title="Delete this memory snippet">
                                <i class="fa-solid fa-trash"></i> Delete
                            </button>
                        </div>
                    </div>`;
                }).join('');

                return `
                <details class="sc-db-layer" open>
                    <summary>Layer ${layer.layerIndex} · ${layer.snippets.length} snippet${layer.snippets.length === 1 ? '' : 's'}</summary>
                    ${snippetsHtml}
                </details>`;
            }).join('') || '<div class="sc-muted">No snippets in this bank yet.</div>';

        const archive = bank.archive || [];
        const archiveHtml = archive.length ? `
                <details class="sc-db-layer sc-db-archive">
                    <summary>Archive · ${archive.length} merged snippet${archive.length === 1 ? '' : 's'} (read-only)</summary>
                    ${archive.map(entry => `
                    <div class="sc-db-snippet sc-db-archived">
                        <div class="sc-db-snippet-meta">from L${entry.layer} · ${escapeHtml(entry.turnRange ? `turns ${entry.turnRange[0]}–${entry.turnRange[1]}` : 'no range')} · parent ${escapeHtml(String(entry.parentId || '').slice(0, 8))}</div>
                        <div class="sc-db-snippet-text">${escapeHtml(entry.text || '')}</div>
                    </div>`).join('')}
                </details>` : '';

        const attachmentRows = [
            ['Character', bank.characterName || 'Unknown character'],
            bank.stableIdentifier ? ['Stable card ID', bank.stableIdentifier] : null,
            bank.avatarFilename ? ['Card/avatar file', bank.avatarFilename] : null,
            ['Migration', bank.migrationStatus],
            bank.formerKeys?.length ? ['Former keys', bank.formerKeys.join(', ')] : null,
            ['Chat', bank.chatName || 'Current chat'],
            bank.chatId !== null && bank.chatId !== undefined ? ['Chat ID/file', bank.chatId] : null,
            bank.characterId !== null && bank.characterId !== undefined ? ['Character ID', bank.characterId] : null,
            bank.groupName ? ['Group', bank.groupName] : null,
            bank.groupId !== null && bank.groupId !== undefined ? ['Group ID', bank.groupId] : null,
            bank.characterAvatar ? ['Avatar', bank.characterAvatar] : null,
        ].filter(Boolean).map(([label, value]) => `
            <div class="sc-db-attachment-row">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(String(value))}</strong>
            </div>`).join('');

        const migrationWarning = bank.migrationStatus === 'ambiguous-preserved'
            ? '<div class="sc-db-migration-warning">⚠️ Ambiguous identity match; this bank was preserved and not merged.</div>'
            : '';
        return `
        <details class="sc-db-bank" ${bank.active ? 'open' : ''} data-bank-key="${escapeHtml(bank.key)}">
            <summary>
                <span>${bank.active ? '🟢 ' : ''}${escapeHtml(bank.label)}</span>
                <span class="sc-db-bank-meta">${bank.snippetCount} snippets · ${bank.ghostedIndices.length} ghosted · up to ${bank.summarizedUpTo}</span>
            </summary>
            <div class="sc-db-bank-key">Memory key: ${escapeHtml(bank.key)}</div>
            ${migrationWarning}
            <div class="sc-db-bank-actions">
                <button class="menu_button sc-db-bank-export-btn" type="button" data-bank-key="${escapeHtml(bank.key)}">
                    <i class="fa-solid fa-file-export"></i> Export Bank
                </button>
                ${bank.active ? '' : `
                <button class="menu_button menu_button_danger sc-db-bank-delete-btn" type="button" data-bank-key="${escapeHtml(bank.key)}">
                    <i class="fa-solid fa-trash"></i> Delete Bank
                </button>`}
            </div>
            <div class="sc-db-attachments">${attachmentRows}</div>
            ${layerHtml}
            ${archiveHtml}
        </details>`;
    }).join('');
}

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function showMemoryDatabaseModal() {
    document.querySelector('.sc-db-overlay')?.scClose?.();

    const target = captureMemoryTarget();
    let snapshot = getMemoryDatabaseSnapshot();
    const overlay = document.createElement('div');
    overlay.className = 'sc-db-overlay';

    const buildModalShell = () => `
    <div class="sc-db-modal" role="dialog" aria-modal="true" aria-labelledby="sc_db_title">
        <div class="sc-db-header">
            <div>
                <h3 id="sc_db_title">🧠 Summaryception Memory Database</h3>
                <div class="sc-db-subtitle">${escapeHtml(snapshot.currentChat.chatName)} · ${escapeHtml(snapshot.memoryMode)} · ${snapshot.bankCount} bank${snapshot.bankCount === 1 ? '' : 's'} · active: ${escapeHtml(snapshot.activeLabel)}</div>
            </div>
            <button class="menu_button sc-db-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="sc-db-toolbar">
            <input id="sc_db_filter" class="text_pole" type="search" placeholder="Filter banks and snippets..." />
            <button id="sc_db_refresh" class="menu_button"><i class="fa-solid fa-rotate"></i> Refresh</button>
            <button id="sc_db_cleanup_legacy" class="menu_button menu_button_danger"><i class="fa-solid fa-broom"></i> Clean Up Legacy Banks</button>
            <button id="sc_db_copy" class="menu_button"><i class="fa-solid fa-copy"></i> Copy JSON</button>
            <button id="sc_db_export_all" class="menu_button"><i class="fa-solid fa-file-export"></i> Export All</button>
        </div>
        <div class="sc-db-body">
            <div id="sc_db_rendered" class="sc-db-rendered">${buildMemoryDatabaseHtml(snapshot)}</div>
            <details class="sc-db-json-wrap">
                <summary>Raw JSON snapshot</summary>
                <textarea id="sc_db_json" class="text_pole sc-db-json" readonly>${escapeHtml(JSON.stringify(snapshot, null, 2))}</textarea>
            </details>
        </div>
        <div class="sc-db-footer sc-muted">
            Edit Memory changes the selected stored snippet in-place, then refreshes the injected Summaryception context. No external vector database is required for Summaryception's ordered summaries.
        </div>
    </div>`;

    overlay.innerHTML = buildModalShell();

    const applyFilter = () => {
        const filterInput = overlay.querySelector('#sc_db_filter');
        const needle = filterInput?.value.trim().toLowerCase() || '';
        for (const bankEl of overlay.querySelectorAll('.sc-db-bank')) {
            const matches = !needle || bankEl.textContent.toLowerCase().includes(needle);
            bankEl.style.display = matches ? '' : 'none';
            if (matches && needle) bankEl.open = true;
        }
    };

    const refreshDatabaseView = () => {
        const filterInput = overlay.querySelector('#sc_db_filter');
        const filterValue = filterInput?.value || '';
        const openBanks = new Set([...overlay.querySelectorAll('.sc-db-bank[open]')].map(el => el.dataset.bankKey));
        snapshot = getMemoryDatabaseSnapshot();
        overlay.querySelector('.sc-db-subtitle').innerHTML = `${escapeHtml(snapshot.currentChat.chatName)} · ${escapeHtml(snapshot.memoryMode)} · ${snapshot.bankCount} bank${snapshot.bankCount === 1 ? '' : 's'} · active: ${escapeHtml(snapshot.activeLabel)}`;
        overlay.querySelector('#sc_db_rendered').innerHTML = buildMemoryDatabaseHtml(snapshot);
        for (const bankEl of overlay.querySelectorAll('.sc-db-bank')) {
            if (openBanks.has(bankEl.dataset.bankKey)) bankEl.open = true;
        }
        overlay.querySelector('#sc_db_json').value = JSON.stringify(snapshot, null, 2);
        if (filterInput) filterInput.value = filterValue;
        applyFilter();
    };

    const close = () => {
        document.removeEventListener('keydown', keyHandler);
        overlay.remove();
    };
    overlay.scClose = close;
    const keyHandler = (event) => {
        if (event.key === 'Escape') close();
    };
    overlay.querySelector('.sc-db-close').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });

    document.addEventListener('keydown', keyHandler);

    overlay.querySelector('#sc_db_filter').addEventListener('input', applyFilter);

    overlay.querySelector('#sc_db_rendered').addEventListener('click', async (event) => {
        if (!targetIsCurrent(target)) { close(); return; }
        const cancelButton = event.target.closest('.sc-db-snippet-cancel-btn');
        if (cancelButton) {
            refreshDatabaseView();
            return;
        }

        const saveButton = event.target.closest('.sc-db-snippet-save-btn');
        if (saveButton) {
            const snippetEl = saveButton.closest('.sc-db-snippet');
            const bankKey = snippetEl?.dataset.bankKey;
            const layerIndex = Number.parseInt(snippetEl?.dataset.layer, 10);
            const snippetIndex = Number.parseInt(snippetEl?.dataset.idx, 10);
            const textarea = snippetEl?.querySelector('.sc-db-snippet-edit-area');
            const newText = textarea?.value.trim();

            if (!bankKey || Number.isNaN(layerIndex) || Number.isNaN(snippetIndex) || !textarea) return;
            if (!newText) {
                toastr.warning('Memory text cannot be empty.', 'Summaryception', { timeOut: TUNING.toastDefault });
                textarea.focus();
                return;
            }

            const { snippet } = getMemorySnippetByPath(bankKey, layerIndex, snippetIndex);
            if (!snippet) {
                toastr.error('Could not find that memory snippet. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }

            snippet.text = newText;
            snippet.edited = true;
            delete snippet.lossy;
            delete snippet.missingNames;
            snippet.editedAt = new Date().toISOString();
            invalidateContextCache(getMemoryStoreByKey(bankKey));
            await persistMemoryDatabaseChange();
            refreshDatabaseView();
            toastr.success(`Memory updated in Layer ${layerIndex}.`, 'Summaryception', { timeOut: TUNING.toastDefault });
            return;
        }

        const deleteButton = event.target.closest('.sc-db-snippet-delete-btn');
        if (deleteButton) {
            const snippetEl = deleteButton.closest('.sc-db-snippet');
            const bankKey = snippetEl?.dataset.bankKey;
            const layerIndex = Number.parseInt(snippetEl?.dataset.layer, 10);
            const snippetIndex = Number.parseInt(snippetEl?.dataset.idx, 10);

            if (!bankKey || Number.isNaN(layerIndex) || Number.isNaN(snippetIndex)) return;
            if (!confirm(`Delete memory snippet #${snippetIndex + 1} from Layer ${layerIndex}? This cannot be undone.`)) return;

            const { store, layer, snippet } = getMemorySnippetByPath(bankKey, layerIndex, snippetIndex);
            if (!store || !Array.isArray(layer) || !snippet) {
                toastr.error('Could not find that memory snippet. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }

            abortSummarization();
            truncateMemoryStore(store, snippet.turnRange?.[0] ?? 0);
            restoreUncoveredGhosts();
            await persistMemoryDatabaseChange();
            refreshDatabaseView();
            toastr.success(`Memory deleted from Layer ${layerIndex}.`, 'Summaryception', { timeOut: TUNING.toastDefault });
            return;
        }

        const bankExportButton = event.target.closest('.sc-db-bank-export-btn');
        if (bankExportButton) {
            const bankKey = bankExportButton.dataset.bankKey;
            snapshot = getMemoryDatabaseSnapshot();
            const bank = snapshot.banks.find(item => item.key === bankKey);
            if (!bank) {
                toastr.error('Could not find that memory bank. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }
            downloadJson(`summaryception_memory_bank_${bankKey.replace(/[^a-z0-9_-]+/gi, '_')}_${Date.now()}.json`, { format: 'summaryception-memory-bank-v3', key: bankKey, label: bank.label, store: getMemoryStoreByKey(bankKey) });
            toastr.success('Memory bank exported.', 'Summaryception', { timeOut: TUNING.toastDefault });
            return;
        }

        const bankDeleteButton = event.target.closest('.sc-db-bank-delete-btn');
        if (bankDeleteButton) {
            const bankKey = bankDeleteButton.dataset.bankKey;
            if (!bankKey || bankKey === getCharacterMemoryKey() || bankKey === 'chat') {
                toastr.warning('The active memory bank cannot be deleted. Use Clear Memory instead.', 'Summaryception');
                return;
            }
            if (!confirm(`Permanently delete memory bank "${bankKey}" and all of its snippets? Export it first if you may need it later.`)) return;
            if (!deleteMemoryBank(bankKey)) {
                toastr.error('Could not find that memory bank. Refreshing database view.', 'Summaryception');
                refreshDatabaseView();
                return;
            }
            await persistMemoryDatabaseChange();
            refreshDatabaseView();
            toastr.success('Memory bank deleted.', 'Summaryception', { timeOut: TUNING.toastDefault });
            return;
        }

        const editButton = event.target.closest('.sc-db-snippet-edit-btn');
        if (!editButton) return;

        const snippetEl = editButton.closest('.sc-db-snippet');
        const textEl = snippetEl?.querySelector('.sc-db-snippet-text');
        if (!snippetEl || !textEl || snippetEl.classList.contains('sc-db-snippet-editing')) return;

        const originalText = textEl.textContent || '';
        snippetEl.classList.add('sc-db-snippet-editing');
        textEl.innerHTML = `
            <textarea class="text_pole sc-db-snippet-edit-area" rows="5">${escapeHtml(originalText)}</textarea>
            <div class="sc-db-snippet-edit-actions">
                <button class="menu_button sc-db-snippet-save-btn" type="button"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                <button class="menu_button sc-db-snippet-cancel-btn" type="button"><i class="fa-solid fa-ban"></i> Cancel</button>
            </div>`;
        editButton.style.display = 'none';
        textEl.querySelector('.sc-db-snippet-edit-area')?.focus();
    });

    overlay.querySelector('#sc_db_refresh').addEventListener('click', () => {
        refreshDatabaseView();
        toastr.info('Memory database refreshed.', 'Summaryception', { timeOut: TUNING.toastShort });
    });

    overlay.querySelector('#sc_db_cleanup_legacy').addEventListener('click', async () => {
        snapshot = getMemoryDatabaseSnapshot();
        const legacyBanks = snapshot.banks.filter(bank => !bank.active && /^character:\d+$/.test(bank.key));
        if (!legacyBanks.length) {
            toastr.info('No inactive legacy numeric memory banks were found.', 'Summaryception', { timeOut: TUNING.toastDefault });
            return;
        }
        const bankList = legacyBanks.map(bank => bank.key).join(', ');
        if (!confirm(`Permanently delete ${legacyBanks.length} inactive legacy memory bank${legacyBanks.length === 1 ? '' : 's'} (${bankList})? Export All first if you may need them later.`)) return;

        const deletedCount = legacyBanks.reduce((count, bank) => count + Number(deleteMemoryBank(bank.key)), 0);
        await persistMemoryDatabaseChange();
        refreshDatabaseView();
        toastr.success(`Deleted ${deletedCount} legacy memory bank${deletedCount === 1 ? '' : 's'}.`, 'Summaryception', { timeOut: TUNING.toastMedium });
    });

    overlay.querySelector('#sc_db_copy').addEventListener('click', async () => {
        try {
            snapshot = getMemoryDatabaseSnapshot();
            const json = JSON.stringify(snapshot, null, 2);
            overlay.querySelector('#sc_db_json').value = json;
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(json);
            } else {
                const textarea = overlay.querySelector('#sc_db_json');
                textarea.focus();
                textarea.select();
                document.execCommand('copy');
            }
            toastr.success('Memory database JSON copied.', 'Summaryception', { timeOut: TUNING.toastDefault });
        } catch (e) {
            console.error(LOG_PREFIX, 'Could not copy memory database JSON:', e);
            toastr.error('Could not copy memory database JSON. Check console for details.', 'Summaryception');
        }
    });

    overlay.querySelector('#sc_db_export_all').addEventListener('click', () => {
        snapshot = getMemoryDatabaseSnapshot();
        overlay.querySelector('#sc_db_json').value = JSON.stringify(snapshot, null, 2);
        downloadJson(`summaryception_memory_database_${Date.now()}.json`, snapshot);
        toastr.success('Memory database exported.', 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    document.body.appendChild(overlay);
    overlay.querySelector('#sc_db_filter').focus();
}

function updateSnippetBrowser() {
    const store = getChatStore();
    let html = '';

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const rangeStr = sn.turnRange
                    ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                    : sn.mergedCount
                        ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                        : '';
                const seedStr = (sn.pinned ? ' 📌' : '') + (sn.promoted ? ' 🌱' : '')
                    + (sn.lossy ? ` ⚠️ dropped: ${escapeHtml((sn.missingNames || []).join(', ') || 'names')}` : '');
                const canRedo = Boolean(sn.turnRange);
                const redoBtn = canRedo
                    ? `<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right" title="Regenerate this snippet"></button>`
                    : '';

                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                <span class="sc-snippet-text" data-layer="${i}" data-idx="${j}" title="Click to edit">${escapeHtml(sn.text)}</span>
                <span class="sc-snippet-meta">${rangeStr}${seedStr}</span>
                <button class="sc-snippet-pin menu_button fa-solid fa-thumbtack${sn.pinned ? ' sc-pinned' : ''}" title="${sn.pinned ? 'Unpin' : 'Pin: never merge this snippet and inject it first'}"></button>
                ${redoBtn}
                <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    // Edit snippet on click
    $('.sc-snippet-text').off('click').on('click', function () {
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];
        const textEl = $(this);

        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.text)
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const newText = $(this).val().trim();
                    if (newText) {
                        sn.text = newText;
                        invalidateContextCache(store);
                        await saveChatStore();
                        updateInjection();
                        toastr.success('Snippet updated', 'Summaryception', { timeOut: TUNING.toastShort });
                    }
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                const newText = $(this).val().trim();
                if (newText && newText !== sn.text) {
                    sn.text = newText;
                    invalidateContextCache(store);
                    await saveChatStore();
                    updateInjection();
                    toastr.success('Snippet updated', 'Summaryception', { timeOut: TUNING.toastShort });
                }
                updateSnippetBrowser();
            });

        textEl.replaceWith(textarea);

        // Auto-size to fit content
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';

        textarea.focus().select();
    });

    $('.sc-snippet-pin').off('click').on('click', async function () {
        const row = $(this).closest('.sc-snippet');
        const snippet = getChatStore().layers[Number(row.data('layer'))]?.[Number(row.data('idx'))];
        if (!snippet) return;
        if (snippet.pinned) delete snippet.pinned; else snippet.pinned = true;
        invalidateContextCache(getChatStore());
        await saveChatStore();
        updateInjection();
        updateUI();
    });

    // Regeneration is available for promoted snippets that retain source ranges.
    $('.sc-snippet-redo').off('click').on('click', async function () {
        const row = $(this).closest('.sc-snippet');
        const snippet = getChatStore().layers[Number(row.data('layer'))]?.[Number(row.data('idx'))];
        if (snippet) await regenerateSnippets([snippet]);
    });

    // Delete snippet
    $('.sc-snippet-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer) {
            abortSummarization();
            truncateMemoryStore(store, layer[snippetIdx]?.turnRange?.[0] ?? 0);
            restoreUncoveredGhosts();

            await saveChatStore();
            updateInjection();
            updateUI();
            toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
        }
    });
}

// Regenerate from originals, with bounded earlier context and an atomic commit.
// A canceled/failed multi-snippet run keeps every original snippet.
async function regenerateSnippets(snippets) {
    if (!getSettings().enabled) { toastr.warning('Enable Summaryception first.', 'Summaryception'); return false; }
    if (isSummarizing) { toastr.warning('Stop the current run before regenerating.', 'Summaryception'); return false; }
    const target = captureMemoryTarget();
    const validRange = sn => Array.isArray(sn.turnRange) && sn.turnRange.length === 2
        && sn.turnRange.every(Number.isInteger) && sn.turnRange[0] >= 0
        && sn.turnRange[1] >= sn.turnRange[0] && sn.turnRange[1] < target.chat.length;
    if (!snippets.length || snippets.some(sn => !validRange(sn) || !target.store.layers.flat().includes(sn))) {
        toastr.warning('No summaries with available original messages to regenerate.', 'Summaryception');
        return false;
    }
    const ordered = [...snippets].sort((a, b) => a.turnRange[0] - b.turnRange[0]);
    const through = Math.max(target.store.summarizedUpTo, ...ordered.map(sn => sn.turnRange[1]));
    const run = beginSummarization();
    if (!run) return false;
    const transaction = captureTransaction(target, through);
    const replacements = new Map();
    const toast = toastr.info(`Regenerating ${ordered.length} summary snippet(s)… Use Stop to cancel.`, 'Summaryception', { timeOut: 0, extendedTimeOut: 0 });
    try {
        for (const sn of ordered) {
            const [start, end] = sn.turnRange;
            const passage = buildPassageFromRange(target.chat, start, end);
            if (!passage.trim()) { toastr.warning('Source messages are empty or hidden. Original summaries kept.', 'Summaryception'); return false; }
            const prior = target.store.layers.flat().filter(item => validRange(item) && item.turnRange[1] < start)
                .sort((a, b) => a.turnRange[0] - b.turnRange[0])
                .map((item, order) => ({ text: replacements.get(item) || item.text, order }));
            // Prefer recent earlier context, then render it chronologically.
            const context = fitContextParts(prior.reverse(), getContextBudgetCharacters())
                .sort((a, b) => a.order - b.order).map(item => item.text).join(' ') || '(none yet)';
            const text = await callSummarizer(passage, context);
            if (!text || !runIsCurrent(run) || !transactionIsCurrent(transaction)) return false;
            replacements.set(sn, text);
            $(toast).find('.toast-message').text(`Regenerating summaries: ${replacements.size} / ${ordered.length} — Use Stop to cancel`);
        }
        const originals = new Map([...replacements.keys()].map(sn => [sn, { ...sn }]));
        for (const [sn, text] of replacements) {
            Object.assign(sn, { text, timestamp: Date.now(), regenerated: true });
            delete sn.lossy;
            delete sn.missingNames;
        }
        invalidateContextCache(target.store);
        const committedRevision = storeRevisions.get(target.store);
        try {
            await saveChatStore();
        } catch (error) {
            // Restore local originals on persistence failure without overwriting
            // an edit/source repair that occurred while saving.
            if (storeRevisions.get(target.store) === committedRevision) {
                for (const [sn, original] of originals) {
                    delete sn.timestamp;
                    delete sn.regenerated;
                    Object.assign(sn, original);
                }
                invalidateContextCache(target.store);
            }
            throw error;
        }
        toastr.success(`${replacements.size} summary snippet(s) regenerated.`, 'Summaryception');
        return true;
    } catch (error) {
        toastr.error(`Regeneration failed: ${error.message}. Check saved memory before continuing.`, 'Summaryception');
        return false;
    } finally {
        clearPersistentToast(toast);
        finishSummarization(run);
        updateInjection(); updateUI();
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function clearActiveMemory() {
    abortSummarization();
    const target = captureMemoryTarget();
    const store = target.store;
    store.layers = [];
    store.archive = [];
    store.summarizedUpTo = -1;
    store.sourceSignatures = [];
    delete store.lastBatch;
    invalidateContextCache(store);
    await unghostAllMessages(store);
    if (!targetIsCurrent(target)) return;
    await persistMemoryDatabaseChange();
}

function validateMemoryImport(data) {
    const original = data?.store || data;
    if (!original || !Array.isArray(original.layers)) throw new Error('Expected a memory bank with layers.');
    const store = structuredClone(original);
    // The database viewer's historical export format used {snippets} layer rows.
    store.layers = store.layers.map(layer => Array.isArray(layer) ? layer : layer?.snippets);
    if (store.layers.some(layer => !Array.isArray(layer))) throw new Error('Invalid memory layers.');
    for (const snippet of store.layers.flat()) {
        if (typeof snippet === 'string') continue;
        if (!snippet || typeof snippet.text !== 'string') throw new Error('Invalid snippet text.');
        if (snippet.turnRange && !(Array.isArray(snippet.turnRange) && snippet.turnRange.length === 2
            && snippet.turnRange.every(Number.isInteger) && snippet.turnRange[0] >= 0
            && snippet.turnRange[1] >= snippet.turnRange[0])) throw new Error('Invalid snippet source range.');
    }
    if (store.archive != null) {
        if (!Array.isArray(store.archive)) throw new Error('Invalid snippet archive.');
        for (const entry of store.archive) {
            if (!entry || typeof entry.text !== 'string' || !Number.isInteger(entry.layer) || entry.layer < 0) throw new Error('Invalid archived snippet.');
            if (entry.turnRange && !(Array.isArray(entry.turnRange) && entry.turnRange.length === 2
                && entry.turnRange.every(Number.isInteger) && entry.turnRange[0] >= 0
                && entry.turnRange[1] >= entry.turnRange[0])) throw new Error('Invalid archived snippet source range.');
        }
    }
    if (store.summarizedUpTo != null && (!Number.isInteger(store.summarizedUpTo) || store.summarizedUpTo < -1)) {
        throw new Error('Invalid summarized cutoff.');
    }
    return normalizeChatStore(store);
}

async function confirmAndCleanupLegacyMemoryBanks() {
    const banks = getMemoryDatabaseSnapshot().banks.filter(bank => !bank.active && /^character:\d+$/.test(bank.key));
    if (!banks.length) { toastr.info('No inactive legacy numeric memory banks found.', 'Summaryception'); return false; }
    if (!confirm(`Delete ${banks.length} inactive legacy bank(s): ${banks.map(bank => bank.key).join(', ')}? Export first if needed.`)) return false;
    abortSummarization();
    for (const bank of banks) deleteMemoryBank(bank.key);
    await persistMemoryDatabaseChange();
    toastr.success(`Deleted ${banks.length} legacy bank(s).`, 'Summaryception');
    return true;
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
        if (isSummarizing) { toastr.warning('Already summarizing. Please wait.'); return; }
        await repairIfBranched();
        const target = captureMemoryTarget();
        if (target.store.summarizedUpTo < 0) await unghostAllMessages();
        if (!targetIsCurrent(target)) return;
        const turns = unsummarizedTurns(target.chat, target.store);
        $(this).prop('disabled', true).text(' Working…');
        try {
            setCatchupDismissed(true);
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
        if (!isSummarizing) return;
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
    clearActiveMemory,
    estimateTokens,
    showMemoryDatabaseModal,
    updateInjectionInspector,
    updateUI,
};
