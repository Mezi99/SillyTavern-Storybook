# Storybook - Technical Reference

This document describes how the extension is built, how it talks to SillyTavern, and what to watch
out for when maintaining it. It targets version **1.1.2**.

---

## 1. Design goals

- Use only public SillyTavern APIs (`getContext()`), never patch core files.
- Keep generation cancellable and safe across chat switches.
- Never attach artwork to the wrong message or swipe variant.
- Persist everything inside the chat file; keep secrets out of it.
- Keep the pipeline dependency-free and easy to reason about.

---

## 2. Repository layout

| Path | Responsibility |
| --- | --- |
| `index.js` | Entry point (`init`), settings/action binding, SillyTavern event wiring, trigger decisions. |
| `manifest.json` | Extension manifest (`js`, `css`, `loading_order`, `hooks.activate`). |
| `settings.html` | Drawer markup injected into `#extensions_settings` (or `#extensions_settings2`). |
| `style.css` | Floating window, legacy carousel, viewer, status pills and settings styling. |
| `src/bus.js` | Minimal synchronous event bus for intra-extension events. |
| `src/context.js` | Context access, chat helpers, planner input assembly, hashing, size resolution. |
| `src/debug.js` | In-memory, per-reply planner and image debug traces; never persisted. |
| `src/defaults.js` | Default settings, `MODULE_NAME`, `SETTINGS_KEY`, size presets, trigger enum, built-in prompt, JSON schema. |
| `src/settings.js` | Settings load/merge/save, UI binding, stats, custom API key. |
| `src/styles.js` | Built-in style profiles, prompt fragment dedupe, prompt composition and negative merging. |
| `src/persistence.js` | Storybook get/set/sync, swipe mirroring, hashes, stale detection, save helpers. |
| `src/planner.js` | Planner orchestration, response parsing, prompt compilation, keyframe shaping. |
| `src/backends/planner.js` | Custom OpenAI-compatible planner HTTP client. |
| `src/backends/image.js` | Image generation via SillyTavern's `/imagine` command. |
| `src/pipeline.js` | Job queue, generation state machine, cancellation, dedup guard. |
| `src/view.js` | Shared storybook markup, active-frame state and delegated interaction handlers. |
| `src/window.js` | Floating Storybook window, floating button, reply selection, drag/resize/collapse, layout persistence. |
| `src/lightbox.js` | Full-screen image viewer, keyboard navigation and prompt panel. |
| `src/carousel.js` | Optional legacy inline carousel host. |
| `src/commands.js` | `/storybook` slash command. |

---

## 3. Boot sequence

`manifest.json` declares:

```json
"js": "index.js",
"css": "style.css",
"hooks": { "activate": "init" }
```

On activation SillyTavern calls `init()` in `index.js`:

1. Guard against double initialisation (`started`).
2. Bail out (and reset `started`) if `getContext()` is not ready.
3. `getSettings()` - creates/merges the settings object.
4. `loadSettingsHtml()` - fetches `settings.html` and appends it to the extensions panel.
5. `bindSettingsControls()` - binds inputs and renders current values.
6. `bindActionButtons()` - wires the utility buttons.
7. `registerCommands()` - registers `/storybook` if the parser is available.
8. `initView()` - binds the delegated interaction handlers shared by both displays.
9. `initLightbox()` - creates the viewer and its keyboard handlers.
10. `initWindow()` - creates the floating window and button, restores the saved layout, and starts polling
    for a chat that was already open when the extension activated.
11. `initCarousel()` - binds the legacy inline carousel to bus events (renders only when `showInline`).
12. `registerEvents()` - subscribes to SillyTavern events.
13. `refreshSettingsUI()`, `updateStatusLabels()`, `updateStatsUI()`.
14. A delayed `renderAll()` (400 ms) catches a chat that was already open.

`BASE_URL` in `src/context.js` is derived from `import.meta.url`, so `settings.html` resolves regardless
of the install folder name.

---

## 4. Module dependency graph

