/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of four backends:
 *   - default:  SillyTavern's generateRaw() (active connection)
 *   - profile:  ST Connection Profile via ConnectionManagerRequestService
 *   - ollama:   Ollama instance (via ST CORS proxy to avoid browser CORS issues)
 *   - openai:   OpenAI-compatible endpoint (via ST CORS proxy, streaming supported)
 *   - completion: generic /v1/completions-compatible endpoint
 *   - custom:   user-templated HTTP JSON endpoint
 *
 * CORS Note: Ollama and OpenAI modes route through ST's /proxy/ endpoint
 * to avoid browser CORS restrictions. Requires enableCorsProxy: true in config.yaml
 * OR the target server must have permissive CORS headers.
 *
 * AGPL-3.0
 */

const MODULE_NAME = '[Summaryception][Connection]';

const LLM_DEFAULTS = Object.freeze({
    ollamaTemperature: 0.3,
    openaiTemperature: 0.8,
    testMaxTokens: 100,
    testPreviewLength: 100,
});

// ─── Custom Error Class ──────────────────────────────────────────────

/**
 * Error class for connection errors with explicit retryable flag.
 * The retry logic in callSummarizer checks for this to avoid
 * burning through retries on errors that will never succeed
 * (e.g. missing config, auth failures, deleted profiles).
 */
class ConnectionError extends Error {
    constructor(message, { retryable = false, status = null, retryAfter = null } = {}) {
        super(message);
        this.name = 'ConnectionError';
        this.retryable = retryable;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

export { ConnectionError };

// ─── CORS Proxy Helper ───────────────────────────────────────────────

/**
 * Wrap a URL through SillyTavern's CORS proxy if needed.
 * @param {string} url - The target URL
 * @param {boolean} useProxy - Whether to attempt proxying
 * @returns {string} - The (possibly proxied) URL
 */
function proxiedUrl(url, useProxy = true) {
    if (!useProxy) return url;
    return `/proxy/${url}`;
}

/**
 * Get standard request headers including ST's CSRF token if available.
 * Required when routing through ST's /proxy/ endpoint.
 * @returns {object}
 */
function getProxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders();
        }
    } catch (e) { /* fallback */ }
    return { 'Content-Type': 'application/json' };
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Send a summarization request using the configured connection.
 * @param {object} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} - The generated response text
 * @throws {ConnectionError|Error} - If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt, { signal } = {}) {
    if (signal) {
        signal.throwIfAborted();
        return routeSummarizerRequest({ ...settings, requestSignal: signal }, systemPrompt, userPrompt);
    }
    // Connection-test buttons use the same timeout as normal requests.
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            routeSummarizerRequest({ ...settings, requestSignal: controller.signal }, systemPrompt, userPrompt),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new ConnectionError('Connection request timed out.', { retryable: true }));
                }, Math.max(1000, Number(settings.summarizerTimeoutMs) || 120000));
            }),
        ]);
    } finally { clearTimeout(timer); }
}

async function routeSummarizerRequest(settings, systemPrompt, userPrompt) {
    const source = settings.connectionSource || 'default';

    switch (source) {
        case 'profile':
            return await sendViaProfile(settings.connectionProfileId, systemPrompt, userPrompt, settings);
        case 'ollama':
            return await sendViaOllama(settings.ollamaUrl, settings.ollamaModel, systemPrompt, userPrompt, settings);
        case 'openai':
            return await sendViaOpenAI(settings.openaiUrl, settings.openaiKey, settings.openaiModel, systemPrompt, userPrompt, settings.openaiMaxTokens, settings);
        case 'koboldcpp':
            return await sendViaKoboldCPP(settings.koboldcppUrl, settings.koboldcppPrefix, settings.koboldcppSuffix, systemPrompt, userPrompt, settings);
        case 'completion':
            return await sendViaCompletion(settings, systemPrompt, userPrompt);
        case 'custom':
            return await sendViaCustomHttp(settings, systemPrompt, userPrompt);
        case 'default':
        default:
            return await sendViaDefault(systemPrompt, userPrompt, settings.summarizerResponseLength, settings.requestSignal);
    }
}

