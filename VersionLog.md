# Version Log

All notable changes to Storybook are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

---

## [1.1.1] - 2026-10-23

### Added

- Built-in style profiles: **Default**, **Anime**, **Photorealistic** and **Painterly**. Each supplies
  style tags, illustration subject tags, style text and matching negatives. Default is selected out of
  the box and adds no positive quality tags.
- Always-on illustration negatives covering text, captions, UI, watermarks, panels, collages, grids,
  duplicated or extra anatomy, low quality and blur.

### Changed

- The planner now receives a `STYLE` block built from the selected profile and the additional style.
- Image prompts are composed as profile tags, profile subject tags, profile style text, additional user
  style, character anchor and frame prompt, then capped at 1500 characters while protecting the style and
  anchor.
- Additional user style is deduped against the selected profile before being appended.
- The storybook settings snapshot and `sourceHash` now include `styleProfile`, invalidating old prompt
  compilations.
- The settings drawer labels the freeform field **Additional style** and adds a **Style profile** dropdown.
- README and Technical reference updated for style profiles and prompt composition.

### Fixed

- Character anchors are no longer duplicated when the planner already included the anchor in a frame's
  image prompt.

---

## [1.1.0] - 2026-10-22

### Added

- Floating Storybook window as the default display. It opens automatically for the reply you are browsing
  and can be dragged, resized and collapsed.
- Per-chat window selection, remembered in `localStorage`, plus header buttons to step through illustrated
  replies and jump back to the source message.
- Floating book button that reopens the window after it is closed and shows a badge when new artwork is ready.
- Window layout persistence and a **Reset window position** action in the settings drawer.
- Mobile bottom-sheet layout for narrow screens.
- **Show the inline carousel under messages** setting for the legacy display, off by default.

### Changed

- The window is now the primary way to view, regenerate and clear storybooks.
- The full-screen viewer, frame navigation, captions and prompt panel are shared by both display modes.
- Window layout and selection are stored in the browser, never in the chat file.
- README and Technical reference updated for the new display model.

### Removed

- The per-message book button (`.storybook_gen`) in the message action row. All actions now live in the
  window.

### Fixed

- Closing the full-screen viewer with `Esc` no longer closes the Storybook window behind it.
- Clicking next/previous no longer snaps back to the old frame while the track is smooth-scrolling.

---

## [1.0.0] - 2026-10-22

First public release.

### Added

- Automatic storybook generation for assistant replies, with 1-6 keyframes per reply.
- Inline carousel under each illustrated message: frame track, navigation arrows, page dots, captions and
  per-frame status.
- Full-screen viewer with keyboard navigation (`←` / `→`), `Esc` to close, draggable window, and an
  expandable image-prompt panel.
- Per-message action button to generate or regenerate a storybook on demand.
- Slash command `/storybook` with `force`, `count` and `cancel` arguments.
- Trigger modes: every assistant reply, every N replies, and manual only.
- Optional illustration of new swipe variants.
- Storyboard planner using the SillyTavern chat API, with an optional custom OpenAI-compatible backend.
- Character consistency via a reusable character anchor plus optional character description, personality,
  scenario and user persona.
- Global style and negative prompt fragments applied to every image.
- Image size presets: portrait, landscape, square, or follow the Image Generation settings.
- Optional "save to character gallery" and "open viewer on finish".
- Persistent per-message and per-swipe storage in `extra.storybook`.
- Automatic removal of artwork when the message text changes (edit or swipe).
- Failure recovery that keeps previously rendered artwork when a regeneration fails.
- Status and statistics readout in the settings drawer.
- Built-in planner prompt, JSON schema for structured output, and a "Test the planner" helper.

### Fixed

- Editing a message now removes artwork that belonged to the previous text, matching the swipe behavior.
- Greetings are illustrated only when a chat is actually created, so reopening an old chat no longer spends
  image credits.
- Group chat greetings are illustrated correctly even though SillyTavern announces the group after rendering
  the member greetings.
- A cancelled job that was still winding down no longer blocks a new generation for the same message after a
  chat switch.

### Documentation

- Added `README.md` with setup, usage and troubleshooting.
- Added `Technical.md` with architecture, data model, event flow and maintenance guidance.
- Added this `VersionLog.md`.

---

## Unreleased

- Nothing yet.
