/**
 * Summaryception — summarizer connection settings UI
 * AGPL-3.0
 */

import {
    fetchOllamaModels,
    getConnectionDisplayName,
    populateProfileDropdown,
    sendSummarizerRequest,
    testOpenAIConnection,
} from './connectionutil.js';
import {
    TUNING,
    defaultSettings,
} from './constants.js';
import {
    getSettings,
    saveSettings,
} from './settings.js';

// ─── Connection Settings UI ──────────────────────────────────────────

function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();
    renderSavedConnectionProfiles();

    bindSimpleConnectionInput('summaryception_temperature', 'summarizerTemperature', v => Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : defaultSettings.summarizerTemperature);
    bindSimpleConnectionInput('summaryception_timeout_ms', 'summarizerTimeoutMs', v => Number.parseInt(v, 10) || defaultSettings.summarizerTimeoutMs);
    bindSimpleConnectionInput('summaryception_stop_sequences', 'summarizerStopSequences', v => v.split('\n').map(x => x.trim()).filter(Boolean), v => (v || []).join('\n'));

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            s().activeSavedConnectionProfileId = '';
            save();
            updateConnectionSubPanels(sourceSelect.value);
            renderSavedConnectionProfiles();
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, s().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, s().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            s().connectionProfileId = profileSelect.value;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = s().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    bindSimpleConnectionInput('summaryception_completion_url', 'completionUrl');
    bindSimpleConnectionInput('summaryception_completion_key', 'completionKey');
    bindSimpleConnectionInput('summaryception_completion_model', 'completionModel');
    bindSimpleConnectionInput('summaryception_completion_prefix', 'completionPrefix', v => v.replace(/\\n/g, '\n'), v => (v || '').replace(/\n/g, '\\n'));
    bindSimpleConnectionInput('summaryception_completion_suffix', 'completionSuffix', v => v.replace(/\\n/g, '\n'), v => (v || '').replace(/\n/g, '\\n'));
    bindSimpleConnectionInput('summaryception_custom_url', 'customUrl');
    bindSimpleConnectionInput('summaryception_custom_headers', 'customHeaders');
    bindSimpleConnectionInput('summaryception_custom_body', 'customBodyTemplate');
    bindSimpleConnectionInput('summaryception_custom_response_path', 'customResponsePath');
    bindSimpleConnectionInput('summaryception_custom_api_key', 'customApiKey');
    bindSimpleConnectionInput('summaryception_custom_model', 'customModel');

    document.getElementById('summaryception_test_current')?.addEventListener('click', testCurrentConnectionHandler);
    document.getElementById('summaryception_profile_save')?.addEventListener('click', saveCurrentConnectionProfile);
    document.getElementById('summaryception_profile_update')?.addEventListener('click', updateSelectedConnectionProfile);
    document.getElementById('summaryception_profile_duplicate')?.addEventListener('click', duplicateSelectedConnectionProfile);
    document.getElementById('summaryception_profile_delete')?.addEventListener('click', deleteSelectedConnectionProfile);
    document.getElementById('summaryception_saved_profile')?.addEventListener('change', loadSelectedConnectionProfile);

    // ── KoboldCPP URL ──
    const kcppUrl = document.getElementById('summaryception_kcpp_url');
    if (kcppUrl) {
        kcppUrl.value = s().koboldcppUrl || 'http://localhost:5001';
        kcppUrl.addEventListener('input', () => {
            s().koboldcppUrl = kcppUrl.value.trim().replace(/\/+$/, '');
            save();
        });
    }

    // ── KoboldCPP Prefix ──
    const kcppPrefix = document.getElementById('summaryception_kcpp_prefix');
    if (kcppPrefix) {
        kcppPrefix.value = (s().koboldcppPrefix || '<|im_start|>user\n').replace(/\n/g, '\\n');
        kcppPrefix.addEventListener('input', () => {
            s().koboldcppPrefix = kcppPrefix.value.replace(/\\n/g, '\n');
            save();
        });
    }

    // ── KoboldCPP Suffix ──
    const kcppSuffix = document.getElementById('summaryception_kcpp_suffix');
    if (kcppSuffix) {
        kcppSuffix.value = (s().koboldcppSuffix || '<|im_end|>\n<|im_start|>assistant\n').replace(/\n/g, '\\n');
        kcppSuffix.addEventListener('input', () => {
            s().koboldcppSuffix = kcppSuffix.value.replace(/\\n/g, '\n');
            save();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

const CONNECTION_PROFILE_FIELDS = [
    'connectionSource', 'summarizerResponseLength', 'summarizerTemperature', 'summarizerTimeoutMs', 'summarizerStopSequences',
    'connectionProfileId', 'ollamaUrl', 'ollamaModel', 'openaiUrl', 'openaiKey', 'openaiModel', 'openaiMaxTokens',
    'koboldcppUrl', 'koboldcppPrefix', 'koboldcppSuffix', 'completionUrl', 'completionKey', 'completionModel',
    'completionPrefix', 'completionSuffix', 'customUrl', 'customHeaders', 'customBodyTemplate', 'customResponsePath',
    'customApiKey', 'customModel',
];

function bindSimpleConnectionInput(id, key, fromUi = v => v.trim(), toUi = v => v ?? '') {
    const el = document.getElementById(id);
    if (!el) return;
    const sync = () => {
        const value = getSettings()[key];
        el.value = toUi(value);
    };
    sync();
    el.addEventListener('input', () => {
        getSettings()[key] = fromUi(el.value);
        getSettings().activeSavedConnectionProfileId = '';
        saveSettings();
        renderSavedConnectionProfiles();
    });
}

function captureConnectionProfileData() {
    const s = getSettings();
    return Object.fromEntries(CONNECTION_PROFILE_FIELDS.map(key => [key, structuredClone(s[key])]));
}

function applyConnectionProfileData(data) {
    const s = getSettings();
    for (const key of CONNECTION_PROFILE_FIELDS) {
        if (Object.hasOwn(data, key)) s[key] = structuredClone(data[key]);
    }
    saveSettings();
    syncConnectionUIFromSettings();
}

function renderSavedConnectionProfiles() {
    const select = document.getElementById('summaryception_saved_profile');
    if (!select) return;
    const s = getSettings();
    select.innerHTML = '<option value="">-- Current unsaved settings --</option>';
    for (const profile of s.savedConnectionProfiles || []) {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = `${profile.name} (${profile.data?.connectionSource || 'default'})`;
        select.appendChild(opt);
    }
    select.value = s.activeSavedConnectionProfileId || '';
}

function syncConnectionUIFromSettings() {
    const s = getSettings();
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value ?? '';
    };
    set('summaryception_connection_source', s.connectionSource || 'default');
    set('summaryception_connection_profile', s.connectionProfileId || '');
    set('summaryception_ollama_url', s.ollamaUrl || '');
    set('summaryception_ollama_model', s.ollamaModel || '');
    set('summaryception_openai_url', s.openaiUrl || '');
    set('summaryception_openai_key', s.openaiKey || '');
    set('summaryception_openai_model', s.openaiModel || '');
    set('summaryception_openai_max_tokens', s.openaiMaxTokens || 0);
    set('summaryception_kcpp_url', s.koboldcppUrl || '');
    set('summaryception_kcpp_prefix', (s.koboldcppPrefix || '').replace(/\n/g, '\\n'));
    set('summaryception_kcpp_suffix', (s.koboldcppSuffix || '').replace(/\n/g, '\\n'));
    set('summaryception_temperature', s.summarizerTemperature ?? defaultSettings.summarizerTemperature);
    set('summaryception_timeout_ms', s.summarizerTimeoutMs ?? defaultSettings.summarizerTimeoutMs);
    set('summaryception_stop_sequences', (s.summarizerStopSequences || []).join('\n'));
    set('summaryception_completion_url', s.completionUrl || '');
    set('summaryception_completion_key', s.completionKey || '');
    set('summaryception_completion_model', s.completionModel || '');
    set('summaryception_completion_prefix', (s.completionPrefix || '').replace(/\n/g, '\\n'));
    set('summaryception_completion_suffix', (s.completionSuffix || '').replace(/\n/g, '\\n'));
    set('summaryception_custom_url', s.customUrl || '');
    set('summaryception_custom_headers', s.customHeaders || '');
    set('summaryception_custom_body', s.customBodyTemplate || '');
    set('summaryception_custom_response_path', s.customResponsePath || '');
    set('summaryception_custom_api_key', s.customApiKey || '');
    set('summaryception_custom_model', s.customModel || '');
    updateConnectionSubPanels(s.connectionSource || 'default');
    renderSavedConnectionProfiles();
}

function saveCurrentConnectionProfile() {
    const name = prompt('Name this Summaryception connection profile:', getConnectionDisplayName(getSettings()));
    if (!name) return;
    const s = getSettings();
    const profile = { id: `sc_${Date.now().toString(36)}`, name: name.trim(), data: captureConnectionProfileData(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    s.savedConnectionProfiles = [...(s.savedConnectionProfiles || []), profile];
    s.activeSavedConnectionProfileId = profile.id;
    saveSettings();
    renderSavedConnectionProfiles();
    toastr.success(`Saved connection profile "${profile.name}".`, 'Summaryception');
}

function getSelectedConnectionProfile() {
    const id = document.getElementById('summaryception_saved_profile')?.value || getSettings().activeSavedConnectionProfileId;
    return (getSettings().savedConnectionProfiles || []).find(profile => profile.id === id);
}

function updateSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) return toastr.warning('Select a saved Summaryception profile first.', 'Summaryception');
    profile.data = captureConnectionProfileData();
    profile.updatedAt = new Date().toISOString();
    getSettings().activeSavedConnectionProfileId = profile.id;
    saveSettings();
    renderSavedConnectionProfiles();
    toastr.success(`Updated connection profile "${profile.name}".`, 'Summaryception');
}

function duplicateSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) return toastr.warning('Select a saved Summaryception profile first.', 'Summaryception');
    const copy = structuredClone(profile);
    copy.id = `sc_${Date.now().toString(36)}`;
    copy.name = `${profile.name} Copy`;
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    getSettings().savedConnectionProfiles.push(copy);
    getSettings().activeSavedConnectionProfileId = copy.id;
    saveSettings();
    renderSavedConnectionProfiles();
}

function deleteSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) return toastr.warning('Select a saved Summaryception profile first.', 'Summaryception');
    if (!confirm(`Delete Summaryception connection profile "${profile.name}"?`)) return;
    const s = getSettings();
    s.savedConnectionProfiles = (s.savedConnectionProfiles || []).filter(item => item.id !== profile.id);
    if (s.activeSavedConnectionProfileId === profile.id) s.activeSavedConnectionProfileId = '';
    saveSettings();
    renderSavedConnectionProfiles();
}

function loadSelectedConnectionProfile() {
    const profile = getSelectedConnectionProfile();
    if (!profile) {
        getSettings().activeSavedConnectionProfileId = '';
        saveSettings();
        return;
    }
    getSettings().activeSavedConnectionProfileId = profile.id;
    applyConnectionProfileData(profile.data || {});
    toastr.success(`Loaded connection profile "${profile.name}".`, 'Summaryception');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile:   document.getElementById('summaryception_profile_settings'),
        ollama:    document.getElementById('summaryception_ollama_settings'),
        openai:    document.getElementById('summaryception_openai_settings'),
        koboldcpp: document.getElementById('summaryception_kcpp_settings'),
        completion: document.getElementById('summaryception_completion_settings'),
        custom: document.getElementById('summaryception_custom_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

async function testCurrentConnectionHandler() {
    const s = structuredClone(getSettings());
    showConnectionStatus('loading', `Testing ${getConnectionDisplayName(s)}...`);
    const started = performance.now();
    const request = new AbortController();
    let timeout;
    try {
        const response = await Promise.race([
            sendSummarizerRequest(s, 'You are a connection test assistant.', 'Reply with exactly: CONNECTION_OK', { signal: request.signal }),
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    request.abort();
                    reject(new Error('Connection test timed out'));
                }, s.summarizerTimeoutMs || defaultSettings.summarizerTimeoutMs);
            }),
        ]);
        const elapsed = Math.round(performance.now() - started);
        showConnectionStatus('success', `OK in ${elapsed}ms: ${(response || '').trim().slice(0, 160)}`);
        toastr.success(`Connection test succeeded in ${elapsed}ms.`, 'Summaryception');
    } catch (error) {
        showConnectionStatus('error', `Failed: ${error.message || error}`);
        toastr.error(`Connection test failed: ${error.message || error}`, 'Summaryception');
    } finally {
        clearTimeout(timeout);
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) container.style.display = 'none';
        }, TUNING.connectionStatusTimeout);
    }
}

async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}

export {
    initConnectionUI,
    syncConnectionUIFromSettings,
};