// ─── Mode 1: Default (generateRaw) ──────────────────────────────────

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 */
async function sendViaDefault(systemPrompt, userPrompt, responseLength, signal) {
    const context = SillyTavern.getContext();
    const { generateRaw } = context;

    if (!generateRaw) {
        throw new ConnectionError(
            'generateRaw is not available in the current SillyTavern context.',
            { retryable: false }
        );
    }

    // ST refactored generateRaw from positional args to an object param
    // in PR #4277 (July 2025). We need to support both signatures.
    //
    // New (July 2025+): generateRaw({ prompt, systemPrompt, responseLength })
    // Old (pre-July 2025): generateRaw(prompt, systemPrompt)
    //
    // Detection: the new signature destructures an object, so if we check
    // the function's length (expected positional params), 0 or 1 means
    // object-style, 2+ means positional-style.

    let result;
    const stopRaw = () => {
        // generateRaw has no abortSignal option in ST 1.16. It subscribes to the
        // native stop event. This can also stop concurrent raw generations.
        const types = context.eventTypes || context.event_types;
        if (types?.GENERATION_STOPPED && context.eventSource?.emit) {
            const emission = context.eventSource.emit(types.GENERATION_STOPPED);
            emission?.catch?.(error => console.warn(`${MODULE_NAME} Stop event failed:`, error));
        }
    };
    signal?.throwIfAborted();
    signal?.addEventListener('abort', stopRaw, { once: true });
    try {

        if (generateRaw.length <= 1) {
            // Modern ST: object-based params
            const options = {
                systemPrompt: systemPrompt,
                prompt: userPrompt,
            };

            if (responseLength && responseLength > 0) {
                options.responseLength = responseLength;
            }

            result = await generateRaw(options);
        } else {
            // Legacy ST: positional args — generateRaw(prompt, systemPrompt)
            // Note: legacy signature does not support responseLength override
            console.warn(
                '[Summaryception] Detected legacy generateRaw (positional args). ' +
                'Consider updating SillyTavern to July 2025+ for full feature support.'
            );
            result = await generateRaw(userPrompt, systemPrompt);
        }

    } finally { signal?.removeEventListener('abort', stopRaw); }
    signal?.throwIfAborted();

    if (!result || typeof result !== 'string') {
        throw new ConnectionError(
            'generateRaw returned an empty or invalid response.',
            { retryable: true }
        );
    }

    return result;
}

// ─── Mode 2: Connection Profile ──────────────────────────────────────

/**
 * Uses ST's ConnectionManagerRequestService to send a request via a saved profile.
 * Requires SillyTavern with PR #3603 merged (March 2025+).
 * Full API key support requires staging with Issue #5348 fix (March 30, 2026+).
 *
 * IMPORTANT: sendRequest() expects messages as an array of {role, content} objects,
 * NOT as a generateRaw()-style options object. Passing {systemPrompt, prompt} as
 * the second argument causes the entire object to be stuffed into the message
 * content field, resulting in "Invalid input" / validation errors from the API.
 */