```
index.js
  -> src/bus, src/context, src/defaults, src/settings, src/pipeline,
     src/view, src/lightbox, src/window, src/carousel, src/commands,
     src/backends/image, src/planner, src/backends/planner, src/persistence

src/pipeline
  -> src/bus, src/context, src/settings, src/planner, src/debug,
     src/backends/image, src/persistence

src/window
  -> src/bus, src/context, src/persistence, src/pipeline, src/view,
     src/lightbox, src/settings, src/planner, src/debug, src/backends/image

src/carousel
  -> src/bus, src/context, src/persistence, src/pipeline, src/view

src/view
  -> src/bus, src/context, src/persistence, src/pipeline, src/lightbox

src/planner
  -> src/defaults, src/context, src/settings, src/debug, src/backends/planner
```

There are no circular imports that affect evaluation order. `settings.js` imports the context only,
and the pipeline/view/window modules import settings one-way.

---

## 5. Data model

### 5.1 Settings

Stored under `extensionSettings.storybook` (see `SETTINGS_KEY`). Defaults live in
`src/defaults.js` (`defaultSettings`). `getSettings()` deep-merges missing keys via `mergeMissing`, so new
settings can be added without a migration step.

Important fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Automatic triggers allowed. |
| `keyframes` | number | Frames per reply, clamped 1-6. |
| `trigger` | `reply` \| `interval` \| `manual` | Trigger mode. |
| `interval` | number | `N` for interval mode. |
| `autoOnSwipe` | boolean | Illustrate new swipe variants. |
| `showInline` | boolean | Show the legacy under-message carousel instead of relying only on the floating window. |
| `showDebugTools` | boolean | Show the session-only Debug panel in the floating window. |
| `openLightboxOnFinish` | boolean | Open viewer on completion. |
| `size` | preset key | `portrait`, `landscape`, `square`, `st`. |
| `saveToGallery` | boolean | Passed to `/imagine`. |
| `include` | object | Character card fields to include. |
| `contextMessages` | number | Prior messages passed to the planner. |
| `anchor` | string | Reusable character appearance fragment. |
| `styleProfile` | `auto` \| `anime` \| `photorealistic` \| `painterly` | Built-in style tags, style text and negatives. |
| `styleText` | string | Additional user style, deduped and appended after the selected profile. |
| `negative` | string | Extra negative fragments; always merged with built-in negatives. |
| `plannerPrompt` | string | Override prompt; empty means built-in. |
| `plannerBackend` | `st` \| `custom` | Planner transport. |
| `customApi` | object | `baseUrl`, `model`, `temperature`, `maxTokens`. |
| `imageBackend` | string | Reserved; image output currently always uses `/imagine`. |

The custom API key is **not** part of settings. It is read/written with `getCustomApiKey()` /
`setCustomApiKey()` using `localStorage['storybook_custom_api_key']`.

### 5.2 Storybook payload

Stored at `message.extra.storybook` and mirrored to `message.swipe_info[message.swipe_id].extra.storybook`.
Produced by `runJob` in `src/pipeline.js`:

```jsonc
{
  "v": 1,
  "id": "uuid",
  "sourceHash": "…",        // text + count + style profile + style + anchor + prompt + size + "v2"
  "textHash": "…",          // hash of the message text only
  "status": "planning",     // planning | generating | ready | partial | error | cancelled
  "createdAt": 0,
  "updatedAt": 0,
  "anchor": "…",
  "backend": { "kind": "st", "text": "…" },
  "planner": { "api": "…", "backend": "st|custom" },
  "settings": { "count": 3, "size": "portrait", "styleProfile": "auto", "styleText": "…", "negative": "…" },
  "keyframes": [
    {
      "i": 0,
      "title": "…",
      "caption": "…",
      "prompt": "…",          // compiled: image style, user style, anchor, scene
      "rawImagePrompt": "…",
      "status": "pending",    // pending | ready | error
      "url": "",
      "error": "",
      "elapsedMs": 0
    }
  ],
  "error": ""
}
```

`sourceHash` is used for deduplication; `textHash` is used for staleness. Both are non-cryptographic
(djb2-style) hashes from `hashString` in `src/context.js`.

### 5.3 Swipe mirroring

SillyTavern clones message `extra` into `swipe_info` and restores a clone when swiping. A plain object
reference therefore breaks. `syncStorybook()` writes to both places. `mirrorToSwipe()` only writes when:

- `swipe_id` is a number,
- `swipes` and `swipe_info` are arrays,
- the target `swipe_info[swipe_id]` entry exists and is an object,
- `swipes[swipe_id]` is a string.

This avoids creating inconsistent swipe entries for messages that have no variants.

### 5.4 Staleness

`isStorybookStale(message, storybook)` compares `storybook.textHash` with the current `message.mes`.
Missing `textHash` (legacy data) is treated as **not stale** so old artwork is preserved. Stale artwork is
removed on `CHARACTER_MESSAGE_RENDERED`, `MESSAGE_SWIPED` and `MESSAGE_EDITED`, then persisted.

---

## 6. Trigger system

### 6.1 SillyTavern event wiring (`registerEvents` in `index.js`)

| Event | Behavior |
| --- | --- |
| `CHARACTER_MESSAGE_RENDERED(mesId, type)` | Drop stale artwork; render; trigger based on `type`. |
| `CHARACTER_MESSAGE_RENDERED` with `type === 'swipe'` | Render and trigger with reason `swipe` (gated by `autoOnSwipe`). |
| `CHARACTER_MESSAGE_RENDERED` with `type === 'first_message'` | Render; trigger only while `pendingGreeting` is set. |
| `CHAT_CREATED` | Set `pendingGreeting = true`. |
| `GROUP_CHAT_CREATED` | Trigger every illustratable message currently in the chat (the member greetings). |
| `MESSAGE_SWIPED(mesId)` | Drop stale artwork and re-render. |
| `MESSAGE_EDITED(mesId)` | Drop stale artwork and re-render. |
| `MESSAGE_DELETED` | Re-render all and refresh stats. |
| `CHAT_LOADED`, `CHAT_CHANGED` | Cancel all jobs, clear `pendingGreeting`, re-render after 60 ms. |

`REPLY_RENDER_TYPES` and `REPLY_TRIGGER_TYPES` both contain
`normal`, `append`, `appendFinal`, `continue` and `undefined`. They are kept separate so rendering and
triggering can diverge later.

### 6.2 Greeting rule

SillyTavern emits `CHARACTER_MESSAGE_RENDERED(..., 'first_message')` on **every** load where the chat has a
single message, not only on creation. To avoid re-spending credits, the extension arms a one-shot
`pendingGreeting` flag only when SillyTavern reports a real creation.

Character chat order (SillyTavern `getChatResult`):

```
CHAT_CHANGED -> CHAT_CREATED (if fresh) -> CHARACTER_MESSAGE_RENDERED('first_message') (if chat.length === 1)
```

`CHAT_CHANGED` clears the flag, then `CHAT_CREATED` sets it, so a fresh chat triggers exactly once and a
reopened chat never triggers.

Group chat order (SillyTavern `getGroupChat`) is different:

```
CHARACTER_MESSAGE_RENDERED('first_message') per member -> CHAT_CHANGED -> GROUP_CHAT_CREATED (if fresh)
```

Because the greetings render **before** `GROUP_CHAT_CREATED`, the flag cannot be used. Instead the
`GROUP_CHAT_CREATED` handler iterates the chat and triggers every illustratable message. At that moment the
chat contains only the freshly pushed member greetings.

Both flags are cleared on `CHAT_CHANGED` and `CHAT_LOADED` so they cannot leak into a later chat.

### 6.3 Trigger decision

`shouldTriggerNow(reason, mesId)` in `index.js`:

1. `settings.enabled` must be true.
2. `trigger === manual` always returns false.
3. Reason `swipe` returns `settings.autoOnSwipe`.
4. `trigger === interval` returns `repliesSinceLastStorybook(mesId) >= interval`.
5. Otherwise true.

`repliesSinceLastStorybook(mesId)` walks backwards from `mesId`, counting illustratable messages until it
finds one with at least one ready frame URL. The current message counts, so a cadence of 2 fires on the 2nd
and 4th replies, etc.

---

## 7. Pipeline

### 7.1 Queue

`src/pipeline.js` keeps a single `currentJob` and a FIFO `queue`.

