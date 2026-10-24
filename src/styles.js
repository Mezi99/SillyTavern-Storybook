export const DEFAULT_STYLE_PROFILE_ID = 'auto';

export const STYLE_PROFILES = {
    auto: {
        id: 'auto',
        label: 'Default',
        imageStyle: '',
        plannerStyle: '',
        negativeTags: 'text, watermark, logo, signature, low quality, blurry',
    },
    anime: {
        id: 'anime',
        label: 'Anime',
        imageStyle: 'anime style, illustration, best quality, detailed eyes, clean lineart, visual novel CG, cinematic composition, full-frame single scene',
        plannerStyle: 'Clean anime illustration with expressive faces, crisp linework, and polished lighting.',
        negativeTags: 'photorealistic, 3d render, lowres, bad anatomy, bad hands, text, watermark, logo, signature',
    },
    photorealistic: {
        id: 'photorealistic',
        label: 'Photorealistic',
        imageStyle: 'photorealistic, high quality, sharp focus, natural lighting, detailed textures, believable skin and materials, photoreal cinematic still, coherent scene, clear focal point',
        plannerStyle: 'Photorealistic image with believable skin, optics, materials, camera framing, and natural scene lighting.',
        negativeTags: 'anime, cartoon, illustration, painting, plastic skin, uncanny face, low quality, blurry, text, watermark, logo, signature',
    },
    painterly: {
        id: 'painterly',
        label: 'Painterly',
        imageStyle: 'painterly, fantasy illustration, soft brushwork, rich atmosphere, high detail, storybook composition, dramatic lighting, clear focal point',
        plannerStyle: 'Painterly fantasy illustration with soft brushwork, rich atmosphere, and storybook color harmony.',
        negativeTags: 'photorealistic, flat colors, muddy details, text, watermark, logo, signature, low quality',
    },
};

const STOP_WORDS = new Set([
    'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'without',
]);

const NEGATIVE_ECHO_RE = /\b(no|without|avoid)\b.*\b(text|lettering|letters|captions?|subtitles?|watermarks?|logos?|signatures?|speech bubbles?|panels?|borders?|collages?|grids?|bad anatomy|extra (?:head|limbs?|digits?)|deformed|low quality|blurry|jpeg artifacts?)\b/i;
const NEGATIVE_FRAGMENT_RE = /^(?:text|lettering|letters|captions?|subtitles?|watermarks?|logos?|signatures?|speech bubbles?|panels?|borders?|collages?|grids?|contact sheets?|character sheets?|multiple views?|split screens?|bad anatomy|extra (?:heads?|limbs?|digits?)|deformed|low quality|blurry|jpeg artifacts?)$/;

export function resolveStyleProfile(id) {
    return STYLE_PROFILES[id] ?? STYLE_PROFILES[DEFAULT_STYLE_PROFILE_ID];
}

