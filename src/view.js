import { STORY_EVENTS, emit } from './bus.js';
import { getMessage, isIllustratable, tryGetCtx } from './context.js';
import { getStorybook } from './persistence.js';
import { cancelJob, enqueue, getJobState } from './pipeline.js';
import { openLightbox } from './lightbox.js';

/** Last frame shown per message. Both hosts share it so the page survives a mode change. */
export const activeIndex = new Map();

let delegatesBound = false;

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function statusLabel(storybook) {
    switch (storybook?.status) {
        case 'planning': return 'Planning';
        case 'generating': return 'Rendering';
        case 'ready': return 'Ready';
        case 'partial': return 'Partial';
        case 'cancelled': return 'Stopped';
        case 'error': return 'Failed';
        default: return 'Storybook';
    }
}

export function progressLabel(storybook) {
    const frames = Array.isArray(storybook?.keyframes) ? storybook.keyframes : [];
    const ready = frames.filter(frame => frame?.status === 'ready').length;
    if (storybook?.status === 'planning') {
        return 'planning';
    }
    if (!frames.length) {
        return '';
    }
    return `${ready}/${frames.length}`;
}

function frontierIndex(frames) {
    const pending = frames.findIndex(frame => frame?.status === 'pending');
    if (pending >= 0) {
        return pending;
    }
    const ready = frames.findIndex(frame => frame?.status === 'ready');
    if (ready >= 0) {
        return ready;
    }
    return 0;
}

export function resolveActive(mesId, storybook) {
    const frames = Array.isArray(storybook?.keyframes) ? storybook.keyframes : [];
    if (!frames.length) {
        return 0;
    }
    let stored = activeIndex.get(mesId);
    if (stored === undefined) {
        stored = frontierIndex(frames);
    }
    if (storybook.status === 'generating' && stored < frames.length && frames[stored]?.status === 'ready') {
        const next = frames.findIndex(frame => frame?.status === 'pending');
        if (next >= 0) {
            stored = next;
        }
    }
    stored = Math.min(Math.max(0, stored), frames.length - 1);
    activeIndex.set(mesId, stored);
    return stored;
}

function frameMarkup(frame, index, active) {
    const status = frame?.status ?? 'pending';
    const activeClass = index === active ? ' is-active' : '';
    if (status === 'ready' && frame.url) {
        return `
            <figure class="storybook-frame${activeClass}" data-index="${index}" data-status="ready">
                <div class="storybook-frame-media">
                    <img src="${escapeHtml(frame.url)}" alt="${escapeHtml(frame.title)}" loading="lazy">
                    <div class="storybook-frame-loading"><div class="storybook-shimmer"></div></div>
                </div>
            </figure>`;
    }
    if (status === 'error') {
        return `
            <figure class="storybook-frame${activeClass}" data-index="${index}" data-status="error">
                <div class="storybook-frame-media">
                    <div class="storybook-frame-error">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>${escapeHtml(frame.error || 'Frame failed')}</span>
                    </div>
                </div>
            </figure>`;
    }
    return `
        <figure class="storybook-frame${activeClass}" data-index="${index}" data-status="pending">
            <div class="storybook-frame-media">
                <div class="storybook-shimmer"></div>
                <div class="storybook-frame-pending"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
            </div>
        </figure>`;
}

/**
 * Builds the storybook card used by both display hosts.
 * @param {number} mesId Message index
 * @param {object} storybook Storybook payload
 * @param {{ variant?: 'inline'|'window' }} [options]
 * @returns {HTMLElement} Root element
 */
export function buildStorybookView(mesId, storybook, { variant = 'inline' } = {}) {
    const frames = Array.isArray(storybook.keyframes) ? storybook.keyframes : [];
    const active = resolveActive(mesId, storybook);
    const job = getJobState();
    const isRunning = job.mesId === mesId && job.state !== 'idle';
    const hasFrames = frames.length > 0;

    const dots = frames.map((_, index) =>
        `<span class="storybook-dot${index === active ? ' is-active' : ''}" data-index="${index}"></span>`).join('');

    const activeFrame = frames[active];
    const errorMessage = storybook.status === 'error' ? (storybook.error || 'No keyframes were produced.') : '';
    const heading = variant === 'inline'
        ? '<span class="storybook-heading"><i class="fa-solid fa-book-open"></i> Storybook</span>'
        : '';

    const root = document.createElement('div');
    root.className = `storybook-root is-${variant}${isRunning ? ' is-running' : ''}`;
    root.dataset.storybookMes = String(mesId);
    root.dataset.storybookVariant = variant;
    root.dataset.status = storybook.status ?? '';

    root.innerHTML = `
        <div class="storybook-header">
            ${heading}
            <span class="storybook-progress">${escapeHtml(progressLabel(storybook))}</span>
            <span class="storybook-status" data-status="${escapeHtml(storybook.status ?? '')}">${escapeHtml(statusLabel(storybook))}</span>
            <span class="storybook-spacer"></span>
            <div class="storybook-actions">
                ${hasFrames ? '<button class="menu_button storybook-action storybook-expand" title="Open storybook viewer"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>' : ''}
                ${isRunning
                    ? '<button class="menu_button storybook-action storybook-cancel" title="Stop this storybook"><i class="fa-solid fa-stop"></i></button>'
                    : '<button class="menu_button storybook-action storybook-regen" title="Regenerate this storybook"><i class="fa-solid fa-rotate"></i></button>'}
            </div>
        </div>
        ${errorMessage ? `<div class="storybook-error"><i class="fa-solid fa-circle-exclamation"></i> ${escapeHtml(errorMessage)}</div>` : ''}
        ${hasFrames ? `
        <div class="storybook-viewport">
            <button class="storybook-nav storybook-prev" title="Previous frame"><i class="fa-solid fa-chevron-left"></i></button>
            <div class="storybook-track">
                ${frames.map((frame, index) => frameMarkup(frame, index, active)).join('')}
            </div>
            <button class="storybook-nav storybook-next" title="Next frame"><i class="fa-solid fa-chevron-right"></i></button>
        </div>
        <div class="storybook-lower">
            <div class="storybook-dots">${dots}</div>
            <div class="storybook-caption">
                <span class="storybook-caption-title">${escapeHtml(activeFrame?.title ?? '')}</span>
                <span class="storybook-caption-text">${escapeHtml(activeFrame?.caption ?? '')}</span>
            </div>
        </div>` : ''}
    `;
    return root;
}

