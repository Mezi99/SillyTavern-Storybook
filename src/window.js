import { STORY_EVENTS, emit, on } from './bus.js';
import { getMessage, getMessageText, isIllustratable, tryGetCtx } from './context.js';
import { clearStorybook, getStorybook, isStorybookStale, saveNow } from './persistence.js';
import { cancelJob, enqueue, getJobState, isBusy } from './pipeline.js';
import { buildStorybookView, mountStorybookView, progressLabel, statusLabel } from './view.js';
import { isLightboxOpen } from './lightbox.js';
import { getSettings } from './settings.js';
import { planKeyframes } from './planner.js';
import { buildImageRequest } from './backends/image.js';
import { clearDebugTrace, getDebugTrace } from './debug.js';

const WINDOW_ID = 'storybook-window';
const FAB_ID = 'storybook-fab';
const LAYOUT_KEY = 'storybook_window_layout';
const SELECTION_KEY = 'storybook_window_selection';
const MOBILE_QUERY = '(max-width: 700px)';
const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 560;
const MIN_WIDTH = 340;
const MIN_HEIGHT = 300;

const DEFAULT_LAYOUT = {
    left: null,
    top: null,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    collapsed: false,
};

let started = false;
let opened = true;
let selectedMesId = null;
let selectedId = null;
let lastChatKey = null;
let layout = { ...DEFAULT_LAYOUT };
let debugOpen = false;
let debugTab = 'request';
let debugBusy = false;

function isMobileViewport() {
    return Boolean(window.matchMedia?.(MOBILE_QUERY).matches);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function toast(kind, message) {
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') {
        fn.call(window.toastr, message, 'Storybook');
    }
}

function hasChat() {
    const ctx = tryGetCtx();
    return Boolean(ctx && Array.isArray(ctx.chat) && ctx.chat.length > 0);
}

function chatKey() {
    const ctx = tryGetCtx();
    try {
        const id = ctx?.getCurrentChatId?.();
        if (id) {
            return String(id);
        }
    } catch { /* not ready */ }
    const first = ctx?.chat?.[0];
    return `unsaved:${first?.send_date ?? first?.create_date ?? 'current'}`;
}

function debugChatId() {
    const ctx = tryGetCtx();
    try {
        return String(ctx?.getCurrentChatId?.() ?? 'unsaved');
    } catch {
        return 'unsaved';
    }
}

function readSelectionMap() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeSelection(mesId) {
    try {
        const map = readSelectionMap();
        const key = chatKey();
        const storybook = getStorybook(getMessage(mesId));
        if (storybook?.id) {
            map[key] = storybook.id;
        } else {
            delete map[key];
        }
        localStorage.setItem(SELECTION_KEY, JSON.stringify(map));
    } catch { /* storage unavailable */ }
}

function loadLayout() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object') {
            return { ...DEFAULT_LAYOUT };
        }
        const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
        return {
            left: parsed.left === null || parsed.left === undefined ? null : number(parsed.left, null),
            top: parsed.top === null || parsed.top === undefined ? null : number(parsed.top, null),
            width: number(parsed.width, DEFAULT_WIDTH),
            height: number(parsed.height, DEFAULT_HEIGHT),
            collapsed: Boolean(parsed.collapsed),
        };
    } catch {
        return { ...DEFAULT_LAYOUT };
    }
}

function saveLayout() {
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch { /* storage unavailable */ }
}