export function splitPromptFragments(value) {
    return String(value ?? '')
        .split(/[,;\n]+/)
        .map(fragment => fragment.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

function fragmentKey(fragment) {
    return String(fragment ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function fragmentTokens(fragment) {
    return fragmentKey(fragment)
        .split(' ')
        .filter(token => token && !STOP_WORDS.has(token));
}

export function dedupeFragments(fragments) {
    const seen = new Set();
    const result = [];
    for (const fragment of fragments) {
        const clean = String(fragment ?? '').replace(/\s+/g, ' ').trim();
        if (!clean) {
            continue;
        }
        const key = fragmentKey(clean);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(clean);
    }
    return result;
}

export function mergePromptParts(parts) {
    return dedupeFragments(parts.flatMap(splitPromptFragments)).join(', ');
}

export function mergeNegatives(parts) {
    return mergePromptParts(parts);
}

function styleVocabulary(profile, userStyle) {
    const vocabulary = new Set();
    for (const source of [profile.label, profile.imageStyle, profile.plannerStyle, userStyle]) {
        for (const token of fragmentTokens(source)) {
            vocabulary.add(token);
        }
    }
    return vocabulary;
}

function isStyleEcho(fragment, vocabulary) {
    const tokens = fragmentTokens(fragment);
    if (!tokens.length || !vocabulary.size) {
        return false;
    }
    const matched = tokens.filter(token => vocabulary.has(token)).length;
    return matched >= 2 && matched / tokens.length >= 0.5;
}

function isNegativeEcho(fragment) {
    return NEGATIVE_ECHO_RE.test(fragment) || NEGATIVE_FRAGMENT_RE.test(fragmentKey(fragment));
}

function takeFragments(fragments, limit) {
    const result = [];
    let used = 0;
    for (const fragment of fragments) {
        const next = fragment.length + (result.length ? 2 : 0);
        if (used + next > limit) {
            continue;
        }
        result.push(fragment);
        used += next;
    }
    return result;
}

function takeText(fragments, limit) {
    const joined = takeFragments(fragments, limit).join(', ');
    if (joined || limit <= 0) {
        return joined;
    }
    const first = fragments[0] ?? '';
    return first.slice(0, limit).trim();
}

export function composeStyledPromptDetailed({ profile, userStyle, anchor, imagePrompt, maxChars = 1500 }) {
    const selected = resolveStyleProfile(profile?.id ?? profile);
    const vocabulary = styleVocabulary(selected, userStyle);
    const styleFragments = dedupeFragments(splitPromptFragments(selected.imageStyle));
    const anchorFragments = dedupeFragments(splitPromptFragments(anchor))
        .filter(fragment => !styleFragments.some(existing => fragmentKey(existing) === fragmentKey(fragment)));
    const userFragments = dedupeFragments(splitPromptFragments(userStyle))
        .filter(fragment => ![...styleFragments, ...anchorFragments].some(existing => fragmentKey(existing) === fragmentKey(fragment)));
    const originalSceneFragments = dedupeFragments(splitPromptFragments(imagePrompt));
    const sceneFragments = originalSceneFragments
        .filter(fragment => !isNegativeEcho(fragment))
        .filter(fragment => !isStyleEcho(fragment, vocabulary))
        .filter(fragment => ![...styleFragments, ...anchorFragments, ...userFragments].some(existing => fragmentKey(existing) === fragmentKey(fragment)));

    const fullStyleText = styleFragments.join(', ');
    const styleText = fullStyleText.slice(0, maxChars);
    const remainingAfterStyle = Math.max(0, maxChars - styleText.length - (styleText ? 2 : 0));
    const anchorText = takeText(anchorFragments, remainingAfterStyle);
    const remainingAfterAnchor = Math.max(0, remainingAfterStyle - anchorText.length - (anchorText ? 2 : 0));
    const userText = takeText(userFragments, Math.min(300, remainingAfterAnchor));
    const used = styleText.length
        + (styleText && userText ? 2 : 0) + userText.length
        + ((styleText || userText) && anchorText ? 2 : 0) + anchorText.length;
    const sceneText = takeText(sceneFragments, Math.max(0, maxChars - used - (used ? 2 : 0)));
    const prompt = [styleText, userText, anchorText, sceneText].filter(Boolean).join(', ').slice(0, maxChars);

    return {
        prompt,
        maxChars,
        segments: {
            style: styleText,
            userStyle: userText,
            anchor: anchorText,
            scene: sceneText,
        },
        raw: {
            style: fullStyleText,
            anchor: anchorFragments.join(', '),
            userStyle: userFragments.join(', '),
            scene: originalSceneFragments.join(', '),
        },
        dropped: {
            scene: originalSceneFragments.filter(fragment => !sceneFragments.includes(fragment)),
        },
        truncated: {
            style: fullStyleText.length > styleText.length,
            anchor: anchorFragments.join(', ').length > anchorText.length,
            userStyle: userFragments.join(', ').length > userText.length,
            scene: sceneFragments.join(', ').length > sceneText.length,
        },
    };
}

export function composeStyledPrompt(options) {
    return composeStyledPromptDetailed(options).prompt;
}
