import { getCustomApiKey } from '../settings.js';

function buildEndpoint(baseUrl) {
    const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        throw new Error('The custom planner API base URL is empty.');
    }
    if (/\/chat\/completions$/i.test(trimmed)) {
        return trimmed;
    }
    if (/\/v\d+$/i.test(trimmed)) {
        return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/v1/chat/completions`;
}

function extractContent(data) {
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map(part => (typeof part === 'string' ? part : (part?.text ?? '')))
            .join('');
    }
    if (typeof choice?.text === 'string') {
        return choice.text;
    }
    return '';
}

export function describePlannerBackend(settings) {
    if (settings.plannerBackend !== 'custom') {
        return { ok: true, text: 'Using the SillyTavern chat API for storyboard planning.' };
    }
    const baseUrl = String(settings.customApi?.baseUrl ?? '').trim();
    const model = String(settings.customApi?.model ?? '').trim();
    const key = getCustomApiKey();
    const missing = [];
    if (!baseUrl) {
        missing.push('base URL');
    }
    if (!model) {
        missing.push('model');
    }
    if (!key) {
        missing.push('API key');
    }
    if (missing.length) {
        return { ok: false, text: `Custom planner API is missing: ${missing.join(', ')}.` };
    }
    return { ok: true, text: `Using custom planner API · ${model}` };
}

/**
 * Sends the planner request to an OpenAI-compatible chat completions endpoint.
 * @param {object} options
 * @param {string} options.systemPrompt
 * @param {string} options.userPrompt
 * @param {object} options.settings Extension settings
 * @param {number} options.count Planned keyframe count
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} Raw response text
 */
export async function requestCustomPlan({ systemPrompt, userPrompt, settings, count, signal }) {
    const endpoint = buildEndpoint(settings.customApi?.baseUrl);
    const apiKey = getCustomApiKey();
    if (!apiKey) {
        throw new Error('The custom planner API key is missing.');
    }

    const body = {
        model: String(settings.customApi?.model ?? '').trim(),
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: Number.isFinite(Number(settings.customApi?.temperature))
            ? Number(settings.customApi.temperature)
            : 0.7,
        max_tokens: Number.isFinite(Number(settings.customApi?.maxTokens))
            ? Number(settings.customApi.maxTokens)
            : 2048,
        stream: false,
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Custom planner API error ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    const data = await response.json().catch(() => null);
    const content = extractContent(data);
    if (!content) {
        throw new Error('Custom planner API returned an empty response.');
    }
    return content;
}