- `enqueue(mesId, { force, count, reason })`
  - Rejects automatic reasons when disabled.
  - Rejects invalid ids.
  - Drops duplicates for the same `mesId` unless `force`, **but** a cancelled `currentJob` does not block a
    new request (prevents a chat-switch race).
  - Drops queued duplicates for the same `mesId` and `force` value.
- `drain()` runs one job at a time and re-enters after each job finishes.

### 7.2 Job lifecycle

```
queued -> running -> planning -> generating -> ready | partial | error | cancelled
```

1. Capture `chatId`, `settings` and the target `message`.
2. Dedup guard: skip when `sourceHash` matches, status is `ready`, and a frame has a URL (unless `force`).
3. Write a `planning` storybook, syncing and scheduling a save.
4. `planKeyframes(...)`.
5. On success, write `generating` and the planned keyframes.
6. For each frame: set `pending`, call `generateImage`, then set `ready`/`error`.
7. After the loop: `applyStatus()` computes `ready`, `partial`, `error` or `cancelled`.
8. Persist with `saveNow()`, update stats, toast, and optionally open the viewer.

### 7.3 Target guard

`stillOnTarget()` verifies:

- `ctx.getCurrentChatId()` still equals the captured `chatId`,
- the message still exists at `mesId`,
- `message.swipe_id` still equals the captured swipe id.

If the guard fails, the job stops writing so artwork never lands on another chat or variant.

### 7.4 Cancellation

`cancelJob(mesId | null)`:

- Marks the matching `currentJob` as cancelled and aborts its `AbortController`.
- Removes and aborts matching queued jobs.

The active job checks `job.cancelled` / the abort signal between frames and in the image backend. A
cancelled job persists `status: 'cancelled'` (or keeps `partial` if some frames were already ready).

### 7.5 Failure semantics

- Planner failure: storybook becomes `error` with the message; previous frames are retained.
- Frame failure: that frame becomes `error`; remaining frames continue.
- A frame error flagged `systemic` (for example `/imagine` returned nothing) marks the rest as skipped.
- A failed regeneration never deletes existing artwork.

---

## 8. Planner

### 8.1 Input assembly

`buildPlannerInput(mesId, settings)` in `src/context.js`:

- Target text: `extra.display_text` if present, else `mes`.
- Optional context: up to `contextMessages` earlier messages, skipping system and hidden messages.
- Character fields from `ctx.getCharacterCardFields()` filtered by `settings.include`.
- Field clipping: description 1400, personality 600, scenario 600, persona 600, context lines 500.
- Style summary: selected profile label, profile `plannerStyle` and additional user style. The image-only
  `imageStyle` is deliberately not sent to the planner, so it does not echo style tags into `imagePrompt`.

`buildUserPrompt` emits blocks in this order: `STYLE`, `CONTEXT`, `LATEST STORY`, `CHARACTER`, `PERSONA`.

### 8.2 System prompt

`getPlannerPrompt(settings)` returns the custom prompt or `DEFAULT_PLANNER_PROMPT`. `{count}` is replaced
with the requested frame count. If a character anchor is configured, it is appended to the system prompt so
the planner reuses it verbatim.

### 8.3 Response handling

`planKeyframes`:

1. Validates that the target has text.
2. Chooses the transport:
   - `plannerBackend === 'custom'` -> `requestCustomPlan`.
   - Otherwise `ctx.generateRaw`. When `ctx.mainApi === 'openai'`, it first tries `generateRaw` with
     `jsonSchema: PLANNER_SCHEMA`, then falls back to plain text.
3. `normalizePlannerOutput` accepts objects, fenced JSON, or the first balanced JSON object in a string.
4. `shapeKeyframes` cleans, sorts, truncates to `count`, drops entries without an image prompt, and throws if
   nothing usable remains.
5. Each frame prompt is compiled by `compileImagePromptDetailed`: profile `imageStyle`, additional user
   style, anchor, then the scene `imagePrompt`. The planner gets only `plannerStyle`, so the same style
   phrase is not repeated through both model calls. Fragments are deduped case-insensitively, style and
   negative echoes in the scene are dropped, a repeated anchor is not added twice, and the result is capped
   at 1500 characters while protecting the style and anchor.