async function sendViaProfile(profileId, systemPrompt, userPrompt, settings = {}) {
    if (!profileId) {
        throw new ConnectionError(
            'No Connection Profile selected. Please select one in Summaryception settings.',
            { retryable: false }
        );
    }

    const context = SillyTavern.getContext();
    const service = context.ConnectionManagerRequestService;

    if (!service) {
        throw new ConnectionError(
            'ConnectionManagerRequestService is not available. ' +
            'Your SillyTavern version may be too old. Requires ST with PR #3603 (March 2025+).',
            { retryable: false }
        );
    }

    if (typeof service.sendRequest !== 'function') {
        throw new ConnectionError(
            'ConnectionManagerRequestService.sendRequest() is not available. ' +
            'Please update SillyTavern to the latest staging version.',
            { retryable: false }
        );
    }

    try {
        // Build messages as proper {role, content} objects.
        // ST 1.16: sendRequest(profileId, messages, maxTokens, options)
        // where messages is a string OR an array of {role, content} objects.
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        const raw = await service.sendRequest(profileId, messages,
            settings.summarizerResponseLength || settings.openaiMaxTokens || 512, {
                includePreset: false,
                includeInstruct: false,
                extractData: true,
                stream: false,
                signal: settings.requestSignal,
            }, { temperature: Number(settings.summarizerTemperature ?? 0.3),
                ...(settings.summarizerStopSequences?.length ? { stop: settings.summarizerStopSequences } : {}) });

        // Handle various possible return types
        let result;
        if (typeof raw === 'string') {
            result = raw;
        } else if (raw?.content) {
            result = raw.content;
        } else if (raw?.message?.content) {
            result = raw.message.content;
        } else if (raw?.choices?.[0]?.message?.content) {
            result = raw.choices[0].message.content;
        } else if (typeof raw?.data === 'string') {
            result = raw.data;
        } else if (raw && typeof raw === 'object') {
            const str = JSON.stringify(raw);
            console.warn('[Summaryception][Connection] Unexpected return type from sendRequest:', str.substring(0, 500));
            throw new ConnectionError(
                `Connection Profile returned unexpected type: ${typeof raw}. ` +
                `Preview: ${str.substring(0, 200)}. ` +
                `Please report this on the Summaryception GitHub.`,
                { retryable: false }
            );
        } else {
            throw new ConnectionError(
                'Connection Profile returned an empty or invalid response.',
                { retryable: true }
            );
        }

        if (!result || !result.trim()) {
            throw new ConnectionError(
                'Connection Profile returned an empty response.',
                { retryable: true }
            );
        }

        return result;

    } catch (error) {
        if (error instanceof ConnectionError || error.name === 'AbortError' || settings.requestSignal?.aborted) throw error;

        const msg = error?.message || String(error);
        const status = error?.status || error?.response?.status;

        if (status === 401 || msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
            throw new ConnectionError(
                `Connection Profile auth failed (401). This is likely the API key switching bug ` +
                `(ST Issue #5348). Update SillyTavern to staging (March 30, 2026+) to fix this. ` +
                `Original error: ${msg}`,
                { retryable: false, status: 401 }
            );
        }

        if (status === 404 || /not found|invalid profile|no profile/i.test(msg)) {
            throw new ConnectionError(
                `Connection Profile "${profileId}" not found. It may have been deleted. ` +
                `Please re-select a profile in Summaryception settings.`,
                { retryable: false, status: 404 }
            );
        }

        throw new ConnectionError(
            `Connection Profile request failed: ${msg}`,
            { retryable: true, status: status }
        );
    }
}

// ─── Mode 3: Ollama (Local) ─────────────────────────────────────────

/**
 * Send a request to a local Ollama instance using /api/chat.
 * Routes through ST's CORS proxy to avoid browser CORS restrictions.
 */
async function sendViaOllama(url, model, systemPrompt, userPrompt, settings = {}) {
    if (!url) {
        throw new ConnectionError(
            'Ollama URL is not configured. Please set it in Summaryception settings.',
            { retryable: false }
        );
    }
    if (!model) {
        throw new ConnectionError(
            'Ollama model is not selected. Please select one in Summaryception settings.',
            { retryable: false }
        );
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/chat`;

    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'POST', signal: settings.requestSignal,
            headers: {
                ...getProxyHeaders(),
                               'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: {
                    temperature: Number(settings.summarizerTemperature ?? LLM_DEFAULTS.ollamaTemperature),
                    ...(settings.summarizerResponseLength > 0 ? { num_predict: settings.summarizerResponseLength } : {}),
                    ...(settings.summarizerStopSequences?.length ? { stop: settings.summarizerStopSequences } : {}),
                },
            }),
        });
    } catch (proxyError) {
        if (settings.requestSignal?.aborted || proxyError.name === 'AbortError') throw proxyError;
        console.warn(`${MODULE_NAME} CORS proxy failed, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                method: 'POST', signal: settings.requestSignal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                    options: { temperature: Number(settings.summarizerTemperature ?? LLM_DEFAULTS.ollamaTemperature),
                    ...(settings.summarizerResponseLength > 0 ? { num_predict: settings.summarizerResponseLength } : {}),
                    ...(settings.summarizerStopSequences?.length ? { stop: settings.summarizerStopSequences } : {}) },
                }),
            });
        } catch (directError) {
            if (settings.requestSignal?.aborted || directError.name === 'AbortError') throw directError;
            throw new ConnectionError(
                `Failed to connect to Ollama at ${baseUrl}. ` +
                `CORS proxy error: ${proxyError.message}. Direct error: ${directError.message}. ` +
                `Make sure enableCorsProxy is set to true in config.yaml, or set OLLAMA_ORIGINS=* on your Ollama instance.`,
                { retryable: true }
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new ConnectionError(
            `Ollama request failed (${response.status}): ${errorText}`,
                                  { retryable: response.status >= 500 || response.status === 429, status: response.status, retryAfter: response.headers.get('retry-after') }
        );
    }

    const data = await response.json();
    if (data?.choices?.[0]?.finish_reason === 'length' || data?.done_reason === 'length' || data?.done === false) {
        throw new ConnectionError('Summarizer output was truncated. Increase the response token limit.', { retryable: false });
    }

    if (!data?.message?.content) {
        throw new ConnectionError(
            'Ollama returned an empty or invalid response.',
            { retryable: true }
        );
    }

    return data.message.content;
}

