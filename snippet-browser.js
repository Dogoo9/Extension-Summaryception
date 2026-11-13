/**
 * Summaryception — snippet browser (edit, pin, regenerate, delete)
 * AGPL-3.0
 */

import {
    TUNING,
} from './constants.js';
import {
    escapeHtml,
} from './util.js';
import {
    getChatStore,
    invalidateContextCache,
    saveChatStore,
} from './store.js';
import {
    restoreUncoveredGhosts,
    truncateMemoryStore,
} from './ghosting.js';
import {
    abortSummarization,
} from './run.js';
import {
    regenerateSnippets,
} from './summarize.js';
import {
    updateInjection,
} from './injection.js';
import {
    updateUI,
} from './settings-ui.js';

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

export {
    updateSnippetBrowser,
};