6. `compileImagePromptDetailed` also returns segment lengths, raw fragments, dropped scene echoes and
   truncation flags. The persisted frame keeps only the compiled string; the details go to the in-memory
   debug trace.
7. Throws `The storyboard planner returned no usable keyframes.` or
   `The storyboard planner did not return JSON...` with actionable text.

`responseLengthFor(count)` = `min(4096, 600 + count * 520)`.

### 8.4 Style profiles

`src/styles.js` owns the built-in profiles. Default is selected out of the box and adds no positive
quality tags. Each profile has two separate style fields:

- `imageStyle` - tags used only by `compileImagePromptDetailed`.
- `plannerStyle` - prose guidance used only in the planner's `STYLE` block.

| Profile | `imageStyle` (images) | `plannerStyle` (planner) | Negative tags |
| --- | --- | --- | --- |
| Default | none | none | `text, watermark, logo, signature, low quality, blurry` |
| Anime | `anime style, illustration, best quality, detailed eyes, clean lineart, visual novel CG, cinematic composition, full-frame single scene` | Clean anime illustration with expressive faces, crisp linework, and polished lighting. | `photorealistic, 3d render, lowres, bad anatomy, bad hands, text, watermark, logo, signature` |
| Photorealistic | `photorealistic, high quality, sharp focus, natural lighting, detailed textures, believable skin and materials, photoreal cinematic still, coherent scene, clear focal point` | Photorealistic image with believable skin, optics, materials, camera framing, and natural scene lighting. | `anime, cartoon, illustration, painting, plastic skin, uncanny face, low quality, blurry, text, watermark, logo, signature` |
| Painterly | `painterly, fantasy illustration, soft brushwork, rich atmosphere, high detail, storybook composition, dramatic lighting, clear focal point` | Painterly fantasy illustration with soft brushwork, rich atmosphere, and storybook color harmony. | `photorealistic, flat colors, muddy details, text, watermark, logo, signature, low quality` |

The additional user style is deduped against the profile and appended after it. The scene prompt is
filtered for exact duplicates, style echoes and negative echoes before composition. `DEFAULT_NEGATIVE_PROMPT`
from `src/defaults.js` is always merged before the profile negatives, then `settings.negative` is added.
Changing `styleProfile` changes `sourceHash`, so existing storybooks regenerate instead of reusing old
prompts.

### 8.5 Custom backend

`src/backends/planner.js`:

- Endpoint resolution: a URL ending in `/chat/completions` is used as-is; a URL ending in `/vN` gets
  `/chat/completions`; anything else gets `/v1/chat/completions`.
- Sends a standard chat completions body (`model`, `messages`, `temperature`, `max_tokens`, `stream: false`).
- Requires the API key from `localStorage`; errors are surfaced with status and a short body excerpt.
- Accepts string content, content-part arrays, or `choice.text`.

---

## 9. Image backend

`src/backends/image.js` uses the registered `/imagine` slash command rather than calling an image API
directly:

- Requires `ctx.SlashCommandParser.commands.imagine.callback`.
- `buildImageRequest()` resolves the exact prompt, merged negative, width and height. `generateImage()`
  reuses that request for the `/imagine` arguments `quiet`, `gallery`, `extend: 'false'`,
  `_abortController`, `negative`, and `width`/`height` unless the size preset is `st`.
- Negatives are always merged and deduped: built-in illustration negatives, selected profile
  negatives, then `settings.negative`.
- `runJob` records `buildImageRequest()` in the session debug trace before invoking `/imagine`, so failed
  calls still show the request that was attempted.
- Bridges the pipeline's `AbortSignal` to a local `AbortController`.
- Throws `AbortError` after the call if the request was cancelled.
- Throws a `systemic` error when nothing is returned.

`describeImageBackend()` reports the configured source and model, or a clear error when the extension or
command is unavailable.

---

## 10. UI layer

### 10.1 Shared view (`src/view.js`)

Both display modes render the same markup:

- `buildStorybookView(mesId, storybook, { variant })` returns a `.storybook-root` with
  `data-storybook-mes`, `data-storybook-variant` and `data-status`. It contains the status/progress header,
  an expand action, an optional error banner, the frame track, navigation arrows, dots and the active caption.
  Regenerate/cancel actions are rendered only for the inline variant; the floating window uses its toolbar.
