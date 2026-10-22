import { DEFAULT_PLANNER_PROMPT, defaultSettings, SETTINGS_KEY, TRIGGERS } from './defaults.js';
import { STORY_EVENTS, emit } from './bus.js';
import { BASE_URL, getCtx, getExtensionSettingsObject } from './context.js';

export const sessionStats = { images: 0, plannerCalls: 0, jobs: 0 };

function mergeMissing(target, source) {
    for (const [key, value] of Object.entries(source)) {
        if (target[key] === undefined || target[key] === null) {
            target[key] = typeof value === 'object' && value !== null && !Array.isArray(value)
                ? structuredClone(value)
                : value;
            continue;
        }
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof target[key] === 'object') {
            mergeMissing(target[key], value);
        }
    }
    return target;
}

export function getSettings() {
    const store = getExtensionSettingsObject();
    if (!store) {
        return structuredClone(defaultSettings);
    }
    if (!store[SETTINGS_KEY] || typeof store[SETTINGS_KEY] !== 'object') {
        store[SETTINGS_KEY] = structuredClone(defaultSettings);
    } else {
        mergeMissing(store[SETTINGS_KEY], defaultSettings);
    }
    return store[SETTINGS_KEY];
}

export function saveSettings() {
    try {
        getCtx().saveSettingsDebounced();
    } catch (err) {
        console.warn('[Storybook] could not save settings', err);
    }
}

export function getPlannerPrompt(settings) {
    const custom = String(settings.plannerPrompt ?? '').trim();
    return custom || DEFAULT_PLANNER_PROMPT;
}

export function countForSettings(settings) {
    const value = Number(settings.keyframes);
    if (!Number.isFinite(value)) {
        return defaultSettings.keyframes;
    }
    return Math.min(6, Math.max(1, Math.round(value)));
}

export async function loadSettingsHtml() {
    const target = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
    if (!target) {
        console.warn('[Storybook] settings container not found');
        return;
    }
    if (document.getElementById('storybook_settings')) {
        return;
    }
    try {
        const response = await fetch(`${BASE_URL}/settings.html`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        target.insertAdjacentHTML('beforeend', await response.text());
    } catch (err) {
        console.error('[Storybook] failed to load settings.html', err);
    }
}

function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.value = value;
    }
}

function setChecked(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.checked = Boolean(value);
    }
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.value = value ?? '';
    }
}

function bindCheckbox(id, apply) {
    const el = document.getElementById(id);
    if (!el) {
        return;
    }
    el.addEventListener('change', () => {
        const settings = getSettings();
        apply(settings, el.checked);
        saveSettings();
        syncDependentUI();
        emit(STORY_EVENTS.SETTINGS, { id, value: el.checked });
    });
}

function bindInput(id, apply) {
    const el = document.getElementById(id);
    if (!el) {
        return;
    }
    const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(eventName, () => {
        const settings = getSettings();
        apply(settings, el.value);
        saveSettings();
        syncDependentUI();
        emit(STORY_EVENTS.SETTINGS, { id, value: el.value });
    });
}

export function getCustomApiKey() {
    try {
        return localStorage.getItem('storybook_custom_api_key') ?? '';
    } catch {
        return '';
    }
}

export function setCustomApiKey(value) {
    try {
        localStorage.setItem('storybook_custom_api_key', value);
    } catch { /* storage unavailable */ }
}

export function bindSettingsControls() {
    bindCheckbox('storybook_enabled', (s, v) => s.enabled = v);
    bindCheckbox('storybook_auto_on_swipe', (s, v) => s.autoOnSwipe = v);
    bindCheckbox('storybook_open_lightbox', (s, v) => s.openLightboxOnFinish = v);
    bindCheckbox('storybook_save_to_gallery', (s, v) => s.saveToGallery = v);
    bindCheckbox('storybook_show_inline', (s, v) => s.showInline = v);

    bindInput('storybook_keyframes', (s, v) => s.keyframes = Math.min(6, Math.max(1, Number(v) || 3)));
    bindInput('storybook_trigger', (s, v) => s.trigger = v);
    bindInput('storybook_interval', (s, v) => s.interval = Math.min(50, Math.max(1, Number(v) || 3)));
    bindInput('storybook_size', (s, v) => s.size = v);

    bindCheckbox('storybook_include_description', (s, v) => s.include.description = v);
    bindCheckbox('storybook_include_personality', (s, v) => s.include.personality = v);
    bindCheckbox('storybook_include_scenario', (s, v) => s.include.scenario = v);
    bindCheckbox('storybook_include_persona', (s, v) => s.include.persona = v);
    bindInput('storybook_context_messages', (s, v) => s.contextMessages = Math.min(10, Math.max(0, Number(v) || 0)));

    bindInput('storybook_anchor', (s, v) => s.anchor = v);
    bindInput('storybook_style_text', (s, v) => s.styleText = v);
    bindInput('storybook_negative', (s, v) => s.negative = v);
    bindInput('storybook_planner_prompt', (s, v) => s.plannerPrompt = v);

    const reset = document.getElementById('storybook_planner_reset');
    reset?.addEventListener('click', () => {
        const settings = getSettings();
        settings.plannerPrompt = '';
        setText('storybook_planner_prompt', '');
        saveSettings();
        refreshSettingsUI();
    });

    for (const radio of document.querySelectorAll('input[name="storybook_planner_backend"]')) {
        radio.addEventListener('change', () => {
            if (!radio.checked) {
                return;
            }
            const settings = getSettings();
            settings.plannerBackend = radio.value;
            saveSettings();
            syncDependentUI();
            emit(STORY_EVENTS.SETTINGS, { id: 'storybook_planner_backend', value: radio.value });
        });
    }

    bindInput('storybook_custom_base_url', (s, v) => s.customApi.baseUrl = v);
    bindInput('storybook_custom_model', (s, v) => s.customApi.model = v);
    bindInput('storybook_custom_temperature', (s, v) => s.customApi.temperature = Number(v));
    bindInput('storybook_custom_max_tokens', (s, v) => s.customApi.maxTokens = Number(v));

    const key = document.getElementById('storybook_custom_api_key');
    key?.addEventListener('input', () => {
        setCustomApiKey(key.value);
    });

    refreshSettingsUI();
    updateStatsUI();
}

