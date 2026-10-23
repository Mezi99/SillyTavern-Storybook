import { STORY_EVENTS, emit } from './bus.js';
import { getCtx, getMessage, uuid } from './context.js';
import { countForSettings, getSettings, sessionStats, updateStatsUI } from './settings.js';
import { planKeyframes } from './planner.js';
import { recordImageRequest } from './debug.js';
import { buildImageRequest, describeImageBackend, generateImage } from './backends/image.js';
import { ensureExtra, saveNow, saveSoon, setStorybook, sourceHashFor, syncStorybook, textHashFor } from './persistence.js';

const AUTO_REASONS = new Set(['reply', 'swipe', 'interval']);

let currentJob = null;
const queue = [];

function toast(kind, message) {
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') {
        fn.call(window.toastr, message, 'Storybook');
    } else {
        console.log(`[Storybook][${kind}]`, message);
    }
}

function jobStatePayload(state, extra = {}) {
    return { state, mesId: currentJob?.mesId ?? extra.mesId ?? null, ...extra };
}

export function getJobState() {
    if (!currentJob) {
        return { state: 'idle', mesId: null };
    }
    return { state: currentJob.state, mesId: currentJob.mesId, frame: currentJob.frame, total: currentJob.total };
}

export function isBusy(mesId = null) {
    if (currentJob && (mesId === null || currentJob.mesId === mesId)) {
        return true;
    }
    if (mesId === null) {
        return queue.length > 0;
    }
    return queue.some(job => job.mesId === mesId);
}

export function enqueue(mesId, { force = false, count = null, reason = 'manual' } = {}) {
    const settings = getSettings();
    if (AUTO_REASONS.has(reason) && !settings.enabled) {
        return false;
    }
    if (typeof mesId !== 'number' || mesId < 0) {
        return false;
    }
    // A cancelled job is still winding down. It must not block a fresh request
    // for the same message, which may belong to a different chat already.
    if (currentJob?.mesId === mesId && !currentJob.cancelled && !force) {
        return false;
    }
    if (queue.some(job => job.mesId === mesId && job.force === force)) {
        return false;
    }
    queue.push({ mesId, force, count, reason, controller: new AbortController(), cancelled: false, state: 'queued', frame: 0, total: 0 });
    emit(STORY_EVENTS.JOB, jobStatePayload('queued', { mesId }));
    void drain();
    return true;
}

export function cancelJob(mesId = null) {
    let cancelled = false;
    if (currentJob && (mesId === null || currentJob.mesId === mesId)) {
        currentJob.cancelled = true;
        currentJob.controller.abort();
        currentJob.state = 'cancelled';
        emit(STORY_EVENTS.JOB, jobStatePayload('cancelled'));
        cancelled = true;
    }
    for (let i = queue.length - 1; i >= 0; i--) {
        if (mesId === null || queue[i].mesId === mesId) {
            queue[i].cancelled = true;
            queue[i].controller.abort();
            queue.splice(i, 1);
            cancelled = true;
        }
    }
    if (cancelled) {
        toast('info', mesId === null ? 'Storybook generation stopped.' : 'Storybook generation for that message stopped.');
    }
    return cancelled;
}

async function drain() {
    if (currentJob) {
        return;
    }
    const job = queue.shift();
    if (!job) {
        return;
    }
    currentJob = job;
    try {
        await runJob(job);
    } catch (err) {
        console.error('[Storybook] job failed', err);
        toast('error', String(err?.message ?? err));
    } finally {
        currentJob = null;
        emit(STORY_EVENTS.JOB, jobStatePayload('idle'));
        updateStatsUI();
        if (queue.length) {
            void drain();
        }
    }
}

function applyStatus(storybook) {
    const frames = Array.isArray(storybook.keyframes) ? storybook.keyframes : [];
    const ready = frames.filter(frame => frame?.status === 'ready').length;
    if (!frames.length) {
        storybook.status = 'error';
    } else if (ready === frames.length) {
        storybook.status = 'ready';
    } else if (ready > 0) {
        storybook.status = 'partial';
    } else {
        storybook.status = 'error';
    }
    return storybook.status;
}