- `mountStorybookView(view, mesId)` inserts the view into a host element, binds image load/error state and
  the track scroll listener, then centers the active frame.
- The `activeIndex` map is module-scoped and shared by both hosts, so switching display modes keeps the frame.
- `resolveActive()` prefers the first pending frame while generating, otherwise the first ready frame.

All interaction is delegated from `document`:

- `expand` / clicking a ready frame -> `openLightbox`
- `regen` -> forced enqueue
- `cancel` -> `cancelJob(mesId)`
- `prev` / `next` / dots -> `applyActive` and `scrollTrackTo`

The scroll listener snaps the active index to the frame closest to the centre after a 90 ms debounce.
`scrollTrackTo()` sets `track._storybookScrollLock` for 800 ms so the smooth programmatic scroll does not
snap the active frame back.

### 10.2 Floating window (`src/window.js`)

The default display. Two elements are appended to `<body>`:

- `#storybook-window` - header (grip, title/subtitle, progress, prev/next, collapse, close), toolbar
  (Illustrate/Regenerate, Stop, Remove, optional Debug), optional debug panel, body, footer (jump to message)
  and a bottom-right resize handle. `z-index: 2000`.
- `#storybook-fab` - floating book button shown when the window is closed. `z-index: 1999`.

Behavior:

- `opened` starts as `true`; the window opens automatically when a chat is rendered or loaded.
- Selection order: the saved `storybook_window_selection[chatKey]` message id, then the storybook with the
  newest `updatedAt`, then the last illustratable reply.
- `chatKey()` uses `ctx.getCurrentChatId()`, or `unsaved:<send_date>` for a chat without a file yet.
- The subtitle reads `Assistant · reply X of Y`, where `Y` counts illustratable replies, not all messages.
- The empty state shows a clipped reply excerpt and an **Illustrate this reply** button (forced enqueue if a
  storybook already exists).
- Toolbar actions always target `selectedMesId`: generate/regenerate is disabled while that reply is busy,
  Stop is enabled only while busy, and Remove requires an existing storybook. The generate label switches
  between Illustrate and Regenerate.
- The debug button appears only when `settings.showDebugTools` is true. Opening it shows three tabs:
  planner request, planner raw response/shaped plan, and compiled image prompts/negatives/sizes. The panel is
  session-only and can run **Test planner** without touching the current storybook.
- Header drag and handle resize are pointer-capture based. `storybook_window_layout`
  (`{left, top, width, height, collapsed}`) is saved in `localStorage` and clamped to the viewport on restore.
- Collapsing hides the toolbar, debug panel, body/footer and keeps only the header.
- `tick()` runs after 350 ms and then every 1200 ms. It detects a chat that was already open before the
  extension activated, notices chat-key changes, and re-renders.
- Bus events: `story:update`, `story:job`, `story:complete` (adds the FAB badge while closed) and
  `story:debug` (refreshes the open debug panel).
- SillyTavern events: `CHARACTER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_EDITED`, `MESSAGE_DELETED`,
  `CHAT_LOADED`, `CHAT_CHANGED`.
- `Escape` closes the window only when the lightbox is not open.
- On screens narrower than 700 px the window becomes a bottom sheet.

### 10.3 Legacy inline carousel (`src/carousel.js`)

Only active when `settings.showInline` is true. `renderMessage(mesId)` finds `.mes[mesid] .mes_block` and
inserts the shared view after `.mes_text`; `renderAll()` iterates rendered messages. The old per-message book
button (`.storybook_gen`) is gone; `removeLegacyButtons()` cleans it up after an upgrade. The module listens
for `story:update`, `story:job` and `story:settings` and skips stale storybooks.

### 10.4 Lightbox (`src/lightbox.js`)

A single lazily created `#storybook-lightbox` (`z-index: 5000`) shows the frame, title, caption and an
expandable image-prompt panel. The header can be dragged, `Esc` closes, and `←`/`→` navigate. Its keyboard
listener is registered before the window's listener and calls `stopImmediatePropagation()`, so closing the
viewer with `Esc` never closes the window behind it.