/**
 * Fetch available models from an Ollama instance.
 * @param {string} url - The Ollama base URL
 * @returns {Promise<Array<{name: string, size: number, modified_at: string}>>}
 */
export async function fetchOllamaModels(url) {
    if (!url) {
        throw new Error('Ollama URL is not configured.');
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/tags`;

    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'GET',
            headers: getProxyHeaders(),
        });
    } catch (proxyError) {
        console.warn(`${MODULE_NAME} CORS proxy failed for model list, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (directError) {
            throw new Error(
                `Failed to connect to Ollama at ${baseUrl}. ` +
                `Enable the CORS proxy in config.yaml (enableCorsProxy: true) or set OLLAMA_ORIGINS=* on your Ollama instance. ` +
                `Proxy error: ${proxyError.message}. Direct error: ${directError.message}`
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Failed to fetch Ollama models (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data?.models || !Array.isArray(data.models)) {
        throw new Error('Unexpected response format from Ollama /api/tags.');
    }

    return data.models;
}

// ─── Mode 4: OpenAI Compatible (Streaming) ──────────────────────────

/**
 * Send a request to any OpenAI-compatible endpoint using streaming.
 * Streaming avoids the non-streaming token ceiling (4096 on many providers)
 * and allows reasoning models to complete their full thinking + output.
 *
 * Routes through ST's CORS proxy for local endpoints.
 * Cloud endpoints skip the proxy since they have CORS headers.
 */
async function sendViaOpenAI(url, apiKey, model, systemPrompt, userPrompt, maxTokens, settings = {}) {
    if (!url) {
        throw new ConnectionError(
            'OpenAI Compatible URL is not configured. Please set it in Summaryception settings.',
            { retryable: false }
        );
    }
    if (!model) {
        throw new ConnectionError(
            'OpenAI Compatible model name is not set. Please enter one in Summaryception settings.',
            { retryable: false }
        );
    }

    const baseUrl = url.replace(/\/+$/, '');

    // Build the endpoint URL
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/v1')) {
            endpoint += '/chat/completions';
        } else if (!endpoint.includes('/chat/completions')) {
            endpoint += '/v1/chat/completions';
        }
    }

    const headers = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Use maxTokens from settings, default to 0 (no limit / provider default)
    const tokenLimit = maxTokens && maxTokens > 0 ? maxTokens : undefined;

    const requestBody = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: Number(settings.summarizerTemperature ?? LLM_DEFAULTS.openaiTemperature),
        stream: true,
    };

    // Only include max_tokens if explicitly set
    if (tokenLimit) {
        requestBody.max_tokens = tokenLimit;
    }
    if (Array.isArray(settings.summarizerStopSequences) && settings.summarizerStopSequences.length > 0) {
        requestBody.stop = settings.summarizerStopSequences;
    }

    const body = JSON.stringify(requestBody);

    // Always try ST's CORS proxy first, then fall back to a direct request.
    // Remote endpoints are the ones most likely to fail a browser CORS preflight,
    // so they must not skip the proxy. Matches the Ollama path above.
    let response;
    try {
        response = await fetch(proxiedUrl(endpoint), {
            method: 'POST', signal: settings.requestSignal,
            headers: { ...getProxyHeaders(), ...headers },
            body: body,
        });
    } catch (proxyError) {
        if (settings.requestSignal?.aborted || proxyError.name === 'AbortError') throw proxyError;
        console.warn(`${MODULE_NAME} CORS proxy failed for OpenAI endpoint, trying direct:`, proxyError.message);
        try {
            response = await fetch(endpoint, {
                method: 'POST', signal: settings.requestSignal,
                headers: headers,
                body: body,
            });
        } catch (directError) {
            if (settings.requestSignal?.aborted || directError.name === 'AbortError') throw directError;
            throw new ConnectionError(
                `Failed to connect to ${baseUrl}. ` +
                `Enable the CORS proxy in config.yaml (enableCorsProxy: true). ` +
                `Proxy error: ${proxyError.message}. Direct error: ${directError.message}`,
                { retryable: true }
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        if (response.status === 401) {
            throw new ConnectionError(
                'OpenAI Compatible endpoint returned 401 Unauthorized. Check your API key.',
                { retryable: false, status: 401 }
            );
        }
        if (response.status === 403) {
            throw new ConnectionError(
                `OpenAI Compatible endpoint returned 403 Forbidden: ${errorText}`,
                { retryable: false, status: 403 }
            );
        }
        throw new ConnectionError(
            `OpenAI Compatible request failed (${response.status}): ${errorText}`,
                                  { retryable: response.status >= 500 || response.status === 429, status: response.status, retryAfter: response.headers.get('retry-after') }
        );
    }

    if (/application\/json/i.test(response.headers.get('content-type') || '')) {
        const data = await response.json();
        const choice = data.choices?.[0];
        if (data.error || choice?.finish_reason === 'length') {
            throw new ConnectionError(data.error?.message || 'Summarizer output was truncated. Increase the response token limit.', { retryable: false });
        }
        if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
            throw new ConnectionError('OpenAI Compatible endpoint returned empty content.', { retryable: true });
        }
        return choice.message.content;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '', buffer = '', completed = false;
    const processLine = line => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') { completed = true; return; }
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { throw new ConnectionError('Malformed summarizer stream frame.', { retryable: true }); }
        if (parsed.error) throw new ConnectionError(parsed.error.message || 'Streaming API error.', { retryable: false });
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason === 'length') {
            throw new ConnectionError('Summarizer output was truncated. Increase the response token limit.', { retryable: false });
        }
        if (choice?.finish_reason) completed = true;
        if (typeof choice?.delta?.content === 'string') fullContent += choice.delta.content;
    };
    try {
        while (true) {
            settings.requestSignal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) processLine(line);
            if (completed) break;
        }
        buffer += decoder.decode();
        if (!completed && buffer.trim()) processLine(buffer);
        if (!completed) throw new ConnectionError('Summarizer stream ended before completion.', { retryable: true });
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    if (!fullContent.trim()) throw new ConnectionError('OpenAI Compatible endpoint returned an empty response.', { retryable: true });

    return fullContent;
}