function applyLayout() {
    const windowEl = document.getElementById(WINDOW_ID);
    if (!windowEl) {
        return;
    }
    windowEl.classList.toggle('is-collapsed', Boolean(layout.collapsed));
    const collapse = windowEl.querySelector('.storybook-window-collapse');
    if (collapse) {
        collapse.title = layout.collapsed ? 'Expand' : 'Collapse';
        const icon = collapse.querySelector('i');
        icon?.classList.toggle('fa-chevron-down', !layout.collapsed);
        icon?.classList.toggle('fa-chevron-up', Boolean(layout.collapsed));
    }
    if (isMobileViewport()) {
        windowEl.style.removeProperty('left');
        windowEl.style.removeProperty('top');
        windowEl.style.removeProperty('width');
        windowEl.style.removeProperty('height');
        return;
    }
    const width = clamp(layout.width || DEFAULT_WIDTH, MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 16));
    const height = clamp(layout.height || DEFAULT_HEIGHT, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 16));
    const left = layout.left === null
        ? Math.max(8, window.innerWidth - width - 24)
        : clamp(layout.left, 0, Math.max(0, window.innerWidth - 80));
    const top = layout.top === null
        ? Math.max(72, Math.round(window.innerHeight * 0.1))
        : clamp(layout.top, 0, Math.max(0, window.innerHeight - 56));
    windowEl.style.width = `${width}px`;
    windowEl.style.height = `${height}px`;
    windowEl.style.left = `${left}px`;
    windowEl.style.top = `${top}px`;
}

function illustratableIds() {
    const chat = tryGetCtx()?.chat ?? [];
    const ids = [];
    for (let i = 0; i < chat.length; i++) {
        if (isIllustratable(chat[i])) {
            ids.push(i);
        }
    }
    return ids;
}

function isUsableStorybook(message) {
    const storybook = getStorybook(message);
    if (!storybook) {
        return false;
    }
    return !isStorybookStale(message, storybook);
}

function findStorybookIndexById(chat, id) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!isIllustratable(chat[i])) {
            continue;
        }
        const storybook = getStorybook(chat[i]);
        if (storybook?.id === id && !isStorybookStale(chat[i], storybook)) {
            return i;
        }
    }
    return -1;
}

function latestStorybookIndex(chat) {
    let best = -1;
    let bestTime = -Infinity;
    for (let i = 0; i < chat.length; i++) {
        if (!isIllustratable(chat[i])) {
            continue;
        }
        const storybook = getStorybook(chat[i]);
        if (!storybook || isStorybookStale(chat[i], storybook)) {
            continue;
        }
        const time = Number(storybook.updatedAt) || 0;
        if (time >= bestTime) {
            bestTime = time;
            best = i;
        }
    }
    return best;
}

function selectInitial() {
    const chat = tryGetCtx()?.chat ?? [];
    const ids = illustratableIds();
    if (!ids.length) {
        selectedMesId = null;
        selectedId = null;
        return;
    }
    const stored = readSelectionMap()[chatKey()];
    let index = stored ? findStorybookIndexById(chat, stored) : -1;
    if (index < 0) {
        index = latestStorybookIndex(chat);
    }
    if (index < 0) {
        index = ids[ids.length - 1];
    }
    selectedMesId = index;
    selectedId = getStorybook(chat[index])?.id ?? null;
    writeSelection(index);
}

function setSelection(mesId, { persist = true, renderNow = true } = {}) {
    const message = getMessage(mesId);
    if (!isIllustratable(message)) {
        return false;
    }
    selectedMesId = mesId;
    selectedId = getStorybook(message)?.id ?? null;
    if (persist) {
        writeSelection(mesId);
    }
    if (renderNow) {
        render();
    }
    return true;
}

function excerptFor(message) {
    const raw = getMessageText(message)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) {
        return 'This reply has no text to illustrate.';
    }
    return raw.length > 220 ? `${raw.slice(0, 220).trimEnd()}…` : raw;
}

function buildEmptyState(message) {
    const wrap = document.createElement('div');
    wrap.className = 'storybook-window-empty';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-book-open storybook-window-empty-icon';
    wrap.appendChild(icon);

    const title = document.createElement('p');
    title.className = 'storybook-window-empty-title';
    title.textContent = 'No storybook for this reply yet';
    wrap.appendChild(title);

    const excerpt = document.createElement('blockquote');
    excerpt.className = 'storybook-window-empty-excerpt';
    excerpt.textContent = excerptFor(message);
    wrap.appendChild(excerpt);

    const generate = document.createElement('button');
    generate.className = 'menu_button storybook-window-generate';
    generate.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Illustrate this reply';
    generate.addEventListener('click', () => {
        generateSelected();
    });
    wrap.appendChild(generate);

    return wrap;
}

