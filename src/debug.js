import { STORY_EVENTS, emit } from './bus.js';

const MAX_TRACES = 20;
const traces = new Map();

function traceKey(chatId, mesId) {
    return `${chatId ?? 'unsaved'}::${mesId}`;
}

function trimTraces() {
    if (traces.size <= MAX_TRACES) {
        return;
    }
    const oldest = [...traces.entries()]
        .sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
        .slice(0, traces.size - MAX_TRACES);
    for (const [key] of oldest) {
        traces.delete(key);
    }
}

function ensureTrace(chatId, mesId) {
    const key = traceKey(chatId, mesId);
    let trace = traces.get(key);
    if (!trace) {
        trace = {
            chatId: chatId ?? null,
            mesId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            request: null,
            attempts: [],
            plan: null,
            images: [],
            errors: [],
        };
        traces.set(key, trace);
        trimTraces();
    }
    return trace;
}

function commit(trace) {
    trace.updatedAt = Date.now();
    emit(STORY_EVENTS.DEBUG, { chatId: trace.chatId, mesId: trace.mesId });
}

export function recordPlannerRequest({ chatId, mesId, systemPrompt, userPrompt, meta = {} }) {
    const trace = ensureTrace(chatId, mesId);
    trace.request = {
        systemPrompt: String(systemPrompt ?? ''),
        userPrompt: String(userPrompt ?? ''),
        meta: { ...meta },
        at: Date.now(),
    };
    trace.attempts = [];
    trace.plan = null;
    trace.images = [];
    trace.errors = [];
    commit(trace);
}

export function recordPlannerAttempt({ chatId, mesId, kind, raw, parsed = false, error = '' }) {
    const trace = ensureTrace(chatId, mesId);
    let text = raw;
    if (text && typeof text === 'object') {
        try {
            text = JSON.stringify(text, null, 2);
        } catch {
            text = String(text);
        }
    }
    trace.attempts.push({
        kind: String(kind ?? 'request'),
        raw: String(text ?? ''),
        parsed: Boolean(parsed),
        error: String(error ?? ''),
        at: Date.now(),
    });
    commit(trace);
}

export function recordPlannerError({ chatId, mesId, message }) {
    const trace = ensureTrace(chatId, mesId);
    trace.errors.push({
        message: String(message ?? ''),
        at: Date.now(),
    });
    commit(trace);
}

export function recordPlanResult({ chatId, mesId, anchor, frames, promptDetails = [] }) {
    const trace = ensureTrace(chatId, mesId);
    trace.plan = {
        anchor: String(anchor ?? ''),
        frames: Array.isArray(frames) ? frames.map(frame => ({
            i: frame.i,
            title: frame.title ?? '',
            caption: frame.caption ?? '',
            imagePrompt: frame.rawImagePrompt ?? '',
            prompt: frame.prompt ?? '',
        })) : [],
        promptDetails: Array.isArray(promptDetails) ? promptDetails : [],
        at: Date.now(),
    };
    commit(trace);
}

export function recordImageRequest({ chatId, mesId, frameIndex, request }) {
    const trace = ensureTrace(chatId, mesId);
    const entry = {
        frameIndex,
        prompt: String(request?.prompt ?? ''),
        negative: String(request?.negative ?? ''),
        width: request?.width ?? null,
        height: request?.height ?? null,
        at: Date.now(),
    };
    const existing = trace.images.findIndex(item => item.frameIndex === frameIndex);
    if (existing >= 0) {
        trace.images[existing] = entry;
    } else {
        trace.images.push(entry);
    }
    commit(trace);
}

export function getDebugTrace(chatId, mesId) {
    return traces.get(traceKey(chatId, mesId)) ?? null;
}

export function getLatestDebugTrace() {
    let latest = null;
    for (const trace of traces.values()) {
        if (!latest || (trace.updatedAt ?? 0) > (latest.updatedAt ?? 0)) {
            latest = trace;
        }
    }
    return latest;
}

export function clearDebugTrace(chatId, mesId) {
    const key = traceKey(chatId, mesId);
    const removed = traces.delete(key);
    if (removed) {
        emit(STORY_EVENTS.DEBUG, { chatId, mesId });
    }
    return removed;
}

export function clearAllDebug() {
    traces.clear();
    emit(STORY_EVENTS.DEBUG, {});
}
