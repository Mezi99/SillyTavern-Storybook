import { SIZE_PRESETS } from './defaults.js';
import { resolveStyleProfile } from './styles.js';

export const BASE_URL = new URL('../', import.meta.url).href.replace(/\/+$/, '');

export function getCtx() {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) {
        throw new Error('SillyTavern is not ready yet');
    }
    return ctx;
}

export function tryGetCtx() {
    return window.SillyTavern?.getContext?.() ?? null;
}

export function getExtensionSettingsObject() {
    const ctx = tryGetCtx();
    return ctx?.extensionSettings ?? ctx?.extension_settings ?? null;
}

export function getMessage(mesId) {
    const ctx = tryGetCtx();
    return ctx?.chat?.[mesId] ?? null;
}

/**
 * Tells whether a chat message may carry a storybook.
 * User messages and SillyTavern's own system blocks never do.
 * @param {object} message Chat message
 * @returns {boolean} True when the message can be illustrated
 */
export function isIllustratable(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    if (message.is_user || message.is_system) {
        return false;
    }
    if (message.extra?.isSmallSys || message.extra?.uses_system_ui) {
        return false;
    }
    return true;
}

/**
 * Finds the last message the extension is allowed to illustrate.
 * System messages are never illustrated, so they must not be picked here.
 * @returns {number} Index of the last assistant message, or -1
 */
export function lastAssistantMessageId() {
    const ctx = tryGetCtx();
    const chat = ctx?.chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!isIllustratable(chat[i])) {
            continue;
        }
        return i;
    }
    return -1;
}

export function getMessageText(message) {
    if (!message) {
        return '';
    }
    return String(message.extra?.display_text ?? message.mes ?? '');
}

export function resolveSize(settings) {
    const preset = SIZE_PRESETS[settings.size] ?? SIZE_PRESETS.portrait;
    if (!preset.width || !preset.height) {
        return { width: null, height: null };
    }
    return { width: preset.width, height: preset.height };
}

const MAX_FIELD = { description: 1400, personality: 600, scenario: 600, persona: 600 };

function clip(text, max) {
    const value = String(text ?? '').trim();
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max).trimEnd()} [...]`;
}

export function buildPlannerInput(mesId, settings) {
    const ctx = getCtx();
    const message = ctx.chat?.[mesId] ?? null;
    const targetName = message?.is_user ? ctx.name1 : (message?.name || ctx.name2);

    const contextLines = [];
    const start = Math.max(0, mesId - Math.max(0, Number(settings.contextMessages) || 0));
    for (let i = start; i < mesId; i++) {
        const item = ctx.chat[i];
        if (!item || item.is_system || (item.extra?.hide ?? false)) {
            continue;
        }
        const text = clip(getMessageText(item), 500);
        if (!text) {
            continue;
        }
        const name = item.is_user ? ctx.name1 : (item.name || ctx.name2);
        contextLines.push(`${name}: ${text}`);
    }

    let fields = { description: '', personality: '', scenario: '', persona: '' };
    try {
        fields = ctx.getCharacterCardFields?.() ?? fields;
    } catch (err) {
        console.warn('[Storybook] character card fields unavailable', err);
    }

    const include = settings.include ?? {};
    const character = [];
    if (include.description) {
        const text = clip(fields.description, MAX_FIELD.description);
        if (text) {
            character.push(`appearance and background: ${text}`);
        }
    }
    if (include.personality) {
        const text = clip(fields.personality, MAX_FIELD.personality);
        if (text) {
            character.push(`personality: ${text}`);
        }
    }
    if (include.scenario) {
        const text = clip(fields.scenario, MAX_FIELD.scenario);
        if (text) {
            character.push(`scenario: ${text}`);
        }
    }

    const persona = include.persona ? clip(fields.persona, MAX_FIELD.persona) : '';
    const profile = resolveStyleProfile(settings.styleProfile);
    const style = [
        profile.id === 'auto' ? '' : `Look: ${profile.label}`,
        profile.plannerStyle,
        String(settings.styleText ?? '').trim() ? `Additional style: ${String(settings.styleText).trim()}` : '',
    ].filter(Boolean).join('\n');

    return {
        targetName,
        target: getMessageText(message),
        contextLines,
        characterName: String(ctx.name2 ?? ''),
        character: character.join('\n'),
        personaName: String(ctx.name1 ?? ''),
        persona,
        style,
    };
}

export function buildUserPrompt(input) {
    const blocks = [];
    if (input.style) {
        blocks.push(`STYLE\n${input.style}`);
    }
    if (input.contextLines.length) {
        blocks.push(`CONTEXT\n${input.contextLines.join('\n')}`);
    }
    blocks.push(`LATEST STORY\n${input.targetName}: ${input.target}`);
    if (input.character) {
        blocks.push(`CHARACTER\n${input.characterName}\n${input.character}`);
    }
    if (input.persona) {
        blocks.push(`PERSONA\n${input.personaName}: ${input.persona}`);
    }
    return blocks.join('\n\n');
}

export function hashString(value) {
    let hash = 5381;
    const text = String(value ?? '');
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

export function uuid() {
    if (window.crypto?.randomUUID) {
        return crypto.randomUUID();
    }
    return `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