async function runJob(job) {
    const ctx = getCtx();
    const chatId = ctx.getCurrentChatId();
    const settings = getSettings();
    const message = getMessage(job.mesId);

    if (!message) {
        return;
    }

    job.state = 'running';
    emit(STORY_EVENTS.JOB, jobStatePayload('running'));

    const swipeId = message.swipe_id;
    const text = String(message.extra?.display_text ?? message.mes ?? '');
    const plannedCount = job.count ?? countForSettings(settings);
    const hash = sourceHashFor({
        text,
        count: plannedCount,
        styleProfile: settings.styleProfile,
        styleText: settings.styleText,
        anchor: settings.anchor,
        plannerPrompt: settings.plannerPrompt,
        size: settings.size,
    });

    /**
     * The job only owns the message while the chat and the active swipe are unchanged.
     * SillyTavern replaces the whole `extra` object when the user swipes, so writing
     * after that would attach the artwork to the wrong variant.
     * @returns {boolean} True while the job still targets the same reply
     */
    const stillOnTarget = () => {
        if (ctx.getCurrentChatId() !== chatId) {
            return false;
        }
        const current = getMessage(job.mesId);
        if (!current) {
            return false;
        }
        return current.swipe_id === swipeId;
    };

    const existing = message.extra?.storybook;
    if (!job.force && existing?.sourceHash === hash && existing.status === 'ready'
        && Array.isArray(existing.keyframes) && existing.keyframes.some(frame => frame?.url)) {
        return;
    }

    const previousFrames = Array.isArray(existing?.keyframes) ? existing.keyframes : [];
    const storybook = {
        v: 1,
        id: existing?.id ?? uuid(),
        sourceHash: hash,
        textHash: textHashFor(String(message.mes ?? '')),
        status: 'planning',
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        anchor: String(settings.anchor ?? '').trim(),
        backend: { kind: 'st', text: describeImageBackend().text },
        planner: { api: String(ctx.mainApi ?? ''), backend: String(settings.plannerBackend ?? 'st') },
        settings: {
            count: plannedCount,
            size: settings.size,
            styleProfile: settings.styleProfile ?? 'auto',
            styleText: settings.styleText ?? '',
            negative: settings.negative ?? '',
        },
        keyframes: previousFrames.map(frame => ({ ...frame })),
        error: '',
    };

    ensureExtra(message);
    syncStorybook(message, storybook);
    sessionStats.jobs++;
    emit(STORY_EVENTS.UPDATE, { mesId: job.mesId });
    saveSoon();

    let planned;
    try {
        planned = await planKeyframes({ mesId: job.mesId, count: plannedCount, signal: job.controller.signal });
    } catch (err) {
        if (!stillOnTarget()) {
            return;
        }
        storybook.status = 'error';
        storybook.error = String(err?.message ?? err);
        storybook.updatedAt = Date.now();
        syncStorybook(message, storybook);
        emit(STORY_EVENTS.UPDATE, { mesId: job.mesId });
        await saveNow();
        toast('error', storybook.error);
        return;
    }

    if (!stillOnTarget()) {
        return;
    }

    storybook.anchor = planned.anchor;
    storybook.keyframes = planned.keyframes;
    storybook.status = 'generating';
    storybook.updatedAt = Date.now();
    job.total = storybook.keyframes.length;
    syncStorybook(message, storybook);
    emit(STORY_EVENTS.UPDATE, { mesId: job.mesId });
    saveSoon();

    let failedSystemically = false;

    for (let i = 0; i < storybook.keyframes.length; i++) {
        const frame = storybook.keyframes[i];
        if (!stillOnTarget()) {
            break;
        }

        job.frame = i + 1;
        frame.status = 'pending';
        syncStorybook(message, storybook);
        emit(STORY_EVENTS.UPDATE, { mesId: job.mesId });
        emit(STORY_EVENTS.JOB, jobStatePayload('running'));
        saveSoon();

        const started = performance.now();
        try {
            recordImageRequest({
                chatId,
                mesId: job.mesId,
                frameIndex: i,
                request: buildImageRequest({ prompt: frame.prompt }),
            });
            const result = await generateImage({
                prompt: frame.prompt,
                signal: job.controller.signal,
            });
            frame.url = result.url;
            frame.status = 'ready';
            frame.elapsedMs = Math.round(performance.now() - started);
            sessionStats.images++;
            updateStatsUI();
        } catch (err) {
            if (job.cancelled || job.controller.signal.aborted || err?.name === 'AbortError') {
                break;
            }
            frame.status = 'error';
            frame.error = String(err?.message ?? err);
            frame.elapsedMs = Math.round(performance.now() - started);
            if (err?.systemic) {
                failedSystemically = true;
            }
            console.warn('[Storybook] keyframe', i + 1, 'failed', err);
        }

        if (!stillOnTarget()) {
            break;
        }

        storybook.updatedAt = Date.now();
        syncStorybook(message, storybook);
        emit(STORY_EVENTS.UPDATE, { mesId: job.mesId });
        saveSoon();

        if (failedSystemically) {
            for (let j = i + 1; j < storybook.keyframes.length; j++) {
                storybook.keyframes[j].status = 'error';
                storybook.keyframes[j].error = 'Skipped after the previous frame failed.';
            }
            break;
        }
    }

    if (!stillOnTarget()) {
        job.cancelled = true;
        return;
    }

    if (job.cancelled || job.controller.signal.aborted) {
        applyStatus(storybook);
        if (storybook.status === 'error') {
            storybook.status = 'cancelled';
        }
        storybook.updatedAt = Date.now();
        syncStorybook(message, storybook);
        emit(STORY_EVENTS.UPDATE, { mesId: job.mesId });
        await saveNow();
        return;
    }

    applyStatus(storybook);
    storybook.updatedAt = Date.now();
    storybook.backend.text = describeImageBackend().text;
    syncStorybook(message, storybook);
    emit(STORY_EVENTS.UPDATE, { mesId: job.mesId });
    await saveNow();
    updateStatsUI();

    const readyCount = storybook.keyframes.filter(frame => frame.status === 'ready').length;
    const total = storybook.keyframes.length;

    if (storybook.status === 'ready') {
        toast('success', `Storybook ready: ${readyCount} of ${total} keyframes rendered.`);
        emit(STORY_EVENTS.COMPLETE, { mesId: job.mesId });
        if (settings.openLightboxOnFinish) {
            emit(STORY_EVENTS.OPEN, { mesId: job.mesId, index: 0 });
        }
    } else if (storybook.status === 'partial') {
        toast('warning', `Storybook partially rendered: ${readyCount} of ${total} keyframes.`);
        emit(STORY_EVENTS.COMPLETE, { mesId: job.mesId });
    } else {
        const detail = storybook.keyframes.find(frame => frame.error)?.error || 'No keyframe could be rendered.';
        toast('error', `Storybook failed: ${detail}`);
        emit(STORY_EVENTS.COMPLETE, { mesId: job.mesId });
    }
}
