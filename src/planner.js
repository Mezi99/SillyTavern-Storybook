import { PLANNER_SCHEMA } from './defaults.js';
import { buildPlannerInput, buildUserPrompt, getCtx } from './context.js';
import { countForSettings, getPlannerPrompt, getSettings, sessionStats } from './settings.js';
import { requestCustomPlan } from './backends/planner.js';

function parseJsonCandidate(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced?.[1], trimmed];
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        const body = candidate.trim();
        try {
            const direct = JSON.parse(body);
            if (direct && typeof direct === 'object') {
                return direct;
            }
        } catch { /* keep scanning */ }

        const start = body.indexOf('{');
        if (start < 0) {
            continue;
        }
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < body.length; i++) {
            const ch = body[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
            } else if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        const balanced = JSON.parse(body.slice(start, i + 1));
                        if (balanced && typeof balanced === 'object') {
                            return balanced;
                        }
                    } catch { /* ignore */ }
                    break;
                }
            }
        }
    }
    return null;
}

function normalizePlannerOutput(raw) {
    if (raw && typeof raw === 'object') {
        return raw;
    }
    return parseJsonCandidate(raw);
}

function resolveSystemPrompt(settings, count) {
    const anchor = String(settings.anchor ?? '').trim();
    const base = getPlannerPrompt(settings).replace(/\{count\}/g, String(count));
    if (anchor) {
        return `${base}\n\nA character anchor is provided below. Use it exactly as written, characterAnchor in your reply must be this string:\n${anchor}`;
    }
    return base;
}

function responseLengthFor(count) {
    return Math.min(4096, 600 + count * 520);
}

function cleanString(value, max = 400) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function compileImagePrompt({ imagePrompt, anchor, styleText }) {
    const ctx = getCtx();
    const parts = [];
    const style = cleanString(ctx.substituteParams(styleText ?? ''), 500);
    if (style) {
        parts.push(style.replace(/,+$/, ''));
    }
    const character = cleanString(ctx.substituteParams(anchor ?? ''), 500);
    if (character) {
        parts.push(character.replace(/,+$/, ''));
    }
    parts.push(cleanString(imagePrompt, 900));
    return parts.filter(Boolean).join(', ');
}

function shapeKeyframes(data, count, input, settings) {
    const list = Array.isArray(data.keyframes) ? data.keyframes : [];
    const usable = list
        .filter(item => item && typeof item === 'object')
        .map((item, position) => ({
            index: Number.isFinite(Number(item.index)) ? Number(item.index) : position + 1,
            title: cleanString(item.title, 80),
            caption: cleanString(item.caption, 300),
            imagePrompt: cleanString(item.imagePrompt ?? item.prompt, 900),
        }))
        .filter(item => item.imagePrompt)
        .sort((a, b) => a.index - b.index)
        .slice(0, count);

    if (!usable.length) {
        throw new Error('The storyboard planner returned no usable keyframes.');
    }

    const anchor = String(settings.anchor ?? '').trim() || cleanString(data.characterAnchor, 500);
    const styleText = settings.styleText ?? '';

    return {
        anchor,
        keyframes: usable.map((item, position) => ({
            i: position,
            title: item.title || `Frame ${position + 1}`,
            caption: item.caption,
            prompt: compileImagePrompt({ imagePrompt: item.imagePrompt, anchor, styleText }),
            rawImagePrompt: item.imagePrompt,
            status: 'pending',
            url: '',
            error: '',
            elapsedMs: 0,
        })),
        input,
    };
}

async function requestPlan({ systemPrompt, userPrompt, count, useSchema, settings, signal }) {
    const ctx = getCtx();

    if (settings.plannerBackend === 'custom') {
        const raw = await requestCustomPlan({ systemPrompt, userPrompt, settings, count, signal });
        return normalizePlannerOutput(raw);
    }

    const options = {
        prompt: userPrompt,
        systemPrompt,
        responseLength: responseLengthFor(count),
        trimNames: false,
    };
    if (useSchema) {
        try {
            const raw = await ctx.generateRaw({ ...options, jsonSchema: PLANNER_SCHEMA });
            const parsed = normalizePlannerOutput(raw);
            if (parsed && Array.isArray(parsed.keyframes) && parsed.keyframes.length) {
                return parsed;
            }
        } catch (err) {
            console.warn('[Storybook] structured planner attempt failed, retrying as plain text', err);
        }
    }
    const raw = await ctx.generateRaw(options);
    return normalizePlannerOutput(raw);
}

export async function planKeyframes({ mesId, count, signal }) {
    const settings = getSettings();
    const ctx = getCtx();
    const plannedCount = count ?? countForSettings(settings);
    const input = buildPlannerInput(mesId, settings);

    if (!input.target.trim()) {
        throw new Error('The target message has no text to illustrate.');
    }

    const systemPrompt = resolveSystemPrompt(settings, plannedCount);
    const userPrompt = buildUserPrompt(input);
    const useSchema = ctx.mainApi === 'openai' && settings.plannerBackend !== 'custom';

    sessionStats.plannerCalls++;

    let data = null;
    try {
        data = await requestPlan({ systemPrompt, userPrompt, count: plannedCount, useSchema, settings, signal });
    } catch (err) {
        throw new Error(`Storyboard planning failed: ${err?.message ?? err}`);
    }

    if (!data) {
        throw new Error('The storyboard planner did not return JSON. Try the "Test planner" button after adjusting the planner prompt.');
    }

    return shapeKeyframes(data, plannedCount, input, settings);
}
