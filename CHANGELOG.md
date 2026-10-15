# Changelog

## v2026.10.15.36

**New**
- **Edit helpers from the card** (`allow_edit`). An **Edit** chip in the Manage section puts a ✏️ on each
  row. It opens an inline form for the row's switch (`input_boolean`) and timer:
  - **Switch:** name, icon, and state at startup (last state / on / off).
  - **Timer:** name, icon, length, and restore after restart.
  - **Entity ID:** renames the switch and timer together, so they stay paired. A live preview shows each
    rename and blocks IDs already in use. It's also how you pair an unpaired helper: give it its partner's ID.
- Like Create and Delete: off by default, admins only, YAML helpers locked.

**Fixed**
- Typed times accept any h / m / s mix and H:MM[:SS]. Before, a time like `1h 05m 30s` (the way the card
  shows it) couldn't be typed back in.

## v2026.10.15.35

**New**
- **Unpaired helpers** (`show_unpaired`). A collapsible section at the bottom of the card (starts collapsed)
  lists every bypass switch with no timer and every timer with no switch. The header shows how many, and how
  many have a possible match.
- **Possible match:** for each one, the card looks through the other kind of helper (including ones outside
  your prefix) for a name that looks like it belongs, and says why: *same words, different order*
  (`door_front` / `front_door`), *same words, different prefix or wording* (`bypass_windows` / `window`),
  *similar spelling* (`bathroom` / `bathrom`) or *shares door, front*. It also shows the exact ID the
  pairing rule expects, so you know what to rename. Tap any ID for its details.
- The section hides itself when everything is paired, and updates when a look-alike helper appears.
- Setting: Rows & timer controls → **Unpaired helpers**, with a live count.

## v2026.10.15.34

**New**
- **Group by area** (`group_by: area`). Rows group by their Home Assistant area instead of by type: the
  switch's area, else the timer's (an entity's own area, else its device's). Bypasses without an area go in
  **No area**, listed last; the rest are by name.
- Areas get the same row controls as type groups: ↑ / ↓ order (`area_order`), show / hide (`hidden_areas`)
  and start open or collapsed (`collapsed_areas`). These are kept apart from the type settings, so switching
  between the two loses nothing.
- Creating a helper while grouping by area adds an **Area** picker; the new helper is put in that area.

**Settings**
- **Group rows** is now one choice in Groups & order: By type, By area, or Don't group (one list).

## v2026.10.15.33

**New**
- **Create helpers from the card** (`allow_create`). A **Manage** section under the title (starts collapsed) has
  chips for **Timer**, **Switch** and **Matched set** (both). Pick a group, type a name and a timer length;
  the card names it the way it reads names: group **Door** + "Patio" → `bypass_door_patio`. A name that
  already has a group word keeps it ("Office light" → `bypass_office_light`). A live preview shows the entity
  IDs, the group it lands in, any existing switch or timer it pairs with, and blocks names already in use.
  In label mode the new helper also gets the label.
- **Delete helpers from the card** (`allow_delete`). The **Delete** chip puts a trash button on each row; tap it
  and choose Timer, Switch or Both. Helpers set up in YAML show a lock instead.
- Both are off by default and only appear for admin users (Home Assistant only lets admins create or delete helpers).
- **Collapsible groups** (`collapsible_groups`): tap a group title to fold it. A folded group still shows how
  many of its bypasses are on. Each group can start open or collapsed (`collapsed_groups`).

**Settings**
- **Groups & order** is now a list of group rows: ↑ / ↓ set the order (`group_order`), the eye shows or hides
  the group, and with collapsible groups on, the chevron sets whether it starts open or collapsed.
  "↺ Default order" puts the order back.
- New **Create & delete** panel.
- Renaming a custom group keeps its order, visibility and start state.

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