function requestDebugText(trace) {
    if (!trace?.request) {
        return 'No planner request recorded for this reply yet.\n\nUse "Test planner" to run one without generating images.';
    }
    const meta = trace.request.meta ?? {};
    const lines = [
        `Backend: ${meta.backend ?? 'st'}`,
        `API: ${meta.api ?? ''}`,
        meta.model ? `Model: ${meta.model}` : '',
        `Keyframes: ${meta.count ?? ''}`,
        `Response length: ${meta.responseLength ?? ''}`,
        `Structured JSON: ${meta.useSchema ? 'yes' : 'no'}`,
        '',
        'SYSTEM PROMPT',
        trace.request.systemPrompt,
        '',
        'USER PROMPT',
        trace.request.userPrompt,
    ];
    return lines.filter(line => line !== '').join('\n');
}

function responseDebugText(trace) {
    if (!trace) {
        return 'No planner response recorded for this reply yet.';
    }
    const lines = [];
    if (trace.attempts.length) {
        trace.attempts.forEach((attempt, index) => {
            lines.push(`ATTEMPT ${index + 1} · ${attempt.kind} · parsed=${attempt.parsed ? 'yes' : 'no'}`);
            if (attempt.error) {
                lines.push(`ERROR: ${attempt.error}`);
            }
            lines.push(attempt.raw || '(empty response)', '');
        });
    } else {
        lines.push('No planner response recorded.', '');
    }
    if (trace.errors.length) {
        lines.push('ERRORS');
        for (const error of trace.errors) {
            lines.push(error.message);
        }
        lines.push('');
    }
    if (trace.plan) {
        lines.push('SHAPED PLAN');
        lines.push(JSON.stringify({
            anchor: trace.plan.anchor,
            keyframes: trace.plan.frames.map(frame => ({
                index: frame.i + 1,
                title: frame.title,
                caption: frame.caption,
                imagePrompt: frame.imagePrompt,
                compiledPrompt: frame.prompt,
            })),
        }, null, 2));
    }
    return lines.join('\n').trim();
}

function imagePromptDebugText(trace) {
    const frames = trace?.plan?.frames ?? [];
    if (!frames.length) {
        return 'No compiled image prompts recorded for this reply yet.';
    }
    const imageRequests = new Map((trace.images ?? []).map(image => [image.frameIndex, image]));
    const lines = [];
    frames.forEach((frame, index) => {
        const detail = trace.plan.promptDetails?.[index] ?? null;
        const request = imageRequests.get(index) ?? buildImageRequest({ prompt: frame.prompt });
        lines.push(`FRAME ${index + 1}${frame.title ? ` · ${frame.title}` : ''}`);
        lines.push(`RAW SCENE\n${frame.imagePrompt || '(none)'}`);
        lines.push(`FINAL PROMPT (${request.prompt.length} chars)\n${request.prompt}`);
        lines.push(`NEGATIVE (${request.negative.length} chars)\n${request.negative || '(none)'}`);
        lines.push(`SIZE\n${request.width && request.height ? `${request.width} x ${request.height}` : 'SillyTavern default'}`);
        if (detail) {
            const truncated = Object.entries(detail.truncated ?? {})
                .filter(([, value]) => value)
                .map(([key]) => key);
            if (truncated.length) {
                lines.push(`TRUNCATED\n${truncated.join(', ')}`);
            }
            if (detail.dropped?.scene?.length) {
                lines.push(`DROPPED STYLE/NEGATIVE ECHOES\n${detail.dropped.scene.join('\n')}`);
            }
        }
        lines.push('');
    });
    return lines.join('\n').trim();
}

function debugTextFor(trace) {
    if (debugTab === 'response') {
        return responseDebugText(trace);
    }
    if (debugTab === 'image') {
        return imagePromptDebugText(trace);
    }
    return requestDebugText(trace);
}

function currentDebugTrace() {
    if (!Number.isInteger(selectedMesId)) {
        return null;
    }
    return getDebugTrace(debugChatId(), selectedMesId);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast('success', 'Debug text copied.');
        return;
    } catch { /* fall through to the legacy path */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
        document.execCommand('copy');
        toast('success', 'Debug text copied.');
    } catch {
        toast('error', 'Could not copy the debug text.');
    }
    area.remove();
}

