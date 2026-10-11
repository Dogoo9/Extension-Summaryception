import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSummarizerRequest } from '../connectionutil.js';

const settings = { connectionSource: 'openai', openaiUrl: 'http://local', openaiModel: 'model', summarizerTimeoutMs: 1000 };
globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) };
const sse = (text, ending = '') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n${ending}`, { headers: { 'Content-Type': 'text/event-stream' } });

test('OpenAI stream consumes a final SSE frame without a newline', async () => {
    globalThis.fetch = async () => sse('Complete', 'data: [DONE]');
    assert.equal(await sendSummarizerRequest(settings, 'System', 'User'), 'Complete');
});

test('truncated/incomplete streams and streaming API errors are rejected', async () => {
    for (const response of [sse('Partial'), sse('Partial', 'data: {"choices":[{"finish_reason":"length"}]}\n'), sse('', 'data: {"error":{"message":"Denied"}}\n')]) {
        globalThis.fetch = async () => response;
        await assert.rejects(sendSummarizerRequest(settings, 'System', 'User'));
    }
});

test('JSON chat response fallback and rate limit metadata work', async () => {
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'JSON response' }, finish_reason: 'stop' }] });
    assert.equal(await sendSummarizerRequest(settings, 'System', 'User'), 'JSON response');
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 });
    await assert.rejects(sendSummarizerRequest(settings, 'System', 'User'), error => error.retryable && error.status === 429);
});

test('abort reaches fetch and never falls back to a second direct request', async () => {
    let calls = 0;
    globalThis.fetch = (_url, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))); };
    const controller = new AbortController();
    const request = sendSummarizerRequest(settings, 'System', 'User', { signal: controller.signal });
    controller.abort(); await assert.rejects(request, { name: 'AbortError' }); assert.equal(calls, 1);
});

test('Ollama honors temperature zero, stop sequences and output length', async () => {
    let body;
    globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return Response.json({ message: { content: 'Summary' } }); };
    await sendSummarizerRequest({ connectionSource: 'ollama', ollamaUrl: 'http://local', ollamaModel: 'model', summarizerTemperature: 0, summarizerResponseLength: 700, summarizerStopSequences: ['END'] }, 'System', 'User');
    assert.deepEqual(body.options, { temperature: 0, num_predict: 700, stop: ['END'] });
});

test('KoboldCPP caches context lookup and exposes retryable errors', async () => {
    let configs = 0; let output = 0;
    globalThis.fetch = async (url, options) => {
        if (url.includes('/config/')) { configs++; return Response.json({ value: 8192 }); }
        output = JSON.parse(options.body).max_tokens;
        return Response.json({ choices: [{ text: 'Summary' }] });
    };
    const config = { connectionSource: 'koboldcpp', koboldcppUrl: 'http://kobold', summarizerResponseLength: 700 };
    await sendSummarizerRequest(config, 'System', 'User'); await sendSummarizerRequest(config, 'System', 'User');
    assert.equal(configs, 1); assert.equal(output, 700);
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 });
    await assert.rejects(sendSummarizerRequest(config, 'System', 'User'), error => error.status === 429 && error.retryable);
});

test('custom HTTP JSON escaping preserves user prose and numeric template settings', async () => {
    let body;
    globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return Response.json({ output: { text: 'Summary' } }); };
    await sendSummarizerRequest({ connectionSource: 'custom', customUrl: 'http://custom', customHeaders: '{}', customBodyTemplate: '{"prompt":"{{userPrompt}}","temperature":{{temperature}}}', customResponsePath: 'output.text', summarizerTemperature: 0 }, 'System', 'Quotes " newline\n tab\t');
    assert.equal(body.prompt, 'Quotes " newline\n tab\t'); assert.equal(body.temperature, 0);
});

test('generateRaw receives response limit and cancellation uses the native stop event', async () => {
    let options;
    let stop;
    let stopped = false;
    globalThis.SillyTavern = { getContext: () => ({
        generateRaw: async arg => { options = arg; return new Promise((_, reject) => { stop = () => reject(new DOMException('Stopped', 'AbortError')); }); },
        eventTypes: { GENERATION_STOPPED: 'stop' },
        eventSource: { emit(event) { assert.equal(event, 'stop'); stopped = true; stop(); } },
    }) };
    const controller = new AbortController();
    const request = sendSummarizerRequest({ connectionSource: 'default', summarizerResponseLength: 700 }, 'System', 'User', { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(stopped, true); assert.equal(options.responseLength, 700);
});

test('connection profile uses numeric token limit and supported fourth-argument controls', async () => {
    let args;
    globalThis.SillyTavern = { getContext: () => ({ ConnectionManagerRequestService: { sendRequest: async (...value) => { args = value; return { content: 'Summary' }; } } }) };
    const controller = new AbortController();
    await sendSummarizerRequest({ connectionSource: 'profile', connectionProfileId: 'p', summarizerResponseLength: 700 }, 'System', 'User', { signal: controller.signal });
    assert.equal(args[2], 700); assert.equal(args[3].signal, controller.signal);
    assert.equal(args[3].includePreset, false); assert.equal(args[3].includeInstruct, false);
});

test('completion and Ollama truncated JSON replies are rejected', async () => {
    globalThis.fetch = async () => Response.json({ choices: [{ text: 'Partial', finish_reason: 'length' }] });
    await assert.rejects(sendSummarizerRequest({ connectionSource: 'completion', completionUrl: 'http://local' }, 'System', 'User'), /truncated/);
    globalThis.fetch = async () => Response.json({ message: { content: 'Partial' }, done_reason: 'length' });
    await assert.rejects(sendSummarizerRequest({ connectionSource: 'ollama', ollamaUrl: 'http://local', ollamaModel: 'm' }, 'System', 'User'), /truncated/);
});
