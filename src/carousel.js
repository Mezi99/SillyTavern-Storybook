import { STORY_EVENTS, on } from './bus.js';
import { isIllustratable, tryGetCtx } from './context.js';
import { getSettings } from './settings.js';
import { getStorybook, isStorybookStale } from './persistence.js';
import { getJobState } from './pipeline.js';
import { buildStorybookView, mountStorybookView } from './view.js';

/**
 * Renders the legacy inline carousel under a message.
 * The floating window is the primary display; this host is only used while
 * the "show inline" setting is enabled.
 * @param {number} mesId Message index
 */
export function renderMessage(mesId) {
    const ctx = tryGetCtx();
    if (!ctx) {
        return;
    }
    const block = document.querySelector(`.mes[mesid="${mesId}"] .mes_block`);
    if (!block) {
        return;
    }
    const message = ctx.chat?.[mesId];
    if (!isIllustratable(message)) {
        return;
    }
    const text = block.querySelector('.mes_text');
    if (!text) {
        return;
    }
    block.querySelector(':scope > .storybook-root')?.remove();
    if (!getSettings().showInline) {
        return;
    }
    const storybook = getStorybook(message);
    if (!storybook || isStorybookStale(message, storybook)) {
        return;
    }
    const root = buildStorybookView(mesId, storybook, { variant: 'inline' });
    text.insertAdjacentElement('afterend', root);
    mountStorybookView(root, mesId);
}

export function renderAll() {
    const ctx = tryGetCtx();
    if (!ctx) {
        return;
    }
    const nodes = document.querySelectorAll('.mes[mesid]');
    for (const node of nodes) {
        const mesId = Number(node.getAttribute('mesid'));
        if (!Number.isInteger(mesId)) {
            continue;
        }
        const message = ctx.chat?.[mesId];
        if (!isIllustratable(message)) {
            continue;
        }
        renderMessage(mesId);
    }
}

/** Removes book buttons injected by older versions of the extension. */
function removeLegacyButtons() {
    for (const button of document.querySelectorAll('.extraMesButtons .storybook_gen')) {
        button.remove();
    }
}

export function initCarousel() {
    removeLegacyButtons();

    on(STORY_EVENTS.UPDATE, payload => {
        if (typeof payload?.mesId === 'number') {
            renderMessage(payload.mesId);
        } else {
            renderAll();
        }
    });

    on(STORY_EVENTS.JOB, () => {
        removeLegacyButtons();
        const job = getJobState();
        for (const node of document.querySelectorAll('.storybook-root')) {
            const mesId = Number(node.dataset.storybookMes);
            node.classList.toggle('is-running', job.mesId === mesId && job.state !== 'idle');
        }
    });

    on(STORY_EVENTS.SETTINGS, payload => {
        if (payload?.id === 'storybook_show_inline') {
            renderAll();
        }
    });
}