/**
 * Test the connection to an OpenAI-compatible endpoint.
 * @param {string} url
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testOpenAIConnection(url, apiKey, model) {
    try {
        const result = await sendSummarizerRequest({ connectionSource: 'openai', openaiUrl: url,
            openaiKey: apiKey, openaiModel: model || 'test', openaiMaxTokens: LLM_DEFAULTS.testMaxTokens },
            'You are a test assistant.', 'Respond with exactly: CONNECTION_OK');
        return {
            success: true,
            message: `Connection successful! Response: "${result.substring(0, LLM_DEFAULTS.testPreviewLength)}"`,
        };
    } catch (error) {
        return {
            success: false,
            message: `Connection failed: ${error.message}`,
        };
    }
}


// ─── Mode 5: KoboldCPP (Direct) ─────────────────────────────────────

/**
 * Send a request directly to a KoboldCPP instance using /v1/completions.
 * Does NOT use the CORS proxy — KoboldCPP is local and doesn't need it.
 * Wraps system + user prompt with the configured instruct template.
 *
 * FORK NOTE: This is the KoboldCPP direct mode added in this fork.
 * Search "Mode 5" to find it when merging upstream updates.
 */
const koboldContextCache = new Map();

async function sendViaKoboldCPP(url, instructPrefix, instructSuffix, systemPrompt, userPrompt, settings = {}) {
    if (!url) {
        throw new Error('KoboldCPP URL is not configured. Please set it in Summaryception settings.');
    }

    const baseUrl = url.replace(/\/+$/, '');
    const prefix = (instructPrefix ?? '<|im_start|>user\n').replace(/\\n/g, '\n');
    const suffix = (instructSuffix ?? '<|im_end|>\n<|im_start|>assistant\n').replace(/\\n/g, '\n');
    const fullPrompt = `${prefix}${systemPrompt}\n\n${userPrompt}${suffix}`;

    // Cache briefly: refresh after a model reload without a GET on every batch.
    const cached = koboldContextCache.get(baseUrl);
    let maxCtx = cached && Date.now() - cached.at < 60000 ? cached.value : 4096;
    if (!cached || Date.now() - cached.at >= 60000) {
        try {
            const cfgRes = await fetch(`${baseUrl}/api/v1/config/max_context_length`, { signal: settings.requestSignal });
            if (cfgRes.ok) {
                const value = Number((await cfgRes.json()).value);
                if (Number.isFinite(value) && value > 0) maxCtx = value;
            }
            koboldContextCache.set(baseUrl, { value: maxCtx, at: Date.now() });
        } catch (error) {
            if (settings.requestSignal?.aborted) throw error;
        }
    }

    const response = await fetch(`${baseUrl}/v1/completions`, {
        method: 'POST', signal: settings.requestSignal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt:             fullPrompt,
            max_tokens:         settings.summarizerResponseLength || settings.openaiMaxTokens || 512,
            max_context_length: maxCtx,
            temperature:        Number(settings.summarizerTemperature ?? 0.3),
            top_p:              0.9,
            frequency_penalty:  0.2,
            stop: settings.summarizerStopSequences?.length
                ? settings.summarizerStopSequences
                : ['<|im_end|>', '<|eot_id|>', '<|end|>', '<|im_start|>'],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new ConnectionError(`KoboldCPP request failed (${response.status}): ${errorText}`, { retryable: response.status >= 500 || response.status === 429, status: response.status, retryAfter: response.headers.get('retry-after') });
    }

    const data = await response.json();
    if (data?.choices?.[0]?.finish_reason === 'length' || data?.done_reason === 'length' || data?.done === false) {
        throw new ConnectionError('Summarizer output was truncated. Increase the response token limit.', { retryable: false });
    }
    const text = data?.choices?.[0]?.text ?? '';

    if (!text.trim()) {
        throw new Error('KoboldCPP returned an empty response. Check your instruct template settings.');
    }

    return text.trim();
}

// ─── Mode 6: Generic Completion API ─────────────────────────────────

async function sendViaCompletion(settings, systemPrompt, userPrompt) {
    if (!settings.completionUrl) {
        throw new ConnectionError('Completion API URL is not configured.', { retryable: false });
    }
    const prefix = (settings.completionPrefix ?? '').replace(/\\n/g, '\n');
    const suffix = (settings.completionSuffix ?? '').replace(/\\n/g, '\n');
    const prompt = `${prefix}${systemPrompt}\n\n${userPrompt}${suffix}`;
    const headers = { 'Content-Type': 'application/json' };
    if (settings.completionKey) headers.Authorization = `Bearer ${settings.completionKey}`;
    const body = {
        prompt,
        temperature: Number(settings.summarizerTemperature ?? 0.3),
        max_tokens: settings.openaiMaxTokens || settings.summarizerResponseLength || 512,
    };
    if (settings.completionModel) body.model = settings.completionModel;
    if (settings.summarizerStopSequences?.length) body.stop = settings.summarizerStopSequences;
    const response = await fetch(settings.completionUrl, { method: 'POST', signal: settings.requestSignal, headers, body: JSON.stringify(body) });
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new ConnectionError(`Completion API request failed (${response.status}): ${errorText}`, {
            retryable: response.status >= 500 || response.status === 429,
            status: response.status, retryAfter: response.headers.get('retry-after'),
        });
    }
    const data = await response.json();
    if (data?.choices?.[0]?.finish_reason === 'length' || data?.done_reason === 'length' || data?.done === false) {
        throw new ConnectionError('Summarizer output was truncated. Increase the response token limit.', { retryable: false });
    }
    const text = data?.choices?.[0]?.text ?? data?.content ?? data?.response ?? data?.text ?? '';
    if (typeof text !== 'string' || !text.trim()) {
        throw new ConnectionError('Completion API returned an empty response.', { retryable: true });
    }
    return String(text).trim();
}

