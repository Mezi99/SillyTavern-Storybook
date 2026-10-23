import { DEFAULT_NEGATIVE_PROMPT } from '../defaults.js';
import { getCtx, resolveSize, tryGetCtx } from '../context.js';
import { getSettings } from '../settings.js';
import { mergeNegatives, resolveStyleProfile } from '../styles.js';

function abortError() {
    const err = new Error('Storybook generation cancelled');
    err.name = 'AbortError';
    return err;
}

export function describeImageBackend() {
    const ctx = tryGetCtx();
    const sd = ctx?.extensionSettings?.sd ?? ctx?.extension_settings?.sd;
    if (!sd) {
        return { ok: false, text: 'Image Generation extension settings not found.' };
    }
    if (!ctx.SlashCommandParser?.commands?.imagine) {
        return { ok: false, text: 'The /imagine command is not registered. Is the Image Generation extension enabled?' };
    }
    const source = sd.source ? String(sd.source) : 'unknown';
    const model = sd.model ? String(sd.model) : 'default model';
    return { ok: true, text: `Using SillyTavern Image Generation · ${source} · ${model}` };
}

export async function generateImage({ prompt, negative, signal }) {
    const ctx = getCtx();
    const settings = getSettings();
    const command = ctx.SlashCommandParser?.commands?.imagine;

    if (!command?.callback) {
        throw new Error('The /imagine command is unavailable. Enable the built-in Image Generation extension and configure it once.');
    }

    if (!prompt || !String(prompt).trim()) {
        throw new Error('Empty image prompt');
    }

    const controller = new AbortController();
    if (signal) {
        if (signal.aborted) {
            throw abortError();
        }
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const args = {
        quiet: 'true',
        gallery: settings.saveToGallery ? 'true' : 'false',
        extend: 'false',
        _abortController: controller,
    };

    const profile = resolveStyleProfile(settings.styleProfile);
    const mergedNegative = mergeNegatives([
        DEFAULT_NEGATIVE_PROMPT,
        profile.negativeTags,
        settings.negative,
        negative,
    ]);
    if (mergedNegative) {
        args.negative = mergedNegative;
    }

    const size = resolveSize(settings);
    if (size.width && size.height) {
        args.width = String(size.width);
        args.height = String(size.height);
    }

    const url = await command.callback(args, String(prompt));

    if (signal?.aborted || controller.signal.aborted) {
        throw abortError();
    }
    if (!url) {
        const err = new Error('Image Generation returned nothing. Check the Image Generation source, model and API key, or the generation was stopped mid-way.');
        err.systemic = true;
        throw err;
    }

    return { url: String(url) };
}
