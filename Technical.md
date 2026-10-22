# Storybook - Technical Reference

This document describes how the extension is built, how it talks to SillyTavern, and what to watch
out for when maintaining it. It targets version **1.0.0**.

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
| `style.css` | Carousel, viewer, status pills and settings styling. |
| `src/bus.js` | Minimal synchronous event bus for intra-extension events. |
| `src/context.js` | Context access, chat helpers, planner input assembly, hashing, size resolution. |
| `src/defaults.js` | Default settings, `MODULE_NAME`, `SETTINGS_KEY`, size presets, trigger enum, built-in prompt, JSON schema. |
| `src/settings.js` | Settings load/merge/save, UI binding, stats, custom API key. |
| `src/persistence.js` | Storybook get/set/sync, swipe mirroring, hashes, stale detection, save helpers. |
| `src/planner.js` | Planner orchestration, response parsing, prompt compilation, keyframe shaping. |
| `src/backends/planner.js` | Custom OpenAI-compatible planner HTTP client. |
| `src/backends/image.js` | Image generation via SillyTavern's `/imagine` command. |
| `src/pipeline.js` | Job queue, generation state machine, cancellation, dedup guard. |
| `src/carousel.js` | Inline carousel, message action button, full-screen viewer. |
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
8. `initCarousel()` - binds delegated DOM handlers and bus listeners.
9. `registerEvents()` - subscribes to SillyTavern events.
10. `refreshSettingsUI()`, `updateStatusLabels()`, `updateStatsUI()`.
11. A delayed `renderAll()` (400 ms) catches a chat that was already open.

`BASE_URL` in `src/context.js` is derived from `import.meta.url`, so `settings.html` resolves regardless
of the install folder name.

---

## 4. Module dependency graph

```
index.js
  -> src/bus, src/context, src/defaults, src/settings, src/pipeline,
     src/carousel, src/commands, src/backends/image, src/planner,
     src/backends/planner, src/persistence

src/pipeline
  -> src/bus, src/context, src/settings, src/planner,
     src/backends/image, src/persistence

src/carousel
  -> src/bus, src/context, src/persistence, src/pipeline

src/planner
  -> src/defaults, src/context, src/settings, src/backends/planner
```

