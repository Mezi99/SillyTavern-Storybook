export const MODULE_NAME = 'Storybook';
export const SETTINGS_KEY = 'storybook';

export const DEFAULT_NEGATIVE_PROMPT = 'text, letters, captions, subtitles, UI, watermark, logo, signature, speech bubble, split screen, panel, collage, contact sheet, character sheet, grid, multiple views, four images, duplicated face, extra head, extra limbs, extra digits, bad anatomy, poorly drawn hands, deformed, low quality, blurry, jpeg artifacts';

export const SIZE_PRESETS = {
    portrait: { width: 832, height: 1216, label: 'Portrait 832 x 1216' },
    landscape: { width: 1216, height: 832, label: 'Landscape 1216 x 832' },
    square: { width: 1024, height: 1024, label: 'Square 1024 x 1024' },
    st: { width: null, height: null, label: 'Use SillyTavern Image Generation settings' },
};

export const TRIGGERS = {
    REPLY: 'reply',
    INTERVAL: 'interval',
    MANUAL: 'manual',
};

export const DEFAULT_PLANNER_PROMPT = `You are a storyboard director. You turn a single roleplay reply into the pages of a picture book.

You receive these blocks:
- STYLE: how every image should look.
- CHARACTER: the people in the story and how they appear.
- PERSONA: the reader's own character, if present.
- CONTEXT: a few earlier lines, for orientation only.
- LATEST STORY: the reply you must illustrate.

Split LATEST STORY into exactly {count} keyframes. The keyframes must read in order as a small set of still images covering that one reply: no invented plot events, no repetition of the same shot.

For every keyframe produce:
- index: a number starting at 1.
- title: 2 to 5 words.
- caption: one short storybook sentence, narration for a reader, no quotation marks around dialogue.
- imagePrompt: a self-contained English description for a text-to-image model. Name the subject, the action, the place, the light, the mood and the framing. Never write "as before", "in the previous image", "same character" or anything that depends on another frame.
- imagePrompt must describe visible content only. Do not repeat the STYLE text, medium, quality tags, negative prompts or phrases such as "no text"; the extension appends style and negatives separately.

Also produce:
- characterAnchor: one reusable string, under 40 words, describing the main character's visible appearance in enough detail that repeating the same string keeps the face and outfit consistent. Use the same wording style as a character sheet: species or ethnicity, hair, eyes, build, clothing, notable marks.

Rules:
- Put characterAnchor at the front of every imagePrompt that shows that character, followed by a comma, and keep it word for word identical in every frame.
- If a frame does not show the character, write "no character visible" in that imagePrompt instead of the anchor.
- Vary framing across the set: mix wide, medium and close views, and change the camera angle between frames.
- No lettering, no dialogue written inside the image, no watermarks, no signatures, no speech bubbles, no panel borders, no page layout.
- Keep every imagePrompt between 35 and 120 words.
- Describe only what a camera could capture.

Answer with a single JSON object and nothing else:
{"characterAnchor":"...","keyframes":[{"index":1,"title":"...","caption":"...","imagePrompt":"..."}]}`;

export const defaultSettings = {
    enabled: true,
    keyframes: 3,
    trigger: TRIGGERS.REPLY,
    interval: 3,
    autoOnSwipe: true,
    openLightboxOnFinish: false,
    showInline: false,
    showDebugTools: false,
    size: 'portrait',
    saveToGallery: false,
    include: {
        description: true,
        personality: true,
        scenario: true,
        persona: true,
    },
    contextMessages: 2,
    anchor: '',
    styleProfile: 'auto',
    styleText: '',
    negative: '',
    plannerPrompt: '',
    plannerBackend: 'st',
    customApi: {
        baseUrl: '',
        model: '',
        temperature: 0.7,
        maxTokens: 2048,
    },
    imageBackend: 'st',
};

export const PLANNER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        characterAnchor: { type: 'string' },
        keyframes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    index: { type: 'integer' },
                    title: { type: 'string' },
                    caption: { type: 'string' },
                    imagePrompt: { type: 'string' },
                },
                required: ['index', 'title', 'caption', 'imagePrompt'],
            },
        },
    },
    required: ['characterAnchor', 'keyframes'],
};
