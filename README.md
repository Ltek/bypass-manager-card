# Bypass & Timer Manager Card

A Home Assistant Lovelace card that **automatically discovers** your bypass `input_boolean` and `timer` entities, pairs them by matching suffix, and groups them into sections by type.

---

## How it works

The card scans all entities at runtime and:

1. Finds every `input_boolean.bypass_*` and `timer.bypass_*` entity
2. Pairs them by **identical suffix** — `input_boolean.bypass_FOO` + `timer.bypass_FOO`
3. Unpaired entities still appear — a solo boolean shows as a toggle-only row, a solo timer shows with Start/Cancel but no toggle
4. Groups rows into sections by keyword in the entity ID:

| Keyword in suffix | Section |
|-------------------|---------|
| `motion`          | Motion  |
| `door`            | Door    |
| `window`          | Window  |
| `light`           | Light   |
| *(none)*          | Other   |

Labels are derived automatically from the suffix — no configuration required.

---

## Installation

### Manual (recommended for now)

1. Copy `bypass-manager-card.js` to:
   ```
   /config/www/community/bypass-manager-card/bypass-manager-card.js
   ```
2. In HA → Settings → Dashboards → Resources, add:
   - URL: `/local/community/bypass-manager-card/bypass-manager-card.js`
   - Type: `JavaScript Module`
3. Hard refresh your browser (Ctrl+Shift+R)

### HACS

1. HACS → Frontend → ⋮ → Custom repositories
2. Add this repo URL, category **Lovelace**
3. Install **Bypass & Timer Manager Card**
4. Hard refresh your browser

---

## Usage

```yaml
type: custom:bypass-manager-card
```

No further configuration needed — entities are discovered automatically.

### Optional config

```yaml
type: custom:bypass-manager-card
title: My Bypass Manager   # Override card title (default: "Bypass Manager")
```

---

## Timer input formats

| Input   | Duration    |
|---------|-------------|
| `30`    | 30 minutes  |
| `30m`   | 30 minutes  |
| `90s`   | 90 seconds  |
| `1h`    | 1 hour      |
| `1h30m` | 1.5 hours   |
| `2m30s` | 2.5 minutes |

---

## Entity naming convention

```
input_boolean.bypass_<type>_<name>
timer.bypass_<type>_<name>
```

Where `<type>` is one of `motion`, `door`, `window`, `light` (or omit for Other).

**Examples:**
```
input_boolean.bypass_motion_driveway  ←→  timer.bypass_motion_driveway
input_boolean.bypass_door_garage      ←→  timer.bypass_door_garage
input_boolean.bypass_alarm_zones      ←→  timer.bypass_alarm_zones
```

Timers are optional per entity — booleans without a matching timer appear as simple toggle rows. Timers without a matching boolean appear as timer-only rows.