// ─── Mode 7: Custom HTTP JSON ───────────────────────────────────────

function replaceTemplateVars(template, vars) {
    return String(template || '').replace(/{{(systemPrompt|userPrompt|model|apiKey|temperature|maxTokens)}}/g, (_, key) => {
        const value = vars[key] ?? '';
        // Strip JSON's surrounding quotes while retaining complete JSON escaping
        // (including tabs, carriage returns, and other control characters).
        return JSON.stringify(String(value)).slice(1, -1);
    });
}

function getPathValue(obj, path) {
    return String(path || '').split('.').filter(Boolean).reduce((acc, key) => {
        const normalizedKey = /^\d+$/.test(key) ? Number(key) : key;
        return acc?.[normalizedKey];
    }, obj);
}

async function sendViaCustomHttp(settings, systemPrompt, userPrompt) {
    if (!settings.customUrl) {
        throw new ConnectionError('Custom HTTP URL is not configured.', { retryable: false });
    }
    const vars = {
        systemPrompt,
        userPrompt,
        model: settings.customModel || settings.openaiModel || settings.completionModel || '',
        apiKey: settings.customApiKey || settings.openaiKey || settings.completionKey || '',
        temperature: Number(settings.summarizerTemperature ?? 0.3),
        maxTokens: settings.openaiMaxTokens || settings.summarizerResponseLength || 512,
    };
    let headers;
    let body;
    try {
        headers = JSON.parse(replaceTemplateVars(settings.customHeaders || '{}', vars));
        body = JSON.parse(replaceTemplateVars(settings.customBodyTemplate || '{}', vars));
    } catch (error) {
        throw new ConnectionError(`Custom HTTP JSON template is invalid: ${error.message}`, { retryable: false });
    }
    const response = await fetch(settings.customUrl, { method: 'POST', signal: settings.requestSignal, headers, body: JSON.stringify(body) });
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new ConnectionError(`Custom HTTP request failed (${response.status}): ${errorText}`, {
            retryable: response.status >= 500 || response.status === 429,
            status: response.status, retryAfter: response.headers.get('retry-after'),
        });
    }
    const data = await response.json();
    if (data?.choices?.[0]?.finish_reason === 'length' || data?.done_reason === 'length' || data?.done === false) {
        throw new ConnectionError('Summarizer output was truncated. Increase the response token limit.', { retryable: false });
    }
    const value = settings.customResponsePath ? getPathValue(data, settings.customResponsePath) : (data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.response ?? data?.content);
    if (typeof value !== 'string' || !value.trim()) {
        throw new ConnectionError('Custom HTTP response path returned empty content.', { retryable: true });
    }
    return String(value).trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Populate a <select> element with connection profiles using ST's built-in handler.
 * @param {HTMLSelectElement} selectElement - The dropdown to populate
 * @param {string} currentValue - The currently selected profile ID
 * @returns {boolean} - Whether population succeeded
 */
