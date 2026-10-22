# Storybook

A SillyTavern extension that turns each assistant reply into a small illustrated storybook:
a storyboard planner splits the reply into keyframes, an image model renders each one, and the
frames appear in an inline carousel under the message with a full-screen viewer.

- Original code, MIT licensed.
- Uses only public SillyTavern APIs.
- Works with the built-in **Image Generation** extension (and an optional custom, OpenAI-compatible planner API).

---

## Features

- **Per-reply storybooks**: 1 to 6 keyframes rendered for a single assistant message.
- **Inline carousel**: swipeable frames, page dots, captions and per-frame status under the message.
- **Full-screen viewer**: click a frame to open it, navigate with `←` / `→`, close with `Esc`, drag the window by its header.
- **Persistent and per-swipe**: artwork is stored on the message and on the active swipe variant, so it survives reloads and follows the variant it belongs to.
- **Automatic invalidation**: edited or swiped-away text drops the old artwork instead of showing a mismatch.
- **Trigger modes**: every reply, every N replies, or manual only.
- **Character consistency**: a reusable character anchor plus optional character card fields keep faces and outfits stable across frames.
- **Planner choices**: use the SillyTavern chat API, or a separate OpenAI-compatible endpoint.
- **Recovery from failures**: failed regenerations keep the previous artwork; a stopped job is marked as stopped rather than losing frames.
- **Privacy**: the custom planner API key never leaves the browser and is not written into the chat or settings file.

---

## Requirements

- A working SillyTavern installation.
- The built-in **Image Generation** extension enabled and configured (the extension calls the `/imagine` slash command).
- A chat model for storyboard planning, or a custom OpenAI-compatible API if you prefer a separate model.

No build step and no external dependencies are required.

---

## Installation

1. Copy or clone this folder into your SillyTavern extensions directory:

   ```
   SillyTavern/public/scripts/extensions/third-party/Storybook
   ```

   For example:

   ```bash
   cd SillyTavern/public/scripts/extensions/third-party
   git clone https://github.com/Mezi99/SillyTavern-Storybook.git Storybook
   ```

2. Reload SillyTavern (hard refresh the browser).
3. Open **Extensions** and find the **Storybook** drawer.
4. Enable **Image Generation** in SillyTavern if you have not already, then configure a source and model.
5. Use **Test the planner** and **Test image generation** in the Storybook drawer to confirm both halves work.

---

## Quick start

1. Open a character or group chat.
2. In the Storybook drawer, set **Generate when** to *Every assistant reply*.
3. Optionally add a **Character anchor** such as `young woman, shoulder-length black hair, green eyes, grey coat`.
4. Send a message. A **Storybook** carousel appears under the reply as frames render.
5. Click any finished frame to open the viewer, or use the book button in the message's action row to generate or regenerate on demand.

---

## Settings

| Setting | What it does |
| --- | --- |
| Enable automatic storybook generation | Master switch for automatic triggers. Manual generation still works. |
| Also illustrate new swipes | Render a storybook for each new swipe variant. |
| Open the viewer when a storybook is ready | Opens the full-screen viewer when generation finishes. |
| Save generated images into the character gallery | Passes the gallery flag to SillyTavern Image Generation. |
| Generate when | `Every assistant reply`, `Every N assistant replies`, or `Only when I ask`. |
| Reply interval | The `N` used by the interval trigger. |
| Keyframes per reply | Number of frames per storybook (1-6). |
| Image size | Portrait 832x1216, Landscape 1216x832, Square 1024x1024, or follow the Image Generation settings. |
| Character anchor | Reusable appearance string placed at the front of every image prompt. |
| Style | Global look and feel prepended to every image prompt. |
| Negative prompt | Appended to every generation request. |
| Previous messages given to the planner | How many earlier messages are included as context. |
| Character card fields | Include description, personality, scenario and user persona in the planner input. |
| Storyboard planner | SillyTavern chat API or a custom OpenAI-compatible API. |
| Base URL / Model / API key / Temperature / Max tokens | Custom planner connection. The API key is stored only in this browser. |
| Planner prompt | Overrides the built-in storyboard prompt. Leave empty to use the built-in one. |

