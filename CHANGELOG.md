# Changelog

## v2026.10.14.32

Made for **all** bypasses, not just security ones, and brings in everything the old Admin-dashboard
bypass table did. Existing configs keep working.

**New**
- New groups: **Lock, Scene, Alarm, Weather** (joining Motion, Door, Window, Light, Other). A bypass goes in
  the group of the first type word in its name, so `lock_front_door` is a Lock, not a Door.
- **Bypass icon** per row (`show_icon`), in the group's icon, green when on, grey when off; tap to turn
  the bypass on or off. Custom groups can set their own icon.
- **Timer buttons separately:** `show_btn_start`, `show_btn_pause`, `show_btn_stop`, `show_btn_finish`.
  "Cancel" is now called **Stop** (■).
- **Set time** (`show_timer_input`) and the **countdown** (`show_countdown`) are separate, so you can hide the
  editable time and still see a running timer count down.
- **Duration** column (`show_duration`): the timer's configured length; tap for details.
- **Order:** `sort: active` puts active bypasses first, newest change on top. `group_rows: false` gives one flat list.
- **Clock time** next to "last changed" (`show_exact_time`): "2h 5m ago · 3:41 PM".
- **Active count** on the title line (`show_active_count`: "3 active" / "All off") and an optional **glow**
  while anything is on (`glow_when_active`).
- Tap a **name** for its details (more-info).

**Settings**
- Rebuilt in the same style as the other Ltek cards: collapsible panels (Discovery, Groups & order,
  Rows & timer controls, Title, Names, Appearance), sliders for sizes, and every color is Default / Theme
  color / Custom color / Custom CSS.
- Shows how many bypasses it found, and how many are in each group.
- Settings that depend on another one only appear when that one is on.
- Changes now show in the preview straight away.

**Changed / fixed**
- `type_filters` (groups to show) is replaced by `hidden_types` (groups to hide), so new groups appear on
  their own. Old configs are converted when opened. `show_timer_controls: false` becomes the four buttons off.
- Start on a **paused** timer now resumes it. Before, it restarted from the full length.
- Clearing the title hides the title line.
- Names and titles are escaped (a `<` in a name no longer breaks the card).
- The card picks up bypasses added after the Dashboard loads.
- Under the hood: a constant stylesheet (per-card values are CSS variables on the card), live updates patch
  rows in place and are throttled.
- README: the HACS badge now uses the Dashboard category (`plugin`), so it opens the right repository.
- Removed the GitHub Actions workflow; builds are made and checked locally.

## v2026.05.23.31

Last build before this changelog. See the GitHub tags for earlier history.