export function scrollTrackTo(root, index) {
    const track = root.querySelector('.storybook-track');
    const frame = track?.querySelector(`.storybook-frame[data-index="${index}"]`);
    if (!track || !frame) {
        return;
    }
    // Programmatic centering fires scroll events too. The lock keeps the
    // scroll listener from snapping the active frame back to an old position.
    track._storybookScrollLock = Date.now() + 800;
    const left = frame.offsetLeft - (track.clientWidth - frame.clientWidth) / 2;
    track.scrollTo({ left, behavior: 'smooth' });
}

export function applyActive(root, mesId, index, { scroll = true } = {}) {
    const frames = root.querySelectorAll('.storybook-frame');
    if (!frames.length) {
        return;
    }
    const clamped = Math.min(Math.max(0, index), frames.length - 1);
    activeIndex.set(mesId, clamped);
    frames.forEach((frame, position) => frame.classList.toggle('is-active', position === clamped));
    root.querySelectorAll('.storybook-dot').forEach((dot, position) => dot.classList.toggle('is-active', position === clamped));

    const storybook = getStorybook(getMessage(mesId));
    const data = storybook?.keyframes?.[clamped];
    const title = root.querySelector('.storybook-caption-title');
    const text = root.querySelector('.storybook-caption-text');
    if (title) {
        title.textContent = data?.title ?? '';
    }
    if (text) {
        text.textContent = data?.caption ?? '';
    }
    if (scroll) {
        scrollTrackTo(root, clamped);
    }
}

export function bindImages(root) {
    for (const image of root.querySelectorAll('.storybook-frame img')) {
        const frame = image.closest('.storybook-frame');
        const markLoaded = () => frame?.classList.add('is-loaded');
        if (image.complete && image.naturalWidth > 0) {
            markLoaded();
        } else {
            image.addEventListener('load', markLoaded, { once: true });
        }
        image.addEventListener('error', () => frame?.classList.add('is-broken'), { once: true });
    }
}

export function bindTrackScroll(root, mesId) {
    const track = root.querySelector('.storybook-track');
    track?.addEventListener('scroll', () => {
        clearTimeout(track._storybookScrollTimer);
        track._storybookScrollTimer = setTimeout(() => {
            if ((track._storybookScrollLock ?? 0) > Date.now()) {
                return;
            }
            const frames = [...track.querySelectorAll('.storybook-frame')];
            const center = track.scrollLeft + track.clientWidth / 2;
            let closest = 0;
            let distance = Infinity;
            frames.forEach((frame, position) => {
                const frameCenter = frame.offsetLeft + frame.clientWidth / 2;
                const delta = Math.abs(frameCenter - center);
                if (delta < distance) {
                    distance = delta;
                    closest = position;
                }
            });
            applyActive(root, mesId, closest, { scroll: false });
        }, 90);
    });
}

/**
 * Attaches the shared behaviors to a freshly built view and centers the stored page.
 * @param {HTMLElement} root Root returned by buildStorybookView
 * @param {number} mesId Message index
 */
export function mountStorybookView(root, mesId) {
    bindImages(root);
    bindTrackScroll(root, mesId);
    const index = activeIndex.get(mesId) ?? 0;
    requestAnimationFrame(() => scrollTrackTo(root, index));
}

/**
 * Wires the controls that are common to both hosts.
 * The handlers are delegated so re-rendered roots keep working.
 */
export function initView() {
    if (delegatesBound) {
        return;
    }
    delegatesBound = true;

    document.addEventListener('click', event => {
        const root = event.target.closest?.('.storybook-root');
        if (!root) {
            return;
        }
        const mesId = Number(root.dataset.storybookMes);
        if (!Number.isInteger(mesId)) {
            return;
        }
        if (event.target.closest('.storybook-expand')) {
            event.preventDefault();
            openLightbox(mesId, activeIndex.get(mesId) ?? 0);
            return;
        }
        if (event.target.closest('.storybook-regen')) {
            event.preventDefault();
            enqueue(mesId, { force: true, reason: 'manual' });
            emit(STORY_EVENTS.UPDATE, { mesId });
            return;
        }
        if (event.target.closest('.storybook-cancel')) {
            event.preventDefault();
            cancelJob(mesId);
            emit(STORY_EVENTS.UPDATE, { mesId });
            return;
        }
        if (event.target.closest('.storybook-prev')) {
            event.preventDefault();
            applyActive(root, mesId, (activeIndex.get(mesId) ?? 0) - 1);
            return;
        }
        if (event.target.closest('.storybook-next')) {
            event.preventDefault();
            applyActive(root, mesId, (activeIndex.get(mesId) ?? 0) + 1);
            return;
        }
        const dot = event.target.closest('.storybook-dot');
        if (dot) {
            event.preventDefault();
            applyActive(root, mesId, Number(dot.dataset.index));
            return;
        }
        const frame = event.target.closest('.storybook-frame');
        if (frame && frame.dataset.status === 'ready') {
            event.preventDefault();
            openLightbox(mesId, Number(frame.dataset.index));
        }
    });
}
