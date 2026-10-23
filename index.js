import { STORY_EVENTS, emit, on } from './src/bus.js';
import { getCtx, isIllustratable, lastAssistantMessageId, tryGetCtx } from './src/context.js';
import { TRIGGERS } from './src/defaults.js';
import {
    bindSettingsControls,
    getSettings,
    loadSettingsHtml,
    refreshSettingsUI,
    updateStatsUI,
} from './src/settings.js';
import { cancelJob, enqueue } from './src/pipeline.js';
import { initCarousel, renderAll, renderMessage } from './src/carousel.js';
import { initView } from './src/view.js';
import { initLightbox } from './src/lightbox.js';
import { initWindow, resetWindowLayout } from './src/window.js';
import { registerCommands } from './src/commands.js';
import { describeImageBackend, generateImage } from './src/backends/image.js';
import { compileImagePrompt, planKeyframes } from './src/planner.js';
import { describePlannerBackend } from './src/backends/planner.js';
import { clearStorybook, getStorybook, isStorybookStale, saveNow } from './src/persistence.js';

/** Render types that show a storybook carousel for the message. */
const REPLY_RENDER_TYPES = new Set(['normal', 'append', 'appendFinal', 'continue', undefined]);
/**
 * Render types that also start a generation.
 * The greeting is handled separately: it is re-rendered every time a chat is opened,
 * so it may only be illustrated while the chat is being created.
 */
const REPLY_TRIGGER_TYPES = new Set(['normal', 'append', 'appendFinal', 'continue', undefined]);

let started = false;
/**
 * True while the greeting of a brand new chat may still be illustrated.
 * SillyTavern renders the greeting every time a chat is opened, so the flag
 * makes sure that reopening a chat never spends image credits again.
 */
let pendingGreeting = false;

function toast(kind, message) {
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') {
        fn.call(window.toastr, message, 'Storybook');
    }
}

/**
 * Counts the assistant replies that were made after the last illustrated one.
 * @param {number} mesId Message that is about to be illustrated
 * @returns {number} Number of replies since the last usable storybook
 */
function repliesSinceLastStorybook(mesId) {
    const ctx = tryGetCtx();
    const chat = ctx?.chat ?? [];
    let count = 0;
    for (let i = mesId; i >= 0; i--) {
        const message = chat[i];
        if (!isIllustratable(message)) {
            continue;
        }
        const storybook = getStorybook(message);
        if (storybook && Array.isArray(storybook.keyframes)
            && storybook.keyframes.some(frame => frame?.status === 'ready' && frame?.url)) {
            break;
        }
        count++;
    }
    return count;
}

function shouldTriggerNow(reason, mesId = -1) {
    const settings = getSettings();
    if (!settings.enabled) {
        return false;
    }
    if (settings.trigger === TRIGGERS.MANUAL) {
        return false;
    }
    if (reason === 'swipe') {
        return Boolean(settings.autoOnSwipe);
    }
    if (settings.trigger === TRIGGERS.INTERVAL) {
        const interval = Math.max(1, Number(settings.interval) || 1);
        return repliesSinceLastStorybook(mesId) >= interval;
    }
    return true;
}

function triggerStorybook(mesId, reason) {
    if (mesId < 0) {
        return;
    }
    if (!shouldTriggerNow(reason, mesId)) {
        return;
    }
    enqueue(mesId, { reason });
}

/**
 * Removes artwork that was generated for a different text variant.
 * Swiping and editing replace the message text, so the old storybook no longer belongs to it.
 * @param {number} mesId Message index
 */
function dropStaleStorybook(mesId) {
    const message = tryGetCtx()?.chat?.[mesId];
    if (!isIllustratable(message)) {
        return;
    }
    const storybook = getStorybook(message);
    if (storybook && isStorybookStale(message, storybook)) {
        clearStorybook(message);
        void saveNow();
    }
}

function describeStatus() {
    const backend = describeImageBackend();
    const planner = describePlannerBackend(getSettings());
    return {
        image: backend,
        planner,
    };
}

function updateStatusLabels() {
    const status = describeStatus();
    const imageEl = document.getElementById('storybook_image_status');
    if (imageEl) {
        imageEl.textContent = status.image.text;
        imageEl.classList.toggle('is-error', !status.image.ok);
    }
    const plannerEl = document.getElementById('storybook_planner_status');
    if (plannerEl) {
        plannerEl.textContent = status.planner.text;
        plannerEl.classList.toggle('is-error', !status.planner.ok);
    }
    const backendEl = document.getElementById('storybook_image_backend');
    if (backendEl) {
        backendEl.textContent = status.image.ok ? 'SillyTavern Image Generation' : 'Unavailable';
    }
}

