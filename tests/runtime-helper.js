import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import jquery from 'jquery';
import * as sources from '../source-signatures.js';
import * as budget from '../memory-budget.js';

export function runtime(settings = {}, includeInit = false) {
    const dom = new JSDOM(readFileSync(new URL('../settings.html', import.meta.url), 'utf8'), { url: 'https://sillytavern.local/' });
    const $ = jquery(dom.window);
    const requests = [], hides = [], messages = [];
    let respond = async () => 'Summary.';
    const events = new Map();
    const eventTypes = Object.fromEntries(['MESSAGE_RECEIVED', 'CHAT_CHANGED', 'GENERATION_STARTED', 'APP_READY', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED', 'CHARACTER_MESSAGE_RENDERED'].map(name => [name, name]));
    let ctx = {
        chat: [], chatMetadata: {}, extensionSettings: {}, characterId: 0,
        characters: [{ name: 'Mara', avatar: 'mara.png' }, { name: 'Ivo', avatar: 'ivo.png' }],
        name1: 'Alex', name2: 'Mara', extensionPrompts: {},
        eventTypes, eventSource: { on(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); }, async emit(name, ...args) { for (const callback of events.get(name) || []) await callback(...args); } },
        renderExtensionTemplateAsync: async () => '',
        saveSettingsDebounced() {}, async saveMetadata() {}, async saveChat() {},
        setExtensionPrompt(name, value, position, depth, scan, role) { ctx.extensionPrompts[name] = { value, position, depth, scan, role }; },
        async executeSlashCommandsWithOptions(command) {
            hides.push(command);
            const index = Number(command.split(' ')[1]);
            const m = ctx.chat[index];
            if (!m) return;
            if (command.startsWith('/hide')) { m.is_system = true; m.is_hidden = true; }
            else { m.is_system = false; delete m.is_hidden; }
        },
        ConnectionManagerRequestService: { handleDropdown() {} },
    };
    const toaster = Object.fromEntries(['info', 'warning', 'error', 'success'].map(type => [type, text => {
        messages.push({ type, text }); return $('<div><div class="toast-message"></div></div>');
    }])); toaster.clear = () => {};
    const globals = {
        ...sources, ...budget, $, document: dom.window.document, navigator: dom.window.navigator,
        Option: dom.window.Option, Blob, URL, crypto, AbortController, DOMException, performance,
        structuredClone, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
        confirm: () => true, prompt: () => 'Test profile', toastr: toaster,
        SillyTavern: { getContext: () => ctx },
        sendSummarizerRequest: async (...args) => { requests.push(args); return respond(...args); },
        fetchOllamaModels: async () => [], testOpenAIConnection: async () => ({ success: true }),
        populateProfileDropdown: () => true, getConnectionDisplayName: () => 'Test',
        fetch: async () => ({ ok: true, json: async () => [] }),
    };
    let code = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
        .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/g, '')
        ;
    code = includeInit ? code.replace('(async function init()', 'globalThis.initPromise = (async function init()') : code.split('(async function init()')[0];
    vm.createContext(globals);
    vm.runInContext(code + '\nglobalThis.api = { getSettings, getChatStore, getAllMemoryStores, getCharacterMemoryKey, getAssistantTurns, normalizeChatStore, maybeSummarizeTurns, summarizeOneBatch, runCatchup, maybePromoteLayer, beginSummarization, finishSummarization, abortSummarization, buildFullContext, assembleSummaryBlock, updateInjection, onGenerationStarted, onSourceMessageChanged, onMessageReceived, reconcileMemorySources, repairIfBranched, activateCharacterMemoryStore, validateMemoryImport, clearActiveMemory, bindUIEvents, initConnectionUI, updateUI, cleanSummarizerOutput, captureMemoryTarget, targetIsCurrent, onChatChanged, invalidateContextCache, regenerateSnippets, updateInjectionDebugOverlay, testCurrentConnectionHandler, isMemoryRunning: () => isSummarizing };', globals);
    const api = globals.api;
    Object.assign(api.getSettings(), { separateMemoryByCharacterCard: false, verbatimTurns: 2, turnsPerSummary: 3, connectionSource: 'completion', ...settings });
    const click = async (id, event = 'click') => {
        const element = dom.window.document.getElementById(id);
        const handlers = $._data(element, 'events')?.[event] || [];
        for (const handler of handlers) await handler.handler.call(element, { target: element, preventDefault() {} });
    };
    const addTurns = (count, start = 0) => {
        for (let i = start; i < start + count; i++) ctx.chat.push({ is_user: true, name: 'Alex', mes: `Player action ${i}` }, { is_user: false, name: 'Mara', mes: `Reply ${i}` });
    };
    return { api, $, dom, ctx, requests, hides, messages, click, addTurns, events, ready: globals.initPromise,
        respond: fn => { respond = fn; }, switchContext: value => { ctx = value; } };
}
