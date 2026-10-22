import { STORY_EVENTS, on } from './bus.js';
import { getMessage } from './context.js';
import { getStorybook } from './persistence.js';

let lightboxState = null;
let started = false;

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

export function paintLightbox() {
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

export function isLightboxOpen() {
    return Boolean(lightboxState);
}

function moveLightbox(delta) {
    if (!lightboxState) {
        return;
    }
    lightboxState.index += delta;
    paintLightbox();
}

export function initLightbox() {
    if (started) {
        return;
    }
    started = true;

    on(STORY_EVENTS.UPDATE, () => {
        if (lightboxState) {
            paintLightbox();
        }
    });

    document.addEventListener('keydown', event => {
        if (!lightboxState) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeLightbox();
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopImmediatePropagation();
            moveLightbox(-1);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopImmediatePropagation();
            moveLightbox(1);
        }
    });
}