function bindActionButtons() {
    const onClick = (id, handler) => {
        const element = document.getElementById(id);
        if (!element) {
            return;
        }
        element.addEventListener('click', async (event) => {
            event.preventDefault();
            try {
                await handler(element);
            } catch (err) {
                console.error('[Storybook] action failed', err);
                toast('error', String(err?.message ?? err));
            }
        });
    };

    onClick('storybook_test_planner', async () => {
        const mesId = lastAssistantMessageId();
        if (mesId < 0) {
            toast('warning', 'There is no assistant message to plan yet.');
            return;
        }
        toast('info', 'Planning a storyboard...');
        const plan = await planKeyframes({ mesId, count: getSettings().keyframes });
        const preview = document.getElementById('storybook_preview');
        if (preview) {
            preview.textContent = JSON.stringify({
                anchor: plan.anchor,
                keyframes: plan.keyframes.map(frame => ({
                    title: frame.title,
                    caption: frame.caption,
                    prompt: frame.prompt,
                })),
            }, null, 2);
        }
        toast('success', `Planner returned ${plan.keyframes.length} keyframes.`);
    });

    onClick('storybook_test_image', async () => {
        const settings = getSettings();
        const prompt = compileImagePrompt({
            imagePrompt: 'A calm storybook illustration of a quiet moment, soft light, painterly.',
            anchor: settings.anchor,
            styleText: settings.styleText,
            styleProfile: settings.styleProfile,
        });
        toast('info', 'Generating a test image...');
        const result = await generateImage({ prompt });
        const preview = document.getElementById('storybook_preview');
        if (preview) {
            preview.innerHTML = '';
            const image = document.createElement('img');
            image.src = result.url;
            image.alt = 'Storybook test image';
            preview.appendChild(image);
        }
        toast('success', 'Test image ready.');
    });

    onClick('storybook_show_sd', () => {
        const container = document.getElementById('sd_container');
        if (!container) {
            toast('warning', 'The Image Generation extension is not available.');
            return;
        }
        container.scrollIntoView({ behavior: 'smooth', block: 'center' });
        container.classList.add('storybook-highlight');
        setTimeout(() => container.classList.remove('storybook-highlight'), 1600);
    });

    onClick('storybook_generate_last', () => {
        const mesId = lastAssistantMessageId();
        if (mesId < 0) {
            toast('warning', 'There is no assistant message to illustrate yet.');
            return;
        }
        enqueue(mesId, { force: true, reason: 'manual' });
    });

    onClick('storybook_cancel_job', () => {
        cancelJob(null);
    });

    onClick('storybook_clear_last', () => {
        const mesId = lastAssistantMessageId();
        if (mesId < 0) {
            return;
        }
        const ctx = getCtx();
        const message = ctx.chat[mesId];
        if (!message?.extra?.storybook) {
            toast('info', 'That message has no storybook.');
            return;
        }
        clearStorybook(message);
        void saveNow();
        renderMessage(mesId);
        emit(STORY_EVENTS.UPDATE, { mesId });
        updateStatsUI();
        toast('info', 'Storybook removed from that message.');
    });

    onClick('storybook_reset_window', () => {
        resetWindowLayout();
        toast('info', 'Floating window position reset.');
    });
}

function registerEvents() {
    const ctx = getCtx();
    const { eventSource, eventTypes } = ctx;

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (mesId, type) => {
        const message = tryGetCtx()?.chat?.[mesId];
        if (!isIllustratable(message)) {
            return;
        }

        // A storybook belongs to one exact reply. Swipes and edits replace the text,
        // so artwork from the previous variant has to go.
        dropStaleStorybook(mesId);

        if (type === 'swipe') {
            renderMessage(mesId);
            updateStatsUI();
            triggerStorybook(mesId, 'swipe');
            return;
        }

        if (type === 'first_message') {
            renderMessage(mesId);
            updateStatsUI();
            // The greeting is rendered on every chat load. It is only illustrated
            // while the chat is still fresh, otherwise reopening a chat would
            // spend image credits again.
            if (pendingGreeting) {
                pendingGreeting = false;
                triggerStorybook(mesId, 'reply');
            }
            return;
        }

        if (REPLY_RENDER_TYPES.has(type)) {
            renderMessage(mesId);
            updateStatsUI();
            if (REPLY_TRIGGER_TYPES.has(type)) {
                triggerStorybook(mesId, 'reply');
            }
        }
    });

    eventSource.on(eventTypes.CHAT_CREATED, () => {
        pendingGreeting = true;
    });

    // A group chat greets every member and announces itself after the greetings
    // were rendered, so the greetings are picked up here instead.
    eventSource.on(eventTypes.GROUP_CHAT_CREATED, () => {
        const ctxNow = tryGetCtx();
        const chat = ctxNow?.chat ?? [];
        for (let i = 0; i < chat.length; i++) {
            if (!isIllustratable(chat[i])) {
                continue;
            }
            triggerStorybook(i, 'reply');
        }
    });

    eventSource.on(eventTypes.MESSAGE_SWIPED, (mesId) => {
        dropStaleStorybook(mesId);
        renderMessage(mesId);
    });

    eventSource.on(eventTypes.MESSAGE_EDITED, (mesId) => {
        dropStaleStorybook(mesId);
        renderMessage(mesId);
    });

    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        renderAll();
        updateStatsUI();
    });

    eventSource.on(eventTypes.CHAT_LOADED, () => {
        cancelJob(null);
        pendingGreeting = false;
        setTimeout(() => {
            renderAll();
            updateStatsUI();
        }, 60);
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        cancelJob(null);
        pendingGreeting = false;
        setTimeout(() => {
            renderAll();
            updateStatsUI();
        }, 60);
    });

    on(STORY_EVENTS.UPDATE, () => {
        updateStatsUI();
    });

    on(STORY_EVENTS.SETTINGS, () => {
        updateStatusLabels();
        updateStatsUI();
    });
}

export async function init() {
    if (started) {
        return;
    }
    started = true;

    const ctx = tryGetCtx();
    if (!ctx) {
        console.warn('[Storybook] SillyTavern context is not ready yet.');
        started = false;
        return;
    }

    getSettings();
    await loadSettingsHtml();
    bindSettingsControls();
    bindActionButtons();
    registerCommands();
    initView();
    initLightbox();
    initWindow();
    initCarousel();
    registerEvents();
    refreshSettingsUI();
    updateStatusLabels();
    updateStatsUI();

    setTimeout(() => {
        renderAll();
        updateStatsUI();
    }, 400);

    console.log('[Storybook] extension ready.');
}
