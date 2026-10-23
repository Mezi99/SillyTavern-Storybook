export const DEFAULT_STYLE_PROFILE_ID = 'auto';

export const STYLE_PROFILES = {
    auto: {
        id: 'auto',
        label: 'Default',
        styleText: '',
        positiveTags: '',
        subjectTags: '',
        negativeTags: 'text, watermark, logo, signature, low quality, blurry',
    },
    anime: {
        id: 'anime',
        label: 'Anime',
        styleText: 'Anime illustration with clean character design, expressive faces, crisp linework, and polished lighting.',
        positiveTags: 'anime style, illustration, best quality, detailed eyes, clean lineart',
        subjectTags: 'visual novel CG, cinematic composition, full-frame single scene',
        negativeTags: 'photorealistic, 3d render, lowres, bad anatomy, bad hands, text, watermark, logo, signature',
    },
    photorealistic: {
        id: 'photorealistic',
        label: 'Photorealistic',
        styleText: 'Photorealistic image with believable skin, optics, materials, camera framing, and natural scene lighting.',
        positiveTags: 'photorealistic, high quality, sharp focus, natural lighting, detailed textures',
        subjectTags: 'photoreal cinematic still, coherent scene, clear focal point',
        negativeTags: 'anime, cartoon, illustration, painting, plastic skin, uncanny face, low quality, blurry, text, watermark, logo, signature',
    },
    painterly: {
        id: 'painterly',
        label: 'Painterly',
        styleText: 'Painterly fantasy illustration with soft brushwork, rich atmosphere, and storybook color harmony.',
        positiveTags: 'painterly, fantasy illustration, soft brushwork, rich atmosphere, high detail',
        subjectTags: 'storybook composition, dramatic lighting, clear focal point',
        negativeTags: 'photorealistic, flat colors, muddy details, text, watermark, logo, signature, low quality',
    },
};

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
    return fragment
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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

export function composeStyledPrompt({ profile, userStyle, anchor, imagePrompt, maxChars = 1500 }) {
    const selected = resolveStyleProfile(profile?.id ?? profile);
    const profileFragments = dedupeFragments([
        ...splitPromptFragments(selected.positiveTags),
        ...splitPromptFragments(selected.subjectTags),
        ...splitPromptFragments(selected.styleText),
    ]);
    const anchorFragments = dedupeFragments(splitPromptFragments(anchor))
        .filter(fragment => !profileFragments.some(existing => fragmentKey(existing) === fragmentKey(fragment)));
    const userFragments = dedupeFragments(splitPromptFragments(userStyle))
        .filter(fragment => ![...profileFragments, ...anchorFragments].some(existing => fragmentKey(existing) === fragmentKey(fragment)));
    const sceneFragments = dedupeFragments(splitPromptFragments(imagePrompt))
        .filter(fragment => ![...profileFragments, ...anchorFragments, ...userFragments].some(existing => fragmentKey(existing) === fragmentKey(fragment)));

    const profileText = profileFragments.join(', ').slice(0, maxChars);
    const remainingAfterProfile = Math.max(0, maxChars - profileText.length - (profileText ? 2 : 0));
    const anchorText = takeText(anchorFragments, remainingAfterProfile);
    const remainingAfterAnchor = Math.max(0, remainingAfterProfile - anchorText.length - (anchorText ? 2 : 0));
    const userText = takeText(userFragments, Math.min(300, remainingAfterAnchor));
    const used = profileText.length
        + (profileText && userText ? 2 : 0) + userText.length
        + ((profileText || userText) && anchorText ? 2 : 0) + anchorText.length;
    const sceneText = takeText(sceneFragments, Math.max(0, maxChars - used - (used ? 2 : 0)));
    return [profileText, userText, anchorText, sceneText].filter(Boolean).join(', ').slice(0, maxChars);
}