### 10.5 Debug traces (`src/debug.js`)

`src/debug.js` keeps up to 20 in-memory traces keyed by `chatId::mesId`; nothing is written to chat metadata,
settings or `localStorage`. The trace stores:

- `request` - system prompt, user prompt and transport metadata.
- `attempts` - each structured, plain-text or custom planner attempt, including raw text and parse result.
- `errors` - planner failures.
- `plan` - shaped frames plus `compileImagePromptDetailed` output.
- `images` - the exact `buildImageRequest` result recorded by `runJob` per frame.

`recordPlannerRequest()` starts a fresh trace for a reply. The debug panel reads it synchronously and refreshes
on `story:debug`. **Clear** removes only the current reply's trace; a page reload clears everything.

---

## 11. Persistence and saving

- `saveSoon(delay = 600)` debounces a save; each call resets the timer.
- `saveNow()` clears the timer and awaits `ctx.saveChat()` (`saveChatConditional` in SillyTavern).
- Saves are triggered when artwork is created/updated, when stale artwork is removed, and when the user
  clears a storybook.

Caveat: SillyTavern's `saveChat` returns early for chats without a selected character or for the neutral
chat, so artwork in such a chat is not persisted. Group chats go through `saveGroupChat` via
`saveChatConditional`, which is supported.

Browser-only UI state (never written into the chat):

- `storybook_window_layout` - window position, size and collapsed flag.
- `storybook_window_selection` - `{ [chatKey]: messageId }` for the window's selected reply.
- `storybook_custom_api_key` - custom planner key (see §12).

---

## 12. Settings management

- `getSettings()` returns `extensionSettings.storybook`, creating and merging defaults as needed.
- `saveSettings()` calls `ctx.saveSettingsDebounced()`.
- Every bound control updates settings, saves, calls `syncDependentUI()`, and emits `STORY_EVENTS.SETTINGS`.
- `refreshSettingsUI()` writes current settings back into the DOM (used on boot and after prompt reset).
- `updateStatsUI()` counts storybooks and ready images in the current chat plus session counters.
- The API key input only writes to `localStorage`; it is never persisted in settings.

---

## 13. Internal event bus

`src/bus.js` is synchronous and scoped to the extension:

| Event | Payload | Consumers |
| --- | --- | --- |
| `story:update` | `{ mesId }` | Window and carousel re-render, stats |
| `story:job` | job state | Window/carousel running indicators |
| `story:stats` | - | Reserved |
| `story:complete` | `{ mesId }` | Window re-render or FAB badge |
| `story:open` | `{ mesId, index }` | Reserved |
| `story:settings` | `{ id, value }` | Carousel visibility, status labels, stats and window debug visibility |
| `story:debug` | `{ chatId, mesId }` | Open window debug panel refresh |

This is separate from SillyTavern's `eventSource`.

---

## 14. SillyTavern integration notes

These behaviors are easy to get wrong, so they are documented here for future changes:

1. **`getContext()` returns a fresh object each call.** Monkey-patching `ctx.generateRaw` does not persist.
   Patching `ctx.SlashCommandParser.commands.imagine.callback` does, because the command registry is a
   module singleton.
2. **`extra` is cloned across swipes.** Always write through `syncStorybook`/`mirrorToSwipe`, and re-link
   before mutating.
3. **`saveReply` can clone a stale storybook into a new swipe slot.** Staleness is therefore checked
   synchronously in `CHARACTER_MESSAGE_RENDERED` and in `MESSAGE_SWIPED`.
4. **Greeting rendering is not creation.** `first_message` fires whenever a chat has exactly one message
   after loading; `CHAT_CREATED`/`GROUP_CHAT_CREATED` indicate actual creation.
5. **Group event order is reversed** relative to character chats (see §6.2).
6. **`CHAT_CHANGED` fires before `CHAT_CREATED`** for character chats, and after member greetings for groups.
7. **Chat switches do not immediately free `currentJob`.** Cancellation marks and aborts it; the slot frees
   when `runJob` returns. The enqueue guard accounts for this.
8. **`ctx.saveChat` is `saveChatConditional`**, and `saveChat` may return early (see §11).

