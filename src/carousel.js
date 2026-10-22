import { STORY_EVENTS, on } from './bus.js';
import { getMessage, isIllustratable, tryGetCtx } from './context.js';
import { getStorybook } from './persistence.js';
import { cancelJob, enqueue, getJobState } from './pipeline.js';

const activeIndex = new Map();
let lightboxState = null;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function statusLabel(storybook) {
    switch (storybook.status) {
        case 'planning': return 'Planning';
        case 'generating': return 'Rendering';
        case 'ready': return 'Ready';
        case 'partial': return 'Partial';
        case 'cancelled': return 'Stopped';
        case 'error': return 'Failed';
        default: return 'Storybook';
    }
}

function progressLabel(storybook) {
    const frames = Array.isArray(storybook.keyframes) ? storybook.keyframes : [];
    const ready = frames.filter(frame => frame?.status === 'ready').length;
    if (storybook.status === 'planning') {
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

function resolveActive(mesId, storybook) {
    const frames = Array.isArray(storybook.keyframes) ? storybook.keyframes : [];
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

function buildRoot(mesId, storybook) {
    const frames = Array.isArray(storybook.keyframes) ? storybook.keyframes : [];
    const active = resolveActive(mesId, storybook);
    const job = getJobState();
    const isRunning = job.mesId === mesId && job.state !== 'idle';
    const hasFrames = frames.length > 0;

    const dots = frames.map((_, index) =>
        `<span class="storybook-dot${index === active ? ' is-active' : ''}" data-index="${index}"></span>`).join('');

    const activeFrame = frames[active];
    const errorMessage = storybook.status === 'error' ? (storybook.error || 'No keyframes were produced.') : '';

    const root = document.createElement('div');
    root.className = `storybook-root${isRunning ? ' is-running' : ''}`;
    root.dataset.storybookMes = String(mesId);
    root.dataset.status = storybook.status ?? '';

    root.innerHTML = `
        <div class="storybook-header">
            <span class="storybook-heading"><i class="fa-solid fa-book-open"></i> Storybook</span>
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

function scrollTrackTo(root, index) {
    const track = root.querySelector('.storybook-track');
    const frame = track?.querySelector(`.storybook-frame[data-index="${index}"]`);
    if (!track || !frame) {
        return;
    }
    const left = frame.offsetLeft - (track.clientWidth - frame.clientWidth) / 2;
    track.scrollTo({ left, behavior: 'smooth' });
}

function applyActive(root, mesId, index, { scroll = true } = {}) {
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

function ensureMessageButton(block, mesId, message) {
    const container = block.querySelector('.extraMesButtons');
    if (!container) {
        return;
    }
    let button = container.querySelector('.storybook_gen');
    if (!button) {
        button = document.createElement('div');
        button.className = 'mes_button storybook_gen fa-solid fa-book-open';
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const target = Number(event.currentTarget.dataset.mesId);
            if (!Number.isInteger(target)) {
                return;
            }
            enqueue(target, { force: true, reason: 'manual' });
            renderMessage(target);
        }, true);
        container.prepend(button);
    }
    button.dataset.mesId = String(mesId);
    const storybook = getStorybook(message);
    const job = getJobState();
    const running = job.mesId === mesId && job.state !== 'idle';
    button.classList.toggle('is-running', running);
    button.title = running
        ? 'Stop storybook generation'
        : storybook
            ? 'Regenerate storybook for this message'
            : 'Generate a storybook for this message';
    if (running) {
        button.classList.remove('fa-book-open');
        button.classList.add('fa-spinner', 'fa-spin-pulse');
    } else {
        button.classList.remove('fa-spinner', 'fa-spin-pulse');
        button.classList.add('fa-book-open');
    }
}

function bindImages(root) {
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
    ensureMessageButton(block, mesId, message);
    const text = block.querySelector('.mes_text');
    if (!text) {
        return;
    }
    block.querySelector(':scope > .storybook-root')?.remove();
    const storybook = getStorybook(message);
    if (!storybook) {
        return;
    }
    const root = buildRoot(mesId, storybook);
    text.insertAdjacentElement('afterend', root);
    bindImages(root);

    const track = root.querySelector('.storybook-track');
    track?.addEventListener('scroll', () => {
        clearTimeout(track._storybookScrollTimer);
        track._storybookScrollTimer = setTimeout(() => {
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

function ensureLightbox() {
    let overlay = document.getElementById('storybook-lightbox');
    if (overlay) {
        return overlay;
    }
    overlay = document.createElement('div');
    overlay.id = 'storybook-lightbox';
    overlay.className = 'storybook-lightbox is-hidden';
    overlay.innerHTML = `
        <div class="storybook-lightbox-backdrop"></div>
        <div class="storybook-lightbox-window">
            <div class="storybook-lightbox-header">
                <span class="storybook-lightbox-title">Storybook</span>
                <button class="menu_button storybook-lightbox-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="storybook-lightbox-body">
                <button class="menu_button storybook-lightbox-nav lightbox-prev" title="Previous"><i class="fa-solid fa-chevron-left"></i></button>
                <div class="storybook-lightbox-stage"><img class="storybook-lightbox-image" alt=""></div>
                <button class="menu_button storybook-lightbox-nav lightbox-next" title="Next"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
            <div class="storybook-lightbox-caption">
                <span class="storybook-lightbox-caption-title"></span>
                <span class="storybook-lightbox-caption-text"></span>
            </div>
            <details class="storybook-lightbox-details">
                <summary>Image prompt</summary>
                <pre class="storybook-lightbox-prompt"></pre>
            </details>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.storybook-lightbox-backdrop')?.addEventListener('click', closeLightbox);
    overlay.querySelector('.storybook-lightbox-close')?.addEventListener('click', closeLightbox);
    overlay.querySelector('.lightbox-prev')?.addEventListener('click', () => moveLightbox(-1));
    overlay.querySelector('.lightbox-next')?.addEventListener('click', () => moveLightbox(1));

    const header = overlay.querySelector('.storybook-lightbox-header');
    const windowEl = overlay.querySelector('.storybook-lightbox-window');
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    header?.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) {
            return;
        }
        const rect = windowEl.getBoundingClientRect();
        windowEl.style.transform = 'none';
        windowEl.style.left = `${rect.left}px`;
        windowEl.style.top = `${rect.top}px`;
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        originX = rect.left;
        originY = rect.top;
        header.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    header?.addEventListener('pointermove', event => {
        if (!dragging) {
            return;
        }
        windowEl.style.left = `${originX + event.clientX - startX}px`;
        windowEl.style.top = `${originY + event.clientY - startY}px`;
    });
    header?.addEventListener('pointerup', () => {
        dragging = false;
    });

    return overlay;
}

function paintLightbox() {
    if (!lightboxState) {
        return;
    }
    const overlay = ensureLightbox();
    const storybook = getStorybook(getMessage(lightboxState.mesId));
    const frames = storybook?.keyframes ?? [];
    if (!frames.length) {
        closeLightbox();
        return;
    }
    lightboxState.index = Math.min(Math.max(0, lightboxState.index), frames.length - 1);
    const frame = frames[lightboxState.index];

    const image = overlay.querySelector('.storybook-lightbox-image');
    if (image) {
        image.src = frame.url || '';
        image.style.display = frame.url ? '' : 'none';
    }
    const title = overlay.querySelector('.storybook-lightbox-title');
    if (title) {
        title.textContent = `Storybook · ${lightboxState.index + 1}/${frames.length}${frame.title ? ` · ${frame.title}` : ''}`;
    }
    const captionTitle = overlay.querySelector('.storybook-lightbox-caption-title');
    const captionText = overlay.querySelector('.storybook-lightbox-caption-text');
    if (captionTitle) {
        captionTitle.textContent = frame.title ?? '';
    }
    if (captionText) {
        captionText.textContent = frame.caption ?? '';
    }
    const prompt = overlay.querySelector('.storybook-lightbox-prompt');
    if (prompt) {
        prompt.textContent = frame.prompt ?? '';
    }
}

export function openLightbox(mesId, index = 0) {
    const storybook = getStorybook(getMessage(mesId));
    if (!storybook?.keyframes?.length) {
        return;
    }
    lightboxState = { mesId, index };
    const overlay = ensureLightbox();
    overlay.classList.remove('is-hidden');
    const windowEl = overlay.querySelector('.storybook-lightbox-window');
    if (windowEl) {
        windowEl.style.left = '';
        windowEl.style.top = '';
        windowEl.style.transform = '';
    }
    paintLightbox();
}

export function closeLightbox() {
    lightboxState = null;
    document.getElementById('storybook-lightbox')?.classList.add('is-hidden');
}

function moveLightbox(delta) {
    if (!lightboxState) {
        return;
    }
    lightboxState.index += delta;
    paintLightbox();
}

function bindDelegates() {
    document.addEventListener('click', event => {
        const root = event.target.closest?.('.storybook-root');
        if (root) {
            const mesId = Number(root.dataset.storybookMes);
            if (event.target.closest('.storybook-expand')) {
                event.preventDefault();
                openLightbox(mesId, activeIndex.get(mesId) ?? 0);
                return;
            }
            if (event.target.closest('.storybook-regen')) {
                event.preventDefault();
                enqueue(mesId, { force: true, reason: 'manual' });
                renderMessage(mesId);
                return;
            }
            if (event.target.closest('.storybook-cancel')) {
                event.preventDefault();
                cancelJob(mesId);
                renderMessage(mesId);
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
        }
    });

    document.addEventListener('keydown', event => {
        if (!lightboxState) {
            return;
        }
        if (event.key === 'Escape') {
            closeLightbox();
        } else if (event.key === 'ArrowLeft') {
            moveLightbox(-1);
        } else if (event.key === 'ArrowRight') {
            moveLightbox(1);
        }
    });
}

export function initCarousel() {
    bindDelegates();

    on(STORY_EVENTS.UPDATE, payload => {
        if (typeof payload?.mesId === 'number') {
            renderMessage(payload.mesId);
        } else {
            renderAll();
        }
        if (lightboxState) {
            paintLightbox();
        }
    });

    on(STORY_EVENTS.JOB, () => {
        const job = getJobState();
        for (const node of document.querySelectorAll('.storybook-root')) {
            const mesId = Number(node.dataset.storybookMes);
            node.classList.toggle('is-running', job.mesId === mesId && job.state !== 'idle');
        }
        for (const node of document.querySelectorAll('.mes[mesid] .mes_block')) {
            const mesId = Number(node.closest('.mes')?.getAttribute('mesid'));
            const message = tryGetCtx()?.chat?.[mesId];
            if (isIllustratable(message)) {
                ensureMessageButton(node, mesId, message);
            }
        }
    });

    on(STORY_EVENTS.OPEN, payload => {
        if (payload?.mesId !== null && payload?.mesId !== undefined) {
            openLightbox(payload.mesId, payload.index ?? 0);
        }
    });
}
