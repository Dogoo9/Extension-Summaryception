/**
 * Summaryception — SillyTavern event handlers and slash commands
 * AGPL-3.0
 */

import {
    assembleBudgetedMemoryAsync,
} from './memory-budget.js';
import {
    INJECTION_POSITION_LABELS,
    MODULE_NAME,
    TUNING,
} from './constants.js';
import {
    state,
} from './state.js';
import {
    getSettings,
    log,
} from './settings.js';
import {
    activateCharacterMemoryStore,
    clearActiveMemory,
    getAllMemoryStores,
    getCharacterMemoryKey,
    getCharacterMemoryLabel,
    getChatStore,
    injectionReports,
    persistMemoryDatabaseChange,
} from './store.js';
import {
    reconcileMemorySources,
    repairIfBranched,
} from './ghosting.js';
import {
    abortSummarization,
    captureMemoryTarget,
    captureTransaction,
    targetIsCurrent,
    transactionIsCurrent,
} from './run.js';
import {
    maybeSummarizeTurns,
} from './summarize.js';
import {
    assembleSummaryBlock,
    getInjectionDepthValue,
    getMemoryAssemblyOptions,
    injectionConfigurationKey,
    setSummaryceptionExtensionPrompt,
    updateInjection,
} from './injection.js';
import {
    showMemoryDatabaseModal,
} from './memory-db-ui.js';
import {
    updateInjectionInspector,
    updateUI,
} from './settings-ui.js';

function onMessageReceived(messageIndex) {
    if (!getSettings().enabled) return;
    try {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            const target = captureMemoryTarget();
            clearTimeout(state.messageReceivedTimer);
            state.messageReceivedTimer = setTimeout(async () => {
                if (!targetIsCurrent(target)) return;
                if (state.isSummarizing) {
                    state.activeRun.pendingSummaryTarget = target;
                    state.activeRun.pendingSummaryMessageIndex = messageIndex;
                    return;
                }
                await maybeSummarizeTurns();
                updateInjection();
                updateUI();
            }, TUNING.messageReceivedDelay);
        }
    } catch (e) {
        log('onMessageReceived error:', e);
    }
}

function onChatChanged() {
    log('Chat changed.');
    abortSummarization();
    clearTimeout(state.messageReceivedTimer);
    state.chatEpoch++;
    document.querySelector('.sc-db-overlay')?.scClose?.();
    setSummaryceptionExtensionPrompt('');
    state.catchupDismissed = false;
    const epoch = state.chatEpoch;
    setTimeout(async () => {
        if (epoch !== state.chatEpoch) return;
        await repairIfBranched();
        if (epoch !== state.chatEpoch) return;
        await activateCharacterMemoryStore();
        if (epoch !== state.chatEpoch) return;
        updateInjection();
        updateUI();
    }, TUNING.chatChangedDelay);
}

async function onGenerationStarted(type, options, dryRun) {
    if (state.promptTogglesHeld && type && !dryRun && type !== 'quiet') {
        toastr.warning('A summary request is using the default connection with prompt toggles temporarily disabled. This reply may be missing your preset prompts; wait for the summary or use a dedicated summarizer connection.', 'Summaryception', { timeOut: TUNING.toastError });
    }
    updateInjection();
    if (!getSettings().enabled) return;
    const ctx = SillyTavern.getContext();
    const tokenizer = ctx.getTokenCountAsync || ctx.getTokenCount;
    if (typeof tokenizer !== 'function' || getSettings().contextBudgetUnit === 'characters') return;
    const target = captureMemoryTarget();
    const through = target.store.summarizedUpTo;
    const transaction = captureTransaction(target, through);
    const configuration = injectionConfigurationKey();
    const sequence = ++state.injectionMeasurementSequence;
    const report = await assembleBudgetedMemoryAsync(getMemoryAssemblyOptions(), text => tokenizer.call(ctx, text));
    if (!transactionIsCurrent(transaction) || configuration !== injectionConfigurationKey() || sequence !== state.injectionMeasurementSequence) return;
    injectionReports.set(target.store, report);
    setSummaryceptionExtensionPrompt(report.text);
    $('#sc_preview').val(report.text || '(empty — budget cannot fit a complete memory item)');
    updateInjectionInspector(report.text);
}

function onSourceMessageChanged(index) {
    const hint = Number.isInteger(index) ? index : null;
    if (reconcileMemorySources(hint)) {
        persistMemoryDatabaseChange().catch(error => log('Could not save repaired memory:', error));
    }
    updateInjection();
    updateUI();
}

function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-status',
            callback: () => {
                const store = getChatStore();
                const lines = ['**Summaryception Status**'];
                lines.push(`Memory mode: ${getSettings().separateMemoryByCharacterCard ? 'per character card' : 'per chat'}`);
                if (getSettings().separateMemoryByCharacterCard) {
                    lines.push(`Active card: ${getCharacterMemoryLabel()} (${getCharacterMemoryKey()})`);
                    lines.push(`Memory banks in this chat: ${getAllMemoryStores().length}`);
                }
                const s = getSettings();
                lines.push(`Injection: ${INJECTION_POSITION_LABELS[s.injectionPosition] || 'Prompt'}${s.injectionPosition === 'in_chat' ? ` at depth ${getInjectionDepthValue(s)}` : ''} as ${s.injectionRole || 'system'}`);
                lines.push(`Injected chars: ${(SillyTavern.getContext().extensionPrompts?.[MODULE_NAME]?.value || '').length}`);
                lines.push(`Summarized up to index: ${store.summarizedUpTo}`);
                if (store.layers) {
                    for (let i = 0; i < store.layers.length; i++) {
                        const l = store.layers[i];
                        if (l && l.length > 0) {
                            lines.push(`Layer ${i}: ${l.length} snippets`);
                        }
                    }
                }
                return lines.join('\n');
            },
            helpString: 'Show Summaryception layer status',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                await clearActiveMemory();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-injected',
            callback: () => {
                const registered = SillyTavern.getContext().extensionPrompts?.[MODULE_NAME];
                if (!registered?.value) return '(No Summaryception injection is currently registered)';
                return registered.value;
            },
            helpString: 'Show the Summaryception prompt currently registered with SillyTavern',
        }));


        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-db',
            callback: () => {
                showMemoryDatabaseModal();
                return 'Opened Summaryception memory database viewer.';
            },
            helpString: 'Open the Summaryception memory database viewer',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

export {
    onChatChanged,
    onGenerationStarted,
    onMessageReceived,
    onSourceMessageChanged,
    registerSlashCommands,
};