function renderDebug() {
    const panel = document.getElementById('storybook-debug');
    if (!panel) {
        return;
    }
    const enabled = Boolean(getSettings().showDebugTools);
    if (!enabled) {
        debugOpen = false;
    }
    const visible = enabled && debugOpen;
    panel.classList.toggle('is-hidden', !visible);
    if (!visible) {
        panel.innerHTML = '';
        return;
    }

    const trace = currentDebugTrace();
    panel.innerHTML = `
        <div class="storybook-debug-header">
            <span class="storybook-debug-title"><i class="fa-solid fa-bug"></i> Debug</span>
            <span class="storybook-debug-meta"></span>
            <span class="storybook-spacer"></span>
            <button class="storybook-debug-action" data-debug-action="copy" title="Copy this section">Copy</button>
            <button class="storybook-debug-action" data-debug-action="test" title="Run the planner for this reply">Test planner</button>
            <button class="storybook-debug-action" data-debug-action="clear" title="Clear debug data for this reply">Clear</button>
            <button class="storybook-debug-action" data-debug-action="close" title="Close debug"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="storybook-debug-tabs">
            <button class="storybook-debug-tab" data-debug-tab="request">Planner request</button>
            <button class="storybook-debug-tab" data-debug-tab="response">Planner response</button>
            <button class="storybook-debug-tab" data-debug-tab="image">Image prompts</button>
        </div>
        <pre class="storybook-debug-output"></pre>`;

    const meta = panel.querySelector('.storybook-debug-meta');
    if (meta) {
        const reply = Number.isInteger(selectedMesId) ? `reply ${selectedMesId + 1}` : 'no reply';
        const frameCount = trace?.plan?.frames?.length ?? 0;
        meta.textContent = `${reply}${frameCount ? ` · ${frameCount} frame${frameCount === 1 ? '' : 's'}` : ''}`;
    }
    panel.querySelectorAll('.storybook-debug-tab').forEach(tab => {
        tab.classList.toggle('is-active', tab.dataset.debugTab === debugTab);
    });
    const test = panel.querySelector('[data-debug-action="test"]');
    if (test) {
        test.disabled = debugBusy || !Number.isInteger(selectedMesId);
        test.textContent = debugBusy ? 'Planning...' : 'Test planner';
    }
    const output = panel.querySelector('.storybook-debug-output');
    if (output) {
        output.textContent = debugTextFor(trace);
    }
}

function renderToolbar(storybook) {
    const generate = document.querySelector('.storybook-window-generate');
    const stop = document.querySelector('.storybook-window-stop');
    const remove = document.querySelector('.storybook-window-remove');
    const debug = document.querySelector('.storybook-window-debug');
    if (!generate || !stop || !remove || !debug) {
        return;
    }
    const hasSelection = Number.isInteger(selectedMesId) && isIllustratable(getMessage(selectedMesId));
    const busy = hasSelection && isBusy(selectedMesId);
    generate.disabled = !hasSelection || busy;
    generate.querySelector('span').textContent = storybook ? 'Regenerate' : 'Illustrate';
    generate.title = storybook ? 'Regenerate this reply' : 'Illustrate this reply';
    stop.disabled = !busy;
    remove.disabled = !storybook || busy;
    const showDebug = Boolean(getSettings().showDebugTools);
    if (!showDebug) {
        debugOpen = false;
    }
    debug.classList.toggle('is-hidden', !showDebug);
    debug.classList.toggle('is-active', debugOpen);
}

function stopSelected() {
    if (!Number.isInteger(selectedMesId)) {
        return;
    }
    cancelJob(selectedMesId);
    render();
}

function toggleDebug() {
    if (!getSettings().showDebugTools) {
        return;
    }
    debugOpen = !debugOpen;
    const message = Number.isInteger(selectedMesId) ? getMessage(selectedMesId) : null;
    const storybook = message && isUsableStorybook(message) ? getStorybook(message) : null;
    renderDebug();
    renderToolbar(storybook);
}