---

## 15. Maintenance recipes

### Add a setting

1. Add the default in `src/defaults.js`.
2. Add markup in `settings.html` with a stable id (`storybook_*`).
3. Bind it in `bindSettingsControls()` (checkbox/input/select helper).
4. Write it in `refreshSettingsUI()`.
5. If it affects layout/visibility, extend `syncDependentUI()`.
6. If it must invalidate generated artwork, include it in `sourceHashFor` inputs and bump the `'v2'` marker
   in `src/persistence.js` so existing storybooks are regenerated rather than silently reused.

### Add a planner backend

1. Implement a function in `src/backends/` that returns raw model text.
2. Branch on `settings.plannerBackend` in `requestPlan` (`src/planner.js`).
3. Extend `describePlannerBackend` with status text and validation.
4. Add UI options and bind them in `src/settings.js`.

### Change the storyboard schema

1. Update `DEFAULT_PLANNER_PROMPT` and `PLANNER_SCHEMA` together.
2. Update `shapeKeyframes` to normalize any new fields.
3. Update `src/view.js` rendering if the field is displayed.
4. Bump `sourceHashFor`'s version marker so old storybooks regenerate.

### Add a new size preset

Add an entry to `SIZE_PRESETS` in `src/defaults.js`, add an `<option>` to `settings.html`, and keep the
`st` preset (`null` width/height) as the pass-through option.

---

## 16. Manual test checklist

Before releasing:

1. Hard refresh and confirm `[Storybook] extension ready.` in the console.
2. **Test image generation** returns an image.
3. Enable **Show debug tools in the floating window**, run **Debug -> Test planner**, and confirm the request,
   raw response and compiled image prompts appear.
4. Window toolbar Illustrate/Regenerate, Stop and Remove all act on the selected reply.
5. Fresh single-character chat: the greeting gets a storybook exactly once.
6. Reopen the same chat: no new images are generated.
7. The floating window opens automatically and shows the newest storybook attached to the chat.
8. Header arrows move between illustrated replies; the selection survives a reload.
9. Drag, resize and collapse the window; close it, reopen it from the floating button, then reload and confirm
   the layout is restored.
10. Normal reply with every-reply trigger: the window renders and reaches `Ready`.
11. Enable **Show the inline carousel under messages**: the under-message root appears. Disable it again: the
   root disappears and the window remains.
12. Swipe: artwork follows the variant; a new variant is illustrated only when enabled.
13. Edit the text: stale artwork is removed.
14. Interval trigger with `N = 2`: frames appear on the 2nd and 4th replies.
15. Switch chats mid-generation: job becomes `cancelled` and no artwork lands in the new chat.
16. Failed regeneration keeps the previous images visible.
17. `/storybook`, `/storybook force=true count=2`, and `/storybook cancel=true`.
18. Create a group chat: every member greeting is illustrated.
19. Reload and reopen a chat: the window and captions are restored from disk and no old book buttons appear.

---

## 17. Known limitations

- Image output is tied to SillyTavern's `/imagine` command and the built-in Image Generation extension.
- Keyframe planning depends on the selected chat model's ability to return usable JSON. A custom planner
  backend is the escape hatch.
- Hashes are cheap and non-cryptographic; they are identity checks, not security features.
- A chat with no selected character (neutral chat) cannot be persisted by SillyTavern, so storybooks there
  are session-only.
- Group greetings are all illustrated on creation, which can queue several generations at once (they run
  serially).

---

## 18. Security and privacy

- The custom planner API key is stored in `localStorage` under `storybook_custom_api_key` and is sent only to
  the configured base URL.
- No telemetry and no third-party requests beyond the configured planner endpoint.
- Storybook data is written into the normal SillyTavern chat file (`extra.storybook`), so it is covered by
  your existing chat backups and sharing behavior.
- Generated image URLs are returned by SillyTavern and are not uploaded anywhere by this extension.

---

## 19. Versioning

The extension version is defined in `manifest.json` (`"version"`). Update it together with
`VersionLog.md` for every user-visible change. The storybook payload has its own `v` field and
`sourceHashFor` has a version marker for data-shape changes.
