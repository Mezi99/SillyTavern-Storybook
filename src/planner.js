import { PLANNER_SCHEMA } from './defaults.js';
import { buildPlannerInput, buildUserPrompt, getCtx } from './context.js';
import { countForSettings, getPlannerPrompt, getSettings, sessionStats } from './settings.js';
import { requestCustomPlan } from './backends/planner.js';
import { recordPlanResult, recordPlannerAttempt, recordPlannerError, recordPlannerRequest } from './debug.js';
import { composeStyledPromptDetailed, resolveStyleProfile } from './styles.js';

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

export function compileImagePromptDetailed({ imagePrompt, anchor, styleText, styleProfile }) {
    const ctx = getCtx();
    return composeStyledPromptDetailed({
        profile: resolveStyleProfile(styleProfile),
        userStyle: cleanString(ctx.substituteParams(styleText ?? ''), 500),
        anchor: cleanString(ctx.substituteParams(anchor ?? ''), 500),
        imagePrompt: cleanString(imagePrompt, 900),
        maxChars: 1500,
    });
}

export function compileImagePrompt(options) {
    return compileImagePromptDetailed(options).prompt;
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
    const styleProfile = settings.styleProfile ?? 'auto';

    const promptDetails = [];
    const keyframes = usable.map((item, position) => {
        const compiled = compileImagePromptDetailed({
            imagePrompt: item.imagePrompt,
            anchor,
            styleText,
            styleProfile,
        });
        promptDetails.push(compiled);
        return {
            i: position,
            title: item.title || `Frame ${position + 1}`,
            caption: item.caption,
            prompt: compiled.prompt,
            rawImagePrompt: item.imagePrompt,
            status: 'pending',
            url: '',
            error: '',
            elapsedMs: 0,
        };
    });

    return {
        anchor,
        keyframes,
        input,
        promptDetails,
    };
}

async function requestPlan({ chatId, mesId, systemPrompt, userPrompt, count, useSchema, settings, signal }) {
    const ctx = getCtx();

    if (settings.plannerBackend === 'custom') {
        const raw = await requestCustomPlan({ systemPrompt, userPrompt, settings, count, signal });
        const parsed = normalizePlannerOutput(raw);
        recordPlannerAttempt({ chatId, mesId, kind: 'custom', raw, parsed: Boolean(parsed) });
        return parsed;
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
            const usable = Boolean(parsed && Array.isArray(parsed.keyframes) && parsed.keyframes.length);
            recordPlannerAttempt({ chatId, mesId, kind: 'structured', raw, parsed: usable });
            if (usable) {
                return parsed;
            }
        } catch (err) {
            recordPlannerAttempt({ chatId, mesId, kind: 'structured', raw: '', parsed: false, error: err?.message ?? err });
            console.warn('[Storybook] structured planner attempt failed, retrying as plain text', err);
        }
    }
    const raw = await ctx.generateRaw(options);
    const parsed = normalizePlannerOutput(raw);
    recordPlannerAttempt({ chatId, mesId, kind: 'plain', raw, parsed: Boolean(parsed) });
    return parsed;
}

export async function planKeyframes({ mesId, count, signal }) {
    const settings = getSettings();
    const ctx = getCtx();
    const chatId = String(ctx.getCurrentChatId?.() ?? 'unsaved');
    const plannedCount = count ?? countForSettings(settings);
    const input = buildPlannerInput(mesId, settings);

    if (!input.target.trim()) {
        throw new Error('The target message has no text to illustrate.');
    }

    const systemPrompt = resolveSystemPrompt(settings, plannedCount);
    const userPrompt = buildUserPrompt(input);
    const useSchema = ctx.mainApi === 'openai' && settings.plannerBackend !== 'custom';

    recordPlannerRequest({
        chatId,
        mesId,
        systemPrompt,
        userPrompt,
        meta: {
            backend: settings.plannerBackend,
            api: ctx.mainApi ?? '',
            count: plannedCount,
            responseLength: responseLengthFor(plannedCount),
            useSchema,
            model: settings.plannerBackend === 'custom' ? String(settings.customApi?.model ?? '') : '',
        },
    });

    sessionStats.plannerCalls++;

    let data = null;
    try {
        data = await requestPlan({ chatId, mesId, systemPrompt, userPrompt, count: plannedCount, useSchema, settings, signal });
    } catch (err) {
        recordPlannerError({ chatId, mesId, message: err?.message ?? err });
        throw new Error(`Storyboard planning failed: ${err?.message ?? err}`);
    }

    if (!data) {
        recordPlannerError({ chatId, mesId, message: 'The storyboard planner did not return JSON.' });
        throw new Error('The storyboard planner did not return JSON. Open the Storybook debug tools after adjusting the planner prompt.');
    }

    try {
        const plan = shapeKeyframes(data, plannedCount, input, settings);
        recordPlanResult({
            chatId,
            mesId,
            anchor: plan.anchor,
            frames: plan.keyframes,
            promptDetails: plan.promptDetails,
        });
        return plan;
    } catch (err) {
        recordPlannerError({ chatId, mesId, message: err?.message ?? err });
        throw err;
    }
}