async function runDebugPlanner() {
    if (debugBusy || !Number.isInteger(selectedMesId)) {
        return;
    }
    debugBusy = true;
    debugTab = 'response';
    renderDebug();
    toast('info', 'Planning a storybook...');
    try {
        const plan = await planKeyframes({ mesId: selectedMesId, count: getSettings().keyframes });
        toast('success', `Planner returned ${plan.keyframes.length} keyframes.`);
    } catch (err) {
        toast('error', String(err?.message ?? err));
    } finally {
        debugBusy = false;
        renderDebug();
    }
}

function render() {
    const windowEl = document.getElementById(WINDOW_ID);
    if (!windowEl) {
        return;
    }
    const ctx = tryGetCtx();
    const chat = ctx?.chat ?? [];
    if (!chat.length) {
        return;
    }
    if (!Number.isInteger(selectedMesId) || !isIllustratable(chat[selectedMesId])) {
        selectInitial();
    }
    const message = chat[selectedMesId];
    const ids = illustratableIds();
    const position = ids.indexOf(selectedMesId);
    const storybook = isUsableStorybook(message) ? getStorybook(message) : null;
    selectedId = storybook?.id ?? null;

    const subtitle = windowEl.querySelector('.storybook-window-subtitle');
    if (subtitle) {
        const name = message?.name || ctx?.name2 || 'Reply';
        subtitle.textContent = `${name} · reply ${position + 1} of ${ids.length}`;
    }
    const progress = windowEl.querySelector('.storybook-window-progress');
    if (progress) {
        progress.textContent = storybook
            ? [statusLabel(storybook), progressLabel(storybook)].filter(Boolean).join(' · ')
            : '';
    }

    const prev = windowEl.querySelector('.storybook-window-prev');
    const next = windowEl.querySelector('.storybook-window-next');
    if (prev) {
        prev.disabled = position <= 0;
    }
    if (next) {
        next.disabled = position < 0 || position >= ids.length - 1;
    }

    const jumpLabel = windowEl.querySelector('.storybook-window-jump span');
    if (jumpLabel) {
        jumpLabel.textContent = `Reply ${selectedMesId + 1}`;
    }

    const body = windowEl.querySelector('.storybook-window-body');
    if (!body) {
        return;
    }
    body.innerHTML = '';
    if (storybook) {
        const view = buildStorybookView(selectedMesId, storybook, { variant: 'window' });
        body.appendChild(view);
        mountStorybookView(view, selectedMesId);
    } else {
        body.appendChild(buildEmptyState(message));
    }

    const job = getJobState();
    renderToolbar(storybook);
    renderDebug();
    windowEl.classList.toggle('is-running', job.mesId === selectedMesId && job.state !== 'idle');
    syncVisibility();
}

function syncVisibility() {
    const windowEl = document.getElementById(WINDOW_ID);
    const fab = document.getElementById(FAB_ID);
    const available = hasChat();
    if (fab) {
        fab.classList.toggle('is-hidden', !available);
        fab.classList.toggle('is-active', available && opened);
        fab.title = opened ? 'Hide the storybook window' : 'Show the storybook window';
    }
    if (!windowEl) {
        return;
    }
    if (!available) {
        windowEl.classList.add('is-hidden');
        return;
    }
    windowEl.classList.toggle('is-hidden', !opened);
}

function generateSelected() {
    if (!Number.isInteger(selectedMesId)) {
        return;
    }
    const existing = getStorybook(getMessage(selectedMesId));
    enqueue(selectedMesId, { force: Boolean(existing), reason: 'manual' });
    render();
}

function clearSelected() {
    if (!Number.isInteger(selectedMesId)) {
        return;
    }
    const message = getMessage(selectedMesId);
    if (!getStorybook(message)) {
        return;
    }
    clearStorybook(message);
    void saveNow();
    emit(STORY_EVENTS.UPDATE, { mesId: selectedMesId });
    render();
    toast('info', 'Storybook removed from that reply.');
}

