/**
 * Summaryception — memory database viewer, bank export and legacy bank cleanup
 * AGPL-3.0
 */

import {
    LOG_PREFIX,
    MODULE_NAME,
    TUNING,
} from './constants.js';
import {
    getSettings,
} from './settings.js';
import {
    escapeHtml,
} from './util.js';
import {
    deleteMemoryBank,
    getAllMemoryStores,
    getCharacterMemoryKey,
    getCharacterMemoryLabel,
    getChatStore,
    getCurrentChatAttachmentInfo,
    getMemorySnippetByPath,
    getMemoryStoreByKey,
    invalidateContextCache,
    normalizeCardFilename,
    persistMemoryDatabaseChange,
} from './store.js';
import {
    restoreUncoveredGhosts,
    truncateMemoryStore,
} from './ghosting.js';
import {
    abortSummarization,
    captureMemoryTarget,
    targetIsCurrent,
} from './run.js';

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

export {
    confirmAndCleanupLegacyMemoryBanks,
    getMemoryBankAttachment,
    getMemoryBankLabel,
    showMemoryDatabaseModal,
};
