import { getCtx, getMessage, hashString } from './context.js';

let saveTimer = 0;

export function getStorybook(message) {
    return message?.extra?.storybook ?? null;
}

export function ensureExtra(message) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    return message.extra;
}

export function setStorybook(message, value) {
    ensureExtra(message).storybook = value;
    mirrorToSwipe(message, value);
    return value;
}

/**
 * Re-links the message level storybook with the active swipe slot.
 * SillyTavern clones `message.extra` into `swipe_info` and restores a clone of it on swipe,
 * so the reference has to be restored after every change to keep both copies in sync.
 * @param {object} message Chat message
 * @param {object} value Storybook payload
 */
export function syncStorybook(message, value = message?.extra?.storybook) {
    ensureExtra(message).storybook = value;
    mirrorToSwipe(message, value);
    return value;
}

/**
 * Keeps the current swipe slot in sync with the message level storybook.
 * SillyTavern replaces `message.extra` with a clone of the active swipe entry when the user swipes,
 * so the storybook has to live in both places or it disappears on the next swipe.
 * @param {object} message Chat message
 * @param {object} value Storybook payload
 */
export function mirrorToSwipe(message, value = message?.extra?.storybook) {
    if (!message || typeof message !== 'object') {
        return;
    }
    const swipeId = message.swipe_id;
    if (typeof swipeId !== 'number' || !Array.isArray(message.swipe_info) || !Array.isArray(message.swipes)) {
        return;
    }
    const entry = message.swipe_info[swipeId];
    if (!entry || typeof entry !== 'object') {
        return;
    }
    if (typeof message.swipes[swipeId] !== 'string') {
        return;
    }
    if (!entry.extra || typeof entry.extra !== 'object') {
        entry.extra = {};
    }
    entry.extra.storybook = value;
}

export function sourceHashFor({ text, count, styleProfile, styleText, anchor, plannerPrompt, size }) {
    return hashString([
        text,
        count,
        styleProfile ?? '',
        styleText ?? '',
        anchor ?? '',
        plannerPrompt ?? '',
        size ?? '',
        'v2',
    ].join('\u0001'));
}

export function textHashFor(text) {
    return hashString(String(text ?? ''));
}

export function saveSoon(delay = 600) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = 0;
        saveNow().catch(err => console.warn('[Storybook] autosave failed', err));
    }, delay);
}

export async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
        await getCtx().saveChat();
    } catch (err) {
        console.warn('[Storybook] save failed', err);
    }
}

export function storybookForMessage(mesId) {
    return getStorybook(getMessage(mesId));
}

export function isStorybookUsable(storybook) {
    if (!storybook || !Array.isArray(storybook.keyframes)) {
        return false;
    }
    return storybook.keyframes.some(frame => frame?.status === 'ready' && frame?.url);
}

/**
 * Re-links the storybook of a message with its swipe slot without changing the content.
 * SillyTavern clones `extra` in both directions while swiping, so the reference breaks
 * every time the user moves between variants.
 * @param {object} message Chat message
 * @returns {object|null} The storybook that is now linked on both sides
 */
export function relinkStorybook(message) {
    const storybook = getStorybook(message);
    if (!storybook) {
        return null;
    }
    mirrorToSwipe(message, storybook);
    return storybook;
}

/**
 * Removes the storybook from a message and from its active swipe slot.
 * @param {object} message Chat message
 * @returns {boolean} True when a storybook was removed
 */
export function clearStorybook(message) {
    if (!message) {
        return false;
    }
    let removed = false;
    if (message.extra && Object.prototype.hasOwnProperty.call(message.extra, 'storybook')) {
        delete message.extra.storybook;
        removed = true;
    }
    const swipeId = message.swipe_id;
    const entry = Array.isArray(message.swipe_info) ? message.swipe_info[swipeId] : null;
    if (entry?.extra && Object.prototype.hasOwnProperty.call(entry.extra, 'storybook')) {
        delete entry.extra.storybook;
        removed = true;
    }
    return removed;
}

/**
 * Checks whether a storybook was made for the text the message currently holds.
 * Swiping clones the previous variant's extra, so the artwork can belong to another reply.
 * @param {object} message Chat message
 * @param {object} storybook Storybook payload
 * @returns {boolean} True when the storybook no longer matches the message text
 */
export function isStorybookStale(message, storybook) {
    if (!storybook?.textHash) {
        return false;
    }
    return storybook.textHash !== textHashFor(String(message?.mes ?? ''));
}