export function syncDependentUI() {
    const settings = getSettings();

    const keyframesValue = document.getElementById('storybook_keyframes_value');
    if (keyframesValue) {
        keyframesValue.textContent = String(settings.keyframes);
    }

    const contextValue = document.getElementById('storybook_context_messages_value');
    if (contextValue) {
        contextValue.textContent = String(settings.contextMessages);
    }

    const intervalRow = document.getElementById('storybook_interval_row');
    if (intervalRow) {
        intervalRow.style.display = settings.trigger === TRIGGERS.INTERVAL ? '' : 'none';
    }

    const promptHint = document.getElementById('storybook_planner_prompt_hint');
    if (promptHint) {
        promptHint.textContent = settings.plannerPrompt?.trim()
            ? 'Custom planner prompt in use.'
            : 'Using the built-in planner prompt.';
    }

    const customFields = document.getElementById('storybook_custom_api_fields');
    if (customFields) {
        customFields.style.display = settings.plannerBackend === 'custom' ? '' : 'none';
    }
}

export function refreshSettingsUI() {
    const settings = getSettings();

    setChecked('storybook_enabled', settings.enabled);
    setChecked('storybook_auto_on_swipe', settings.autoOnSwipe);
    setChecked('storybook_open_lightbox', settings.openLightboxOnFinish);
    setChecked('storybook_save_to_gallery', settings.saveToGallery);
    setChecked('storybook_show_inline', settings.showInline);

    setValue('storybook_keyframes', settings.keyframes);
    setValue('storybook_trigger', settings.trigger);
    setValue('storybook_interval', settings.interval);
    setValue('storybook_size', settings.size);

    setChecked('storybook_include_description', settings.include.description);
    setChecked('storybook_include_personality', settings.include.personality);
    setChecked('storybook_include_scenario', settings.include.scenario);
    setChecked('storybook_include_persona', settings.include.persona);

    setValue('storybook_context_messages', settings.contextMessages);

    setText('storybook_anchor', settings.anchor);
    setText('storybook_style_text', settings.styleText);
    setText('storybook_negative', settings.negative);
    setText('storybook_planner_prompt', settings.plannerPrompt);

    const plannerRadio = document.querySelector(`input[name="storybook_planner_backend"][value="${settings.plannerBackend}"]`);
    if (plannerRadio) {
        plannerRadio.checked = true;
    }

    setText('storybook_custom_base_url', settings.customApi.baseUrl);
    setText('storybook_custom_model', settings.customApi.model);
    setValue('storybook_custom_temperature', settings.customApi.temperature);
    setValue('storybook_custom_max_tokens', settings.customApi.maxTokens);
    const keyInput = document.getElementById('storybook_custom_api_key');
    if (keyInput && document.activeElement !== keyInput) {
        keyInput.value = getCustomApiKey();
    }

    syncDependentUI();
}

export function updateStatsUI() {
    const el = document.getElementById('storybook_stats');
    if (!el) {
        return;
    }
    const ctx = window.SillyTavern?.getContext?.();
    let chatImages = 0;
    let chatStorybooks = 0;
    for (const message of ctx?.chat ?? []) {
        const frames = message?.extra?.storybook?.keyframes;
        if (!Array.isArray(frames)) {
            continue;
        }
        chatStorybooks++;
        chatImages += frames.filter(frame => frame?.status === 'ready' && frame?.url).length;
    }
    el.textContent = `This chat: ${chatStorybooks} storybook${chatStorybooks === 1 ? '' : 's'}, ${chatImages} image${chatImages === 1 ? '' : 's'} · This session: ${sessionStats.images} image${sessionStats.images === 1 ? '' : 's'}, ${sessionStats.plannerCalls} storyboard plan${sessionStats.plannerCalls === 1 ? '' : 's'}`;
}