There are no circular imports that affect evaluation order. `settings.js` imports the context only,
and the pipeline/carousel import settings one-way.

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
| `openLightboxOnFinish` | boolean | Open viewer on completion. |
| `size` | preset key | `portrait`, `landscape`, `square`, `st`. |
| `saveToGallery` | boolean | Passed to `/imagine`. |
| `include` | object | Character card fields to include. |
| `contextMessages` | number | Prior messages passed to the planner. |
| `anchor`, `styleText`, `negative` | string | Prompt fragments. |
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
  "sourceHash": "…",        // text + count + style + anchor + prompt + size + "v1"
  "textHash": "…",          // hash of the message text only
  "status": "planning",     // planning | generating | ready | partial | error | cancelled
  "createdAt": 0,
  "updatedAt": 0,
  "anchor": "…",
  "backend": { "kind": "st", "text": "…" },
  "planner": { "api": "…", "backend": "st|custom" },
  "settings": { "count": 3, "size": "portrait", "styleText": "…", "negative": "…" },
  "keyframes": [
    {
      "i": 0,
      "title": "…",
      "caption": "…",
      "prompt": "…",          // compiled: style, anchor, raw prompt
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

`buildUserPrompt` emits blocks in this order: `CONTEXT`, `LATEST STORY`, `CHARACTER`, `PERSONA`.

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
5. Each frame prompt is compiled by `compileImagePrompt`: `style, anchor, imagePrompt`.
6. Throws `The storyboard planner returned no usable keyframes.` or
   `The storyboard planner did not return JSON...` with actionable text.

`responseLengthFor(count)` = `min(4096, 600 + count * 520)`.

### 8.4 Custom backend

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
- Arguments: `quiet`, `gallery`, `extend: 'false'`, `_abortController`, optional `negative`, and
  `width`/`height` from `resolveSize(settings)` unless the size preset is `st`.
- Bridges the pipeline's `AbortSignal` to a local `AbortController`.
- Throws `AbortError` after the call if the request was cancelled.
- Throws a `systemic` error when nothing is returned.

`describeImageBackend()` reports the configured source and model, or a clear error when the extension or
command is unavailable.

---

## 10. UI layer

### 10.1 Rendering

`renderMessage(mesId)`:

- Finds `.mes[mesid="<id>"] .mes_block`; skips non-illustratable messages.
- Ensures the per-message action button (`.storybook_gen`) exists.
- Inserts a `.storybook-root` after `.mes_text`, replacing any previous root.
- Binds image load/error state for the loading shimmer.

`renderAll()` iterates rendered messages.

`buildRoot()` renders the header (status, progress, expand/regenerate or cancel), an optional error banner,
the scrollable frame track, navigation arrows, dots and the active caption.

`resolveActive()` keeps a per-message active index, prefers the first pending frame while generating, then
the first ready frame.

### 10.2 Interaction

All interaction is delegated from `document`:

- `expand` -> `openLightbox`
- `regen` -> forced enqueue
- `cancel` -> `cancelJob(mesId)`
- `prev`/`next`/dots -> `applyActive`
- clicking a ready frame -> `openLightbox`

The lightbox is lazily created once, supports header dragging, `Esc` to close, `←`/`→` to navigate, and a
details block showing the image prompt.

The track listens for scroll and snaps the active index to the frame closest to the centre (debounced
90 ms).

### 10.3 Message action button

`ensureMessageButton()` prepends a book button to `.extraMesButtons`. Its title and icon reflect whether a
job is running, a storybook exists, or nothing exists yet. Forced enqueue happens on click.

---

## 11. Persistence and saving

- `saveSoon(delay = 600)` debounces a save; each call resets the timer.
- `saveNow()` clears the timer and awaits `ctx.saveChat()` (`saveChatConditional` in SillyTavern).
- Saves are triggered when artwork is created/updated, when stale artwork is removed, and when the user
  clears a storybook.

Caveat: SillyTavern's `saveChat` returns early for chats without a selected character or for the neutral
chat, so artwork in such a chat is not persisted. Group chats go through `saveGroupChat` via
`saveChatConditional`, which is supported.

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
| `story:update` | `{ mesId }` | Carousel re-render, stats |
| `story:job` | job state | Carousel running indicators and message buttons |
| `story:stats` | - | Reserved |
| `story:complete` | `{ mesId }` | Reserved |
| `story:open` | `{ mesId, index }` | Carousel viewer |
| `story:settings` | `{ id, value }` | Status labels and stats in `index.js` |

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
6. If it must invalidate generated artwork, include it in `sourceHashFor` inputs and bump the `'v1'` marker
   in `src/persistence.js` so existing storybooks are regenerated rather than silently reused.

### Add a planner backend

1. Implement a function in `src/backends/` that returns raw model text.
2. Branch on `settings.plannerBackend` in `requestPlan` (`src/planner.js`).
3. Extend `describePlannerBackend` with status text and validation.
4. Add UI options and bind them in `src/settings.js`.

### Change the storyboard schema

1. Update `DEFAULT_PLANNER_PROMPT` and `PLANNER_SCHEMA` together.
2. Update `shapeKeyframes` to normalize any new fields.
3. Update `carousel.js` rendering if the field is displayed.
4. Bump `sourceHashFor`'s version marker so old storybooks regenerate.

### Add a new size preset

Add an entry to `SIZE_PRESETS` in `src/defaults.js`, add an `<option>` to `settings.html`, and keep the
`st` preset (`null` width/height) as the pass-through option.

---

## 16. Manual test checklist

Before releasing:

1. Hard refresh and confirm `[Storybook] extension ready.` in the console.
2. **Test the planner** returns JSON and **Test image generation** returns an image.
3. Fresh single-character chat: the greeting gets a storybook exactly once.
4. Reopen the same chat: no new images are generated.
5. Normal reply with every-reply trigger: carousel renders and reaches `Ready`.
6. Swipe: artwork follows the variant; a new variant is illustrated only when enabled.
7. Edit the text: stale artwork is removed.
8. Interval trigger with `N = 2`: frames appear on the 2nd and 4th replies.
9. Switch chats mid-generation: job becomes `cancelled` and no artwork lands in the new chat.
10. Failed regeneration keeps the previous images visible.
11. `/storybook`, `/storybook force=true count=2`, and `/storybook cancel=true`.
12. Create a group chat: every member greeting is illustrated.
13. Reload and reopen a chat: carousel and captions are restored from disk.

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