function jumpToSelected() {
    const node = document.querySelector(`.mes[mesid="${selectedMesId}"]`);
    if (!node) {
        return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('storybook-highlight');
    setTimeout(() => node.classList.remove('storybook-highlight'), 1600);
}

function stepSelection(delta) {
    const ids = illustratableIds();
    const position = ids.indexOf(selectedMesId);
    if (position < 0) {
        selectInitial();
        render();
        return;
    }
    const target = ids[position + delta];
    if (target === undefined) {
        return;
    }
    setSelection(target);
}

export function openWindow(mesId = null) {
    opened = true;
    document.getElementById(FAB_ID)?.classList.remove('has-update');
    if (Number.isInteger(mesId)) {
        setSelection(mesId, { renderNow: false });
    } else if (selectedMesId === null) {
        selectInitial();
    }
    syncVisibility();
    render();
}

export function closeWindow() {
    opened = false;
    syncVisibility();
}

export function toggleWindow() {
    if (opened) {
        closeWindow();
    } else {
        openWindow();
    }
}

export function resetWindowLayout() {
    layout = { ...DEFAULT_LAYOUT };
    saveLayout();
    applyLayout();
}

function onChatEntered() {
    const key = chatKey();
    const changed = key !== lastChatKey;
    lastChatKey = key;
    if (!hasChat()) {
        selectedMesId = null;
        selectedId = null;
        syncVisibility();
        return;
    }
    if (changed || selectedMesId === null || !isIllustratable(getMessage(selectedMesId))) {
        selectInitial();
    } else if (selectedId) {
        const index = findStorybookIndexById(tryGetCtx().chat ?? [], selectedId);
        if (index >= 0) {
            selectedMesId = index;
        } else {
            selectInitial();
        }
    }
    if (opened) {
        syncVisibility();
        render();
    }
}

function onMessageDeleted() {
    if (!hasChat()) {
        return;
    }
    if (selectedId) {
        const index = findStorybookIndexById(tryGetCtx().chat ?? [], selectedId);
        if (index >= 0) {
            selectedMesId = index;
        } else {
            selectInitial();
        }
        render();
        return;
    }
    if (Number.isInteger(selectedMesId) && isIllustratable(getMessage(selectedMesId))) {
        render();
        return;
    }
    selectInitial();
    render();
}

function ensureDom() {
    if (document.getElementById(WINDOW_ID)) {
        return;
    }

    const windowEl = document.createElement('div');
    windowEl.id = WINDOW_ID;
    windowEl.className = 'storybook-window is-hidden';
    windowEl.setAttribute('role', 'dialog');
    windowEl.setAttribute('aria-label', 'Storybook');
    windowEl.innerHTML = `
        <div class="storybook-window-header">
            <span class="storybook-window-grip"><i class="fa-solid fa-grip-lines"></i></span>
            <div class="storybook-window-titles">
                <span class="storybook-window-title"><i class="fa-solid fa-book-open"></i> Storybook</span>
                <span class="storybook-window-subtitle"></span>
            </div>
            <span class="storybook-window-progress"></span>
            <button class="storybook-window-action storybook-window-prev" title="Previous reply"><i class="fa-solid fa-chevron-left"></i></button>
            <button class="storybook-window-action storybook-window-next" title="Next reply"><i class="fa-solid fa-chevron-right"></i></button>
            <button class="storybook-window-action storybook-window-collapse" title="Collapse"><i class="fa-solid fa-chevron-down"></i></button>
            <button class="storybook-window-action storybook-window-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="storybook-window-toolbar">
            <button class="storybook-window-tool storybook-window-generate" title="Illustrate this reply">
                <i class="fa-solid fa-wand-magic-sparkles"></i><span>Illustrate</span>
            </button>
            <button class="storybook-window-tool storybook-window-stop" title="Stop this job" disabled>
                <i class="fa-solid fa-stop"></i><span>Stop</span>
            </button>
            <button class="storybook-window-tool storybook-window-remove" title="Remove this storybook" disabled>
                <i class="fa-solid fa-eraser"></i><span>Remove</span>
            </button>
            <span class="storybook-spacer"></span>
            <button class="storybook-window-tool storybook-window-debug is-hidden" title="Open debug tools">
                <i class="fa-solid fa-bug"></i><span>Debug</span>
            </button>
        </div>
        <div class="storybook-window-debug is-hidden" id="storybook-debug"></div>
        <div class="storybook-window-body"></div>
        <div class="storybook-window-footer">
            <button class="storybook-window-link storybook-window-jump" title="Scroll to this message">
                <i class="fa-solid fa-location-dot"></i> <span>Reply</span>
            </button>
            <span class="storybook-spacer"></span>
        </div>
        <div class="storybook-window-resize" title="Resize"></div>`;
    document.body.appendChild(windowEl);

    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.className = 'storybook-fab is-hidden';
    fab.type = 'button';
    fab.title = 'Show the storybook window';
    fab.innerHTML = '<i class="fa-solid fa-book-open"></i><span class="storybook-fab-dot"></span>';
    document.body.appendChild(fab);

    windowEl.querySelector('.storybook-window-close')?.addEventListener('click', closeWindow);
    windowEl.querySelector('.storybook-window-collapse')?.addEventListener('click', () => {
        layout.collapsed = !layout.collapsed;
        saveLayout();
        applyLayout();
    });
    windowEl.querySelector('.storybook-window-prev')?.addEventListener('click', () => stepSelection(-1));
    windowEl.querySelector('.storybook-window-next')?.addEventListener('click', () => stepSelection(1));
    windowEl.querySelector('.storybook-window-jump')?.addEventListener('click', jumpToSelected);
    windowEl.querySelector('.storybook-window-generate')?.addEventListener('click', generateSelected);
    windowEl.querySelector('.storybook-window-stop')?.addEventListener('click', stopSelected);
    windowEl.querySelector('.storybook-window-remove')?.addEventListener('click', clearSelected);
    windowEl.querySelector('.storybook-window-debug')?.addEventListener('click', toggleDebug);
    windowEl.querySelector('#storybook-debug')?.addEventListener('click', event => {
        const tab = event.target.closest?.('[data-debug-tab]');
        if (tab) {
            debugTab = tab.dataset.debugTab;
            renderDebug();
            return;
        }
        const action = event.target.closest?.('[data-debug-action]')?.dataset.debugAction;
        if (action === 'close') {
            debugOpen = false;
            render();
        } else if (action === 'copy') {
            copyText(debugTextFor(currentDebugTrace()));
        } else if (action === 'test') {
            runDebugPlanner();
        } else if (action === 'clear') {
            if (Number.isInteger(selectedMesId)) {
                clearDebugTrace(debugChatId(), selectedMesId);
                toast('info', 'Debug data cleared for this reply.');
            }
            renderDebug();
        }
    });
    fab.addEventListener('click', toggleWindow);

    bindDrag(windowEl, windowEl.querySelector('.storybook-window-header'));
    bindResize(windowEl, windowEl.querySelector('.storybook-window-resize'));
}

function bindDrag(windowEl, header) {
    if (!header) {
        return;
    }
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    header.addEventListener('pointerdown', event => {
        if (isMobileViewport() || event.button !== 0) {
            return;
        }
        if (event.target.closest('button, input, a, select, textarea')) {
            return;
        }
        const rect = windowEl.getBoundingClientRect();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        originX = rect.left;
        originY = rect.top;
        windowEl.style.left = `${rect.left}px`;
        windowEl.style.top = `${rect.top}px`;
        header.classList.add('is-dragging');
        header.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    header.addEventListener('pointermove', event => {
        if (!dragging) {
            return;
        }
        const maxLeft = Math.max(0, window.innerWidth - windowEl.offsetWidth);
        const left = clamp(originX + event.clientX - startX, 0, maxLeft);
        const top = clamp(originY + event.clientY - startY, 0, Math.max(0, window.innerHeight - 48));
        windowEl.style.left = `${left}px`;
        windowEl.style.top = `${top}px`;
    });

    const finish = () => {
        if (!dragging) {
            return;
        }
        dragging = false;
        header.classList.remove('is-dragging');
        const rect = windowEl.getBoundingClientRect();
        layout.left = Math.round(rect.left);
        layout.top = Math.round(rect.top);
        saveLayout();
    };
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
}

function bindResize(windowEl, handle) {
    if (!handle) {
        return;
    }
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    handle.addEventListener('pointerdown', event => {
        if (isMobileViewport() || event.button !== 0) {
            return;
        }
        const rect = windowEl.getBoundingClientRect();
        resizing = true;
        startX = event.clientX;
        startY = event.clientY;
        startWidth = rect.width;
        startHeight = rect.height;
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
        if (!resizing) {
            return;
        }
        const width = clamp(startWidth + event.clientX - startX, MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 16));
        const height = clamp(startHeight + event.clientY - startY, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 16));
        windowEl.style.width = `${width}px`;
        windowEl.style.height = `${height}px`;
    });

    const finish = () => {
        if (!resizing) {
            return;
        }
        resizing = false;
        const rect = windowEl.getBoundingClientRect();
        layout.width = Math.round(rect.width);
        layout.height = Math.round(rect.height);
        layout.left = Math.round(rect.left);
        layout.top = Math.round(rect.top);
        saveLayout();
        applyLayout();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

function bindBus() {
    on(STORY_EVENTS.UPDATE, payload => {
        if (!opened) {
            return;
        }
        const mesId = payload?.mesId;
        if (typeof mesId !== 'number') {
            render();
            return;
        }
        if (selectedMesId === null) {
            setSelection(mesId, { renderNow: false });
        }
        if (selectedMesId === mesId) {
            render();
        }
    });

    on(STORY_EVENTS.JOB, () => {
        if (!opened) {
            return;
        }
        const job = getJobState();
        if (job.state !== 'idle' && Number.isInteger(job.mesId) && job.mesId !== selectedMesId) {
            setSelection(job.mesId, { renderNow: false });
        }
        render();
    });

    on(STORY_EVENTS.COMPLETE, payload => {
        if (opened) {
            if (payload?.mesId === selectedMesId) {
                render();
            }
            return;
        }
        document.getElementById(FAB_ID)?.classList.add('has-update');
    });

    on(STORY_EVENTS.DEBUG, () => {
        if (opened && debugOpen) {
            render();
        }
    });

    on(STORY_EVENTS.SETTINGS, payload => {
        if (!getSettings().showDebugTools) {
            debugOpen = false;
        }
        if (opened && (payload?.id === 'storybook_show_debug_tools' || payload?.id === undefined)) {
            render();
        }
    });
}

function bindStEvents() {
    const ctx = tryGetCtx();
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (!source || !types) {
        return;
    }

    source.on(types.CHARACTER_MESSAGE_RENDERED, mesId => {
        if (!opened) {
            return;
        }
        if (selectedMesId === mesId) {
            render();
        } else if (selectedMesId === null) {
            selectInitial();
            render();
        }
    });
    source.on(types.MESSAGE_SWIPED, mesId => {
        if (opened && mesId === selectedMesId) {
            render();
        }
    });
    source.on(types.MESSAGE_EDITED, mesId => {
        if (opened && mesId === selectedMesId) {
            render();
        }
    });
    source.on(types.MESSAGE_DELETED, () => {
        if (opened) {
            onMessageDeleted();
        }
    });
    source.on(types.CHAT_LOADED, () => onChatEntered());
    source.on(types.CHAT_CHANGED, () => onChatEntered());

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !opened || isLightboxOpen()) {
            return;
        }
        closeWindow();
    });
}

function tick() {
    if (!hasChat()) {
        syncVisibility();
        return;
    }
    if (chatKey() !== lastChatKey || selectedMesId === null) {
        onChatEntered();
        return;
    }
    syncVisibility();
    if (opened && document.getElementById(WINDOW_ID)?.classList.contains('is-hidden')) {
        render();
    }
}

export function initWindow() {
    if (started) {
        return;
    }
    started = true;
    layout = loadLayout();
    ensureDom();
    applyLayout();
    bindBus();
    bindStEvents();
    syncVisibility();

    window.addEventListener('resize', () => {
        if (!isMobileViewport()) {
            applyLayout();
        }
    });

    // SillyTavern may load the active chat before the extension is activated,
    // in which case no chat event reaches us. The tick catches that state.
    setTimeout(tick, 350);
    setInterval(tick, 1200);
}