export function populateProfileDropdown(selectElement, currentValue) {
    try {
        const context = SillyTavern.getContext();
        const service = context.ConnectionManagerRequestService;

        if (service && typeof service.handleDropdown === 'function') {
            service.handleDropdown(selectElement);
            if (currentValue) {
                selectElement.value = currentValue;
            }
            return true;
        }

        console.warn(`${MODULE_NAME} handleDropdown not available.`);
        return false;
    } catch (error) {
        console.error(`${MODULE_NAME} Error populating profile dropdown:`, error);
        return false;
    }
}

/**
 * Get a human-readable name for the current connection source.
 * @param {object} settings
 * @returns {string}
 */
export function getConnectionDisplayName(settings) {
    switch (settings.connectionSource) {
        case 'default':
            return 'Default (Main API)';
        case 'profile':
            return `Profile: ${settings.connectionProfileId || '(none)'}`;
        case 'ollama':
            return `Ollama: ${settings.ollamaModel || '(no model)'}`;
        case 'openai':
            return `OpenAI: ${settings.openaiModel || '(no model)'}`;
        case 'koboldcpp':
            return `KoboldCPP: ${settings.koboldcppUrl || '(no URL)'}`;
        case 'completion':
            return `Completion API: ${settings.completionModel || settings.completionUrl || '(not configured)'}`;
        case 'custom':
            return `Custom HTTP: ${settings.customModel || settings.customUrl || '(not configured)'}`;
        default:
            return 'Default (Main API)';
    }
}