The drawer also contains utility buttons:

- **Generate for the last reply**
- **Stop the running job**
- **Remove storybook from the last reply**
- **Test the planner** (shows the returned JSON in the preview area)
- **Test image generation**
- **Show Image Generation settings**

---

## Slash command

```
/storybook [force=true] [count=3] [cancel=true]
```

- No arguments: illustrate the last assistant message with the configured settings.
- `force=true`: regenerate even if a finished storybook already exists.
- `count=N`: use `N` keyframes for this run (1-6).
- `cancel=true`: stop the running generation.

The command reports what it did, for example `Storybook generation started with 3 keyframes.`

---

## When does a storybook appear?

- **Every assistant reply**: normal replies, appends, continue and similar assistant render types.
- **Greeting**: only while a chat is being created, never when an old chat is reopened. This avoids spending image credits every time you open a chat.
- **Group chats**: when a group is created, every member greeting is illustrated.
- **Swipes**: only when *Also illustrate new swipes* is enabled.
- **Interval**: every `N` assistant replies since the last illustrated reply.
- **Manual**: only through the button or the slash command.
- **User and system messages** are never illustrated.

---

## How artwork is stored

Each storybook lives in the message's `extra.storybook` field and is mirrored into
`swipe_info[swipe_id].extra.storybook`. SillyTavern clones `extra` when swiping, so the extension keeps
both copies linked. This means:

- Artwork survives a page reload and a returned chat.
- Artwork follows the swipe variant it was generated for.
- Editing or swiping to different text removes the mismatched artwork automatically.

Nothing is written outside the chat file, except the custom planner API key, which is kept in the
browser's `localStorage`.

---

## Troubleshooting

**The planner fails or returns no JSON**
Use **Test the planner**. Some models need a stricter prompt or a JSON-capable model. You can also
point the planner at a different API with a model known to follow instructions.

**`The /imagine command is unavailable`**
Enable SillyTavern's built-in Image Generation extension and configure a source and model once. The
extension uses that extension rather than talking to image APIs directly.

**Images never finish**
Open SillyTavern's Image Generation settings (**Show Image Generation settings**) and run a manual
generation there. If that fails, the Storybook cannot succeed either.

**A storybook disappeared after editing or swiping**
That is intentional: the artwork belonged to a different text variant. Generate again on the current
variant.

**Custom planner API errors**
Check the base URL. A plain host, `/v1`, or a full `/chat/completions` URL are all accepted. The API key
must be entered in the Storybook drawer of the same browser profile.

---

## Project layout

```
index.js              Extension entry point: init, event wiring, settings/actions, triggers
manifest.json         SillyTavern extension manifest
settings.html         Settings drawer markup
style.css             Carousel, viewer and settings styling
src/
  bus.js              Tiny internal event bus
  carousel.js         Inline carousel, message buttons and full-screen viewer
  commands.js         /storybook slash command
  context.js          SillyTavern context helpers, planner input, chat helpers
  defaults.js         Default settings, size presets, planner prompt and JSON schema
  persistence.js      Storybook storage, swipe mirroring, hashes, save helpers
  pipeline.js         Job queue, generation pipeline, cancellation, dedup
  planner.js          Storyboard planning and prompt compilation
  settings.js         Settings storage/binding, custom API key, stats
  backends/
    image.js          Image Generation backend via the /imagine command
    planner.js        Custom OpenAI-compatible planner backend
```

---

## Documentation

- [Technical.md](Technical.md) - architecture, data model, event flow and maintenance notes.
- [VersionLog.md](VersionLog.md) - version history.

---

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 MeziMars.
