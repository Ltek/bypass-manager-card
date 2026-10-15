// Bypass & Timer Manager Card — Home Assistant Dashboard card for bypass switches + timers
// Version: v2026.10.15.33
//
// Finds every bypass input_boolean and timer (by entity-ID prefix or by HA label),
// pairs each switch with the timer of the same name, groups them by type and gives
// full timer control. Built for ALL bypasses — security zones, doors, motion, lights,
// scenes, locks, weather and anything else that follows the naming.
//
// Discovery (discovery_mode):
//   "prefix" (default) — input_boolean.<prefix>* and timer.<prefix>* (prefix default "bypass_").
//   "label"            — any input_boolean / timer carrying the given HA label.
//
// Timer states:
//   idle    → configured duration (editable), Start
//   active  → countdown, Pause / Stop / Finish
//   paused  → remaining time (editable), Start (resume) / Stop / Finish
//
// Manage (allow_create / allow_delete, admins only): a collapsible section under the title
// creates helpers over the WebSocket API (timer/create, input_boolean/create — named
// <prefix><group word>_<name>, labelled in label mode) and deletes storage helpers
// (timer/delete, input_boolean/delete by their registry unique_id). YAML helpers are locked.
//
// Groups can be reordered (group_order), hidden (hidden_types) and made collapsible
// (collapsible_groups, with collapsed_groups starting collapsed).
//
// Vanilla JS, single file. The card stylesheet is a constant (no config values are
// interpolated into it); per-card values are custom properties set inline on the
// card root. The card renders once and patches itself on every state change.

const BUILD_NUMBER = 'v2026.10.15.33';
const VERSION = BUILD_NUMBER.slice(1);
const CARD_TAG = 'bypass-manager-card';
const EDITOR_TAG = 'bypass-manager-card-editor';
const DEFAULT_TITLE = 'BYPASS & TIMER MANAGER';

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
// [label, keyword, icon, legacy]. legacy = shipped before v32: matched as a plain
// substring anywhere in the name (as it always was). Newer keywords match only at
// the start of a word, so "lock" doesn't catch "clock".
const BUILTIN_GROUPS = [
  ['Motion', 'motion', 'mdi:motion-sensor', true],
  ['Door', 'door', 'mdi:door', true],
  ['Window', 'window', 'mdi:window-open-variant', true],
  ['Light', 'light', 'mdi:lightbulb', true],
  ['Lock', 'lock', 'mdi:lock-open-variant', false],
  ['Scene', 'scene', 'mdi:palette-outline', false],
  ['Alarm', 'alarm', 'mdi:alarm-bell', false],
  ['Weather', 'weather', 'mdi:weather-windy', false],
];
const OTHER_GROUP = 'Other';
const OTHER_ICON = 'mdi:shield-off-outline';
const GROUP_ORDER = [...BUILTIN_GROUPS.map((g) => g[0]), OTHER_GROUP];
// The groups v31 knew about: what a legacy `type_filters` list could choose between.
const LEGACY_GROUPS = ['Motion', 'Door', 'Window', 'Light', 'Other'];

function customLabels(customTypes) {
  return (customTypes || []).map((t) => t && t.label).filter((l) => l && !GROUP_ORDER.includes(l));
}

function allGroups(customTypes) {
  return [...GROUP_ORDER, ...customLabels(customTypes)];
}

/** Every group in the user's order (`group_order`), then any not in it in the default order. */
function orderedGroups(c) {
  const all = allGroups(c.custom_types);
  return [...new Set([...(c.group_order || []).filter((g) => all.includes(g)), ...all])];
}

function groupIcon(label, customTypes) {
  const ct = (customTypes || []).find((t) => t && t.label === label);
  if (ct) return ct.icon || OTHER_ICON;
  const b = BUILTIN_GROUPS.find((g) => g[0] === label);
  return b ? b[2] : OTHER_ICON;
}

/** The word that puts a name in a group (null for Other). */
function groupKeyword(label, customTypes) {
  const ct = (customTypes || []).find((t) => t && t.label === label && t.keyword);
  if (ct) return slugify(ct.keyword) || null;
  const b = BUILTIN_GROUPS.find((g) => g[0] === label);
  return b ? b[1] : null;
}

/** Home Assistant's slugify, close enough for helper names: "Door Patio!" → "door_patio". */
function slugify(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** "bypass_door_patio" → "Bypass Door Patio" (Home Assistant slugifies it straight back). */
function titleWords(objectId) {
  return objectId.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * What creating a helper called `name` would make, following the naming the card reads:
 * <prefix><group word>_<name>. A chosen group adds its word unless the name already has it
 * (so "office light" stays office_light); "Auto" ('') leaves the name as typed. A typed prefix
 * is not doubled. → { suffix, objectId, name, lands, warnings[] } or null when there's no name.
 */
function planHelperName(c, rawName, group) {
  const custom = c.custom_types || [];
  const prefix = c.entity_prefix || 'bypass_';
  const ps = slugify(prefix);
  let suffix = slugify(rawName);
  if (ps && suffix.startsWith(`${ps}_`)) suffix = suffix.slice(ps.length + 1);
  if (!suffix) return null;
  const kw = group ? groupKeyword(group, custom) : null;
  if (kw && keywordPos(suffix, kw, false) < 0) suffix = `${kw}_${suffix}`;
  const objectId = slugify(`${prefix}${suffix}`);
  const lands = groupFor(suffix, custom).label;
  const warnings = [];
  if (c.discovery_mode !== 'label' && !objectId.startsWith(prefix)) warnings.push(`doesn't start with your prefix "${prefix}", so the card won't find it`);
  if (group && lands !== group) warnings.push(`its name puts it in ${lands}, not ${group}`);
  if ((c.hidden_types || []).includes(lands)) warnings.push(`the ${lands} group is hidden`);
  return { suffix, objectId, name: titleWords(objectId), lands, warnings };
}

/** Position of a keyword in a name, or -1. Legacy keywords match anywhere; newer ones at a word start. */
function keywordPos(s, kw, legacy) {
  if (legacy) return s.indexOf(kw);
  const m = new RegExp(`(^|_)${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(s);
  return m ? m.index + m[1].length : -1;
}

/**
 * Which group a name belongs to → { label, keyword, icon }.
 * Custom groups win (as they always have). Otherwise the built-in keyword that appears
 * FIRST in the name wins, so lock_front_door is a Lock and door_alarm is a Door.
 */
function groupFor(suffix, customTypes) {
  const s = String(suffix).toLowerCase();
  for (const ct of customTypes || []) {
    if (ct && ct.keyword && ct.label && s.includes(ct.keyword.toLowerCase())) {
      return { label: ct.label, keyword: ct.keyword.toLowerCase(), icon: ct.icon || OTHER_ICON };
    }
  }
  let best = null;
  for (const [label, kw, icon, legacy] of BUILTIN_GROUPS) {
    const p = keywordPos(s, kw, legacy);
    if (p >= 0 && (!best || p < best.p)) best = { p, label, keyword: kw, icon };
  }
  return best ? { label: best.label, keyword: best.keyword, icon: best.icon } : { label: OTHER_GROUP, keyword: null, icon: OTHER_ICON };
}

/** Display name: drop the strip words and (optionally) the group keyword, then Title Case. */
function cleanDisplayName(suffix, stripWords, stripGroup, customTypes) {
  const words = String(suffix).split('_').filter(Boolean);
  const remove = new Set((stripWords || []).map((w) => String(w).toLowerCase()));
  if (stripGroup !== false) {
    const g = groupFor(suffix, customTypes);
    if (g.keyword) remove.add(g.keyword);
  }
  const kept = words.filter((w) => !remove.has(w.toLowerCase()));
  return (kept.length ? kept : words).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function suffixOf(entityId, prefix) {
  const p = (prefix || 'bypass_').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = entityId.match(new RegExp(`^(?:input_boolean|timer)\\.${p}(.+)$`));
  return m ? m[1] : null;
}

function labelSlug(label) {
  return String(label || '').toLowerCase().replace(/\s+/g, '_');
}

// Labels live on hass.entities[id].labels. "bypass" matches bypass, bypass_helper, …
function entityHasLabel(hassEntities, entityId, targetSlug) {
  const labels = (hassEntities && hassEntities[entityId] && hassEntities[entityId].labels) || [];
  return labels.some((l) => { const ls = labelSlug(l); return ls === targetSlug || ls.startsWith(targetSlug); });
}

/** Find the bypass switches and timers → [{ suffix, bool, timer }]. */
function discover(hass, c) {
  const booleans = {};
  const timers = {};
  const states = (hass && hass.states) || {};
  if (c.discovery_mode === 'label') {
    const slug = labelSlug(c.discovery_label || 'bypass');
    for (const id of Object.keys(states)) {
      if (!entityHasLabel(hass.entities, id, slug)) continue;
      if (id.startsWith('input_boolean.')) booleans[id.slice(14)] = id;
      else if (id.startsWith('timer.')) timers[id.slice(6)] = id;
    }
  } else {
    const pfx = c.entity_prefix || 'bypass_';
    for (const id of Object.keys(states)) {
      const suffix = suffixOf(id, pfx);
      if (!suffix) continue;
      if (id.startsWith(`input_boolean.${pfx}`)) booleans[suffix] = id;
      else if (id.startsWith(`timer.${pfx}`)) timers[suffix] = id;
    }
  }
  return [...new Set([...Object.keys(booleans), ...Object.keys(timers)])]
    .map((suffix) => ({ suffix, bool: booleans[suffix] || null, timer: timers[suffix] || null }));
}

/** On = the switch is on; a timer-only row is on while its timer runs. */
function rowIsOn(hass, row) {
  const st = (id) => id && hass && hass.states[id] && hass.states[id].state;
  return row.bool ? st(row.bool) === 'on' : st(row.timer) === 'active';
}

function rowChanged(hass, row) {
  const s = hass && hass.states[row.bool || row.timer];
  const t = s ? new Date(s.last_changed).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

/** Discovered rows → visible sections [{ section, rows }], grouped, filtered and sorted. */
function buildSections(hass, c) {
  const custom = c.custom_types || [];
  const hidden = new Set(c.hidden_types || []);
  const strip = c.strip_words || ['bypass'];
  const rows = discover(hass, c).map((r) => {
    const g = groupFor(r.suffix, custom);
    return { ...r, group: g.label, icon: g.icon, label: cleanDisplayName(r.suffix, strip, c.strip_group_word, custom) };
  }).filter((r) => !hidden.has(r.group));
  const byName = (a, b) => a.label.localeCompare(b.label);
  const sorter = c.sort === 'active'
    ? (a, b) => (rowIsOn(hass, b) - rowIsOn(hass, a)) || (rowChanged(hass, b) - rowChanged(hass, a)) || byName(a, b)
    : byName;
  if (c.group_rows === false) return rows.length ? [{ section: '', rows: rows.sort(sorter) }] : [];
  return orderedGroups(c)
    .map((g) => ({ section: g, rows: rows.filter((r) => r.group === g).sort(sorter) }))
    .filter((s) => s.rows.length);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BTN_KEYS = ['show_btn_start', 'show_btn_pause', 'show_btn_stop', 'show_btn_finish'];
const DEFAULTS = {
  title: DEFAULT_TITLE,
  discovery_mode: 'prefix',
  entity_prefix: 'bypass_',
  discovery_label: 'bypass',
  sort: 'name',
  group_rows: true,
  show_group_labels: true,
  show_dividers: true,
  show_icon: false,
  show_entity_names: true,
  show_toggle: true,
  show_timer_badge: false,
  show_timer_input: true,
  show_countdown: true,
  show_btn_start: true,
  show_btn_pause: true,
  show_btn_stop: true,
  show_btn_finish: true,
  show_button_labels: false,
  show_duration: false,
  show_last_changed: false,
  show_exact_time: false,
  show_active_count: false,
  glow_when_active: false,
  strip_group_word: true,
  collapsible_groups: false,
  allow_create: false,
  allow_delete: false,
  increment_step: 1,
  increment_unit: 'minutes',
  secondary_info_text: '',
  font_size_title: 13,
  font_size_name: 14,
  font_size_group: 11,
  font_size_timer: 13,
  secondary_info_size: 11,
  font_size_last_changed: 11,
  icon_size: 20,
};
// key, label, "unset" label, seed hex, fallback CSS used by the card
const COLOR_DEFS = [
  ['color_card_title', 'Title', 'Theme secondary text', '#9e9e9e', 'var(--secondary-text-color)'],
  ['secondary_info_color', 'Secondary text', 'Theme primary', '#03a9f4', 'var(--primary-color)'],
  ['active_color', 'On (name + switch)', 'Theme primary', '#03a9f4', 'var(--primary-color)'],
  ['color_entity_off', 'Off name', 'Theme text', '#e1e1e1', 'var(--primary-text-color)'],
  ['color_group_label', 'Group title', 'Theme secondary text', '#9e9e9e', 'var(--secondary-text-color)'],
  ['color_divider', 'Divider', 'Theme divider', '#e0e0e0', 'var(--divider-color)'],
  ['icon_color_on', 'Icon when on', 'Theme success (green)', '#4caf50', 'var(--success-color, #4caf50)'],
  ['icon_color_off', 'Icon when off', 'Theme disabled (grey)', '#757575', 'var(--disabled-text-color, #757575)'],
  ['color_last_changed', 'Last changed', 'Theme secondary text', '#9e9e9e', 'var(--secondary-text-color)'],
];
const COLOR_KEYS = COLOR_DEFS.map((d) => d[0]);
const SIZE_DEFS = [ // key, label, min, max
  ['font_size_title', 'Title', 8, 32],
  ['secondary_info_size', 'Secondary text', 8, 32],
  ['font_size_name', 'Names', 8, 32],
  ['font_size_group', 'Group titles', 8, 24],
  ['font_size_timer', 'Countdown / time', 8, 32],
  ['font_size_last_changed', 'Last changed', 8, 24],
  ['icon_size', 'Icons', 12, 40],
];

const isDefault = (key, v) => {
  const d = DEFAULTS[key];
  if (d === undefined) return false;
  return typeof d === 'number' ? Number(v) === d : v === d;
};

/**
 * Migrate legacy keys and drop values equal to the default. Idempotent; never touches
 * keys it doesn't know (type, card_mod, …).
 *   type_filters (groups to SHOW, v31) → hidden_types (groups to HIDE). Groups added
 *     later are shown, so a card made before them picks them up.
 *   show_timer_controls: false → the four per-button switches off.
 */
function normalizeConfig(raw) {
  const c = { ...(raw || {}) };
  if (Array.isArray(c.type_filters)) {
    const shown = new Set(c.type_filters);
    const legacy = [...LEGACY_GROUPS, ...customLabels(c.custom_types)];
    const hidden = [...new Set([...(c.hidden_types || []), ...legacy.filter((g) => !shown.has(g))])];
    if (hidden.length) c.hidden_types = hidden;
  }
  delete c.type_filters;
  if (c.show_timer_controls === false) BTN_KEYS.forEach((k) => { if (c[k] === undefined) c[k] = false; });
  delete c.show_timer_controls;
  for (const k of Object.keys(DEFAULTS)) if (k in c && (c[k] === null || isDefault(k, c[k]))) delete c[k];
  for (const k of COLOR_KEYS) if (k in c && (c[k] === '' || c[k] == null)) delete c[k];
  // group_order: kept only while it differs from the default order (stored resolved, so idempotent).
  if (Array.isArray(c.group_order)) {
    const o = orderedGroups(c);
    if (o.join('\n') === allGroups(c.custom_types).join('\n')) delete c.group_order; else c.group_order = o;
  } else delete c.group_order;
  for (const k of ['hidden_types', 'custom_types', 'collapsed_groups']) if (Array.isArray(c[k]) && !c[k].length) delete c[k];
  if (Array.isArray(c.strip_words) && c.strip_words.length === 1 && c.strip_words[0] === 'bypass') delete c.strip_words;
  return c;
}

/** Config value with its default applied. */
const cfg = (c, key) => (c[key] !== undefined ? c[key] : DEFAULTS[key]);

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
function durationToSecs(dur) {
  if (!dur) return 0;
  const parts = String(dur).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function secsToHMS(secs) {
  secs = Math.max(0, Math.round(secs));
  return [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

// "1h 05m 30s" / "5m 30s" / "45s" — the live countdown and the editable time
function fmtSecs(secs) {
  secs = Math.max(0, Math.round(secs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// "1h 30m" / "5m" / "45s" — the Duration column (configured length, not a countdown)
function fmtDuration(secs) {
  secs = Math.max(0, Math.round(secs));
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ');
}

function fmtRelTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '—';
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m ago` : `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Clock time of a change: "3:41 PM" today, "Oct 12, 3:41 PM" before that
function fmtClock(iso, now = Date.now()) {
  const d = new Date(iso);
  if (!iso || !Number.isFinite(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

// Typed duration → seconds: 30 / 30m, 90s, 1h, 1h30m, 2m30s
function parseInput(raw) {
  raw = String(raw || '').trim();
  let m;
  if ((m = raw.match(/^(\d+)h\s*(\d+)m$/i))) return +m[1] * 3600 + +m[2] * 60;
  if ((m = raw.match(/^(\d+)h$/i))) return +m[1] * 3600;
  if ((m = raw.match(/^(\d+)m\s*(\d+)s$/i))) return +m[1] * 60 + +m[2];
  if ((m = raw.match(/^(\d+)m$/i))) return +m[1] * 60;
  if ((m = raw.match(/^(\d+)s$/i))) return +m[1];
  if ((m = raw.match(/^(\d+)$/))) return +m[1] * 60;
  return 0;
}

const cssEsc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
const CARD_CSS = `
  :host { display: block; font-family: var(--primary-font-family, sans-serif); }
  ha-card.card { padding: 12px 0 8px; display: grid; grid-template-columns: var(--bm-cols, 1fr); align-items: center;
    column-gap: 12px; transition: box-shadow .2s ease; }
  ha-card.card.glow { box-shadow: 0 3px 10px color-mix(in srgb, var(--bm-c-active) 80%, transparent); }
  .head { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 0 16px 4px; min-height: 18px; }
  .card-title { flex: 1 1 auto; min-width: 0; font-size: var(--bm-fs-title); font-weight: 600; letter-spacing: .05em; color: var(--bm-c-title);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap;
    color: var(--secondary-text-color); border: 1px solid var(--divider-color); }
  .count.on { color: var(--bm-c-active); border-color: var(--bm-c-active); }
  .card-secondary { grid-column: 1 / -1; font-size: var(--bm-fs-sec); font-weight: 500; color: var(--bm-c-sec); padding: 0 16px 8px; }
  .section-label { grid-column: 1 / -1; font-size: var(--bm-fs-group); font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
    color: var(--bm-c-group); opacity: .7; padding: 10px 16px 4px; }
  .divider { grid-column: 1 / -1; height: 1px; background: var(--bm-c-divider); margin: 4px 16px; opacity: .5; }
  .empty { grid-column: 1 / -1; padding: 8px 16px; color: var(--secondary-text-color); font-size: 13px; }

  .row { display: contents; }
  .row > span { padding: 5px 0; min-width: 0; }
  .row:hover > span { background: var(--secondary-background-color); }
  .row.solo-timer > span { opacity: .75; }
  .col-first { padding-left: 16px !important; }
  .col-last { padding-right: 16px !important; }

  .col-icon { display: flex; align-items: center; }
  .icon-btn { border: none; background: none; padding: 0; margin: 0; cursor: pointer; line-height: 0; color: var(--bm-c-icon-off); }
  .icon-btn ha-icon { --mdc-icon-size: var(--bm-icon); width: var(--bm-icon); height: var(--bm-icon); }
  .row.active .icon-btn { color: var(--bm-c-icon-on); }

  .col-name { font-size: var(--bm-fs-name); color: var(--bm-c-off); font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .row.active .col-name { color: var(--bm-c-active); font-weight: 700; }

  .col-btns { display: flex; justify-content: flex-start; }
  .timer-btns { display: inline-flex; gap: 6px; }
  .col-time { display: flex; }
  .timer-input-wrap { display: inline-flex; align-items: center; gap: 4px; }
  .timer-input { height: 26px; width: 80px; font-size: 12px; padding: 0 6px; border: 1px solid var(--divider-color); border-radius: 6px;
    background: var(--card-background-color); color: var(--primary-text-color); text-align: center; }
  .timer-input:focus { outline: none; border-color: var(--primary-color); }
  .timer-input.paused { border-color: var(--warning-color, #f4b942); color: var(--warning-color, #f4b942); }
  .countdown { font-size: var(--bm-fs-timer); font-family: var(--paper-font-code_-_font-family, monospace); font-weight: 600; min-width: 80px;
    text-align: center; display: inline-block; color: var(--primary-color); }
  .countdown.paused { color: var(--warning-color, #f4b942); }
  .col-dur { font-size: 12px; font-weight: 600; color: var(--secondary-text-color); white-space: nowrap; cursor: pointer; text-align: right; }
  .row.timing .col-dur { color: var(--primary-color); }

  .btn { height: 26px; padding: 0 8px; font-size: 11px; font-weight: 500; border: none; border-radius: 6px; cursor: pointer; white-space: nowrap;
    transition: opacity .15s; line-height: 26px; }
  .btn:active { opacity: .7; }
  .btn-adj { width: 26px; padding: 0; text-align: center; background: var(--secondary-background-color); color: var(--primary-text-color);
    font-size: 16px; line-height: 24px; }
  .btn-start { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .btn-pause { background: var(--warning-color, #f4b942); color: #000; }
  .btn-stop { background: var(--error-color, #db4437); color: #fff; }
  .btn-finish { background: var(--success-color, #43a047); color: #fff; }

  .solo-timer-badge { font-size: 10px; color: var(--disabled-text-color, var(--secondary-text-color)); font-style: italic; padding-right: 4px; }
  ha-switch { --mdc-theme-secondary: var(--bm-c-active); --switch-checked-color: var(--bm-c-active); }
  .row-last-changed { grid-column: 1 / -1; font-size: var(--bm-fs-lc); color: var(--bm-c-lc); padding: 0 16px 6px; display: flex; gap: 16px; flex-wrap: wrap; }
  .lc-clock { opacity: .8; }

  .sec-toggle { display: flex; align-items: center; gap: 4px; width: 100%; border: none; background: none; cursor: pointer; text-align: left;
    font-family: inherit; }
  .sec-toggle .sec-chev { --mdc-icon-size: 16px; width: 16px; height: 16px; transition: transform .2s ease; }
  .sec-toggle.collapsed .sec-chev { transform: rotate(-90deg); }
  .sec-on { margin-left: 6px; color: var(--bm-c-active); text-transform: none; letter-spacing: 0; }
  .sec-hidden { display: none !important; }

  .manage { grid-column: 1 / -1; margin: 0 16px 8px; border: 1px solid var(--divider-color); border-radius: 10px; }
  .manage.open { border-color: var(--primary-color); }
  .manage-head { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: none; padding: 6px 10px; cursor: pointer;
    color: var(--secondary-text-color); font-family: inherit; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
  .manage-head ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; }
  .manage-head .chev { margin-left: auto; transition: transform .2s ease; transform: rotate(-90deg); }
  .manage.open .manage-head .chev { transform: none; }
  .manage-body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--divider-color); background: none; cursor: pointer;
    color: var(--primary-text-color); font-family: inherit; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
  .chip ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; }
  .chip.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .chip.chip-del.on { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); color: #fff; }
  .mg-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .mg-form input[type="text"], .mg-form select { height: 28px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--divider-color);
    border-radius: 6px; background: var(--card-background-color); color: var(--primary-text-color); font-family: inherit; font-size: 12px; }
  .mg-form input:focus, .mg-form select:focus { outline: none; border-color: var(--primary-color); }
  .mg-form .mg-name { flex: 1 1 140px; min-width: 0; }
  .mg-form .mg-dur { width: 72px; text-align: center; }
  .mg-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--secondary-text-color); cursor: pointer; }
  .mg-preview { font-size: 11px; color: var(--secondary-text-color); line-height: 1.5; }
  .mg-preview code { font-family: var(--code-font-family, monospace); color: var(--primary-text-color); }
  .mg-preview .warn { color: var(--warning-color, #f4b942); }
  .mg-preview .bad, .mg-msg.err { color: var(--error-color, #db4437); }
  .mg-msg { font-size: 12px; }
  .mg-msg.ok { color: var(--success-color, #43a047); }
  .btn:disabled { opacity: .4; cursor: default; }
  .btn-del { background: var(--error-color, #db4437); color: #fff; }
  .btn-cancel { background: var(--secondary-background-color); color: var(--primary-text-color); }
  .col-del { display: flex; align-items: center; justify-content: center; }
  .del-btn { border: none; background: none; padding: 0; margin: 0; cursor: pointer; line-height: 0; color: var(--secondary-text-color); }
  .del-btn:hover { color: var(--error-color, #db4437); }
  .del-btn ha-icon, .del-na ha-icon { --mdc-icon-size: 18px; width: 18px; height: 18px; }
  .del-na { line-height: 0; color: var(--disabled-text-color, var(--secondary-text-color)); opacity: .6; }
  .row-confirm { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 2px 16px 8px; font-size: 12px;
    color: var(--primary-text-color); }
  .row-confirm .muted { color: var(--secondary-text-color); font-size: 11px; }
`;

/** The per-card values, as custom properties on the card root (the stylesheet never changes). */
function rootStyleVars(c, cols) {
  const color = (key) => { const d = COLOR_DEFS.find((x) => x[0] === key); return c[key] || d[4]; };
  const px = (key) => `${Number(cfg(c, key))}px`;
  return [
    `--bm-cols:${cols}`,
    `--bm-fs-title:${px('font_size_title')}`, `--bm-fs-sec:${px('secondary_info_size')}`, `--bm-fs-name:${px('font_size_name')}`,
    `--bm-fs-group:${px('font_size_group')}`, `--bm-fs-timer:${px('font_size_timer')}`, `--bm-fs-lc:${px('font_size_last_changed')}`,
    `--bm-icon:${px('icon_size')}`,
    `--bm-c-title:${color('color_card_title')}`, `--bm-c-sec:${color('secondary_info_color')}`, `--bm-c-active:${color('active_color')}`,
    `--bm-c-off:${color('color_entity_off')}`, `--bm-c-group:${color('color_group_label')}`, `--bm-c-divider:${color('color_divider')}`,
    `--bm-c-icon-on:${color('icon_color_on')}`, `--bm-c-icon-off:${color('icon_color_off')}`, `--bm-c-lc:${color('color_last_changed')}`,
  ].join(';');
}

/** Which columns the card shows, in order. `del` = the card's Delete chip is on. */
function columns(c, del = false) {
  const btns = BTN_KEYS.some((k) => cfg(c, k));
  return [
    cfg(c, 'show_icon') && ['icon', 'max-content'],
    cfg(c, 'show_entity_names') && ['name', '1fr'],
    btns && ['btns', 'max-content'],
    (cfg(c, 'show_timer_input') || cfg(c, 'show_countdown')) && ['time', 'max-content'],
    cfg(c, 'show_duration') && ['dur', 'max-content'],
    cfg(c, 'show_toggle') && ['toggle', 'max-content'],
    del && ['del', 'max-content'],
  ].filter(Boolean);
}

/** A storage helper can be deleted from the UI; a YAML one says editable: false. */
const isEditable = (hass, id) => {
  const s = id && hass && hass.states[id];
  return !!s && !(s.attributes && s.attributes.editable === false);
};
const errText = (e) => (e && (e.message || e.code)) || String(e);

class BypassManagerCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = {};
    this._interval = null;
    this._throttle = null;
    this._finishTimes = {}; // timer → epoch ms (active)
    this._pausedSecs = {};  // timer → remaining seconds (paused)
    this._inputSecs = {};   // timer → seconds typed / stepped while idle
    this._sections = [];
    this._sig = '';
    this._groupOpen = {};   // group → open (seeded from collapsed_groups; kept across redraws)
    // The Manage section (create / delete). Lives here so a redraw never loses it. Starts collapsed.
    this._mg = { open: false, create: null, del: false, group: '', name: '', dur: '5m', restore: false, busy: false, msg: null, confirm: null };
    this.attachShadow({ mode: 'open' });
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    this._config = normalizeConfig(config);
    this._groupOpen = {}; // a changed start setting shows straight away in the editor preview
    if (!this._c('allow_create')) this._mg.create = null;
    if (!this._c('allow_delete')) { this._mg.del = false; this._mg.confirm = null; }
    if (this._hass) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) { this._render(); this._startTick(); return; }
    if (this._throttle) return;
    this._throttle = setTimeout(() => { this._throttle = null; this._update(); }, 250);
  }

  connectedCallback() { if (this._hass && !this._interval) this._startTick(); }

  disconnectedCallback() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    if (this._throttle) clearTimeout(this._throttle);
    this._throttle = null;
  }

  getCardSize() {
    return this._sections.length ? this._sections.reduce((n, s) => n + s.rows.length, 0) + this._sections.length : 3;
  }

  static getConfigElement() { return document.createElement(EDITOR_TAG); }

  static getStubConfig() { return {}; }

  // ── Config helpers ──────────────────────────────────────────────────────
  _c(key) { return cfg(this._config, key); }

  _incrementSecs() {
    const v = Number(this._c('increment_step')) || 1;
    const unit = this._c('increment_unit');
    return unit === 'hours' ? v * 3600 : unit === 'seconds' ? v : v * 60;
  }

  _allRows() { return this._sections.flatMap((s) => s.rows); }

  _allTimers() { return this._allRows().map((r) => r.timer).filter(Boolean); }

  /** Admins only (the create / delete commands are admin-only in Home Assistant), and only when switched on. */
  _canManage() {
    const h = this._hass;
    return !!(h && h.user && h.user.is_admin && typeof h.callWS === 'function') && !!(this._c('allow_create') || this._c('allow_delete'));
  }

  _delMode() { return this._canManage() && this._c('allow_delete') && this._mg.del; }

  _collapsible() { return !!(this._c('collapsible_groups') && this._c('group_rows')); }

  _isOpen(group) {
    if (!(group in this._groupOpen)) this._groupOpen[group] = !(this._config.collapsed_groups || []).includes(group);
    return this._groupOpen[group];
  }

  /** What, if it changes, needs the rows rebuilt (not just patched): which entities exist and their order. */
  _signature() {
    return this._sections.map((s) => `${s.section}:${s.rows.map((r) => `${r.bool || ''}|${r.timer || ''}`).join(',')}`).join(';');
  }

  // ── Render (full) ───────────────────────────────────────────────────────
  _render() {
    if (!this._hass) return;
    const c = this._config;
    // Keep the caret in a Manage field across the redraw (a new helper appearing redraws the rows).
    const ae = this.shadowRoot.activeElement;
    const focusKey = ae && ae.dataset && ae.dataset.mg;
    let caret = null;
    try { caret = focusKey && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null; } catch (e) { caret = null; }
    this._sections = buildSections(this._hass, c);
    this._sig = this._signature();
    const cols = columns(c, this._delMode());
    const title = this._c('title');
    const sec = this._c('secondary_info_text');
    const collapsible = this._collapsible();
    const showGroups = (this._c('show_group_labels') || collapsible) && this._c('group_rows');
    const groupHead = (g) => {
      if (!collapsible) return `<div class="section-label">${esc(g)}</div>`;
      const open = this._isOpen(g);
      return `<button class="section-label sec-toggle${open ? '' : ' collapsed'}" data-sec-toggle="${esc(g)}" aria-expanded="${open}">`
        + `<ha-icon class="sec-chev" icon="mdi:chevron-down"></ha-icon><span>${esc(g)}</span><span class="sec-on" data-sec-on="${esc(g)}"></span></button>`;
    };
    const body = this._sections.length
      ? this._sections.map((s, i) => `${i > 0 && this._c('show_dividers') && this._c('group_rows') ? '<div class="divider"></div>' : ''}${
        showGroups && s.section ? groupHead(s.section) : ''}${s.rows.map((r) => this._rowHtml(r, cols, !!(collapsible && s.section && !this._isOpen(s.section)), s.section)).join('')}`).join('')
      : '<div class="empty">No bypass switches or timers found.</div>';
    this.shadowRoot.innerHTML = `<style>${CARD_CSS}</style>
      <ha-card class="card" style="${esc(rootStyleVars(c, cols.map((x) => x[1]).join(' ') || '1fr'))}">
        ${title || this._c('show_active_count') ? `<div class="head"><span class="card-title">${esc(title)}</span>${
          this._c('show_active_count') ? '<span class="count" data-count></span>' : ''}</div>` : ''}
        ${sec ? `<div class="card-secondary">${esc(sec)}</div>` : ''}
        ${this._canManage() ? this._manageHtml() : ''}
        ${body}
      </ha-card>`;
    this._wire();
    this._syncTimerTimes();
    this._patch();
    this._tick();
    if (focusKey) {
      const el = this.shadowRoot.querySelector(`[data-mg="${cssEsc(focusKey)}"]`);
      if (el) { el.focus(); if (caret) try { el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } }
    }
  }

  // ── Manage section (create / delete helpers) ────────────────────────────
  _manageHtml() {
    const m = this._mg;
    const canAdd = this._c('allow_create');
    const canDel = this._c('allow_delete');
    const chip = (attr, val, on, icon, label, extra = '') => `<button class="chip${extra}${on ? ' on' : ''}" ${attr}="${val}" aria-pressed="${on}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`;
    let form = '';
    if (canAdd && m.create) {
      const groups = orderedGroups(this._config);
      form = `<div class="mg-form">
          <select data-mg="group" title="Group: adds its word to the name"><option value="">Group: auto</option>${
            groups.map((g) => `<option value="${esc(g)}"${g === m.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>
          <input type="text" class="mg-name" data-mg="name" placeholder="Name, e.g. Patio" value="${esc(m.name)}">
          ${m.create !== 'switch' ? `<input type="text" class="mg-dur" data-mg="dur" title="Timer length: 30m, 1h, 1h30m, 90s" value="${esc(m.dur)}">
          <label class="mg-check" title="Pick up where it left off after Home Assistant restarts"><input type="checkbox" data-mg="restore"${m.restore ? ' checked' : ''}>Restore</label>` : ''}
          <button class="btn btn-start" data-mg-go${m.busy ? ' disabled' : ''}>Create</button>
        </div>
        <div class="mg-preview" data-mg-preview></div>`;
    }
    const msg = m.msg ? `<div class="mg-msg ${m.msg.kind}">${esc(m.msg.text)}</div>` : '';
    const delHint = canDel && m.del ? '<div class="mg-preview">Tap <ha-icon icon="mdi:trash-can-outline" style="--mdc-icon-size:14px"></ha-icon> on a row to delete its helpers. You\'ll be asked first.</div>' : '';
    return `<div class="manage${m.open ? ' open' : ''}">
        <button class="manage-head" data-mg-toggle aria-expanded="${m.open}"><ha-icon icon="mdi:wrench-outline"></ha-icon>Manage<ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></button>
        ${m.open ? `<div class="manage-body">
          <div class="chips">${canAdd ? [
            chip('data-mg-create', 'timer', m.create === 'timer', 'mdi:timer-plus-outline', 'Timer'),
            chip('data-mg-create', 'switch', m.create === 'switch', 'mdi:toggle-switch-outline', 'Switch'),
            chip('data-mg-create', 'set', m.create === 'set', 'mdi:link-variant-plus', 'Matched set'),
          ].join('') : ''}${canDel ? chip('data-mg-del', '1', m.del, 'mdi:trash-can-outline', 'Delete', ' chip-del') : ''}</div>
          ${form}${delHint}${msg}
        </div>` : ''}
      </div>`;
  }

  /** What the Create form would make right now → { plan, ids, exists, pairs } or null. */
  _createPlan() {
    const m = this._mg;
    const plan = planHelperName(this._config, m.name, m.group);
    if (!plan) return null;
    const domains = m.create === 'timer' ? ['timer'] : m.create === 'switch' ? ['input_boolean'] : ['timer', 'input_boolean'];
    const ids = domains.map((d) => `${d}.${plan.objectId}`);
    const states = this._hass.states;
    const exists = ids.filter((id) => states[id]);
    const other = m.create === 'timer' ? `input_boolean.${plan.objectId}` : m.create === 'switch' ? `timer.${plan.objectId}` : null;
    return { plan, ids, exists, pairs: other && states[other] ? other : null };
  }

  /** Patch the Create preview + button in place (typing must not redraw the card). */
  _mgPreview() {
    const box = this.shadowRoot.querySelector('[data-mg-preview]');
    const go = this.shadowRoot.querySelector('[data-mg-go]');
    if (!box) return;
    const p = this._createPlan();
    const durBad = this._mg.create !== 'switch' && !parseInput(this._mg.dur);
    if (go) go.disabled = this._mg.busy || !p || !!p.exists.length || durBad;
    if (!p) { box.innerHTML = 'Type a name. The card adds the prefix and group word, e.g. <code>bypass_door_patio</code>.'; return; }
    const parts = [`Creates ${p.ids.map((id) => `<code>${esc(id)}</code>`).join(' + ')} in <b>${esc(p.plan.lands)}</b>`];
    if (p.pairs) parts.push(`pairs with <code>${esc(p.pairs)}</code>`);
    let html = parts.join(', ');
    if (p.exists.length) html += `<br><span class="bad">${p.exists.map(esc).join(' and ')} already exist${p.exists.length === 1 ? 's' : ''}.</span>`;
    if (durBad) html += '<br><span class="bad">Timer length: try 30m, 1h or 1h30m.</span>';
    if (p.plan.warnings.length) html += `<br><span class="warn">Note: ${p.plan.warnings.map(esc).join('; ')}.</span>`;
    box.innerHTML = html;
  }

  async _create() {
    const p = this._createPlan();
    const m = this._mg;
    if (!p || p.exists.length || m.busy) return;
    const secs = parseInput(m.dur);
    if (m.create !== 'switch' && !secs) return;
    m.busy = true; m.msg = null;
    this._render();
    const made = []; const errs = []; const notes = [];
    for (const id of p.ids) {
      const domain = id.split('.')[0];
      const data = { type: `${domain}/create`, name: p.plan.name };
      if (domain === 'timer') { data.duration = secsToHMS(secs); if (m.restore) data.restore = true; }
      try {
        const item = await this._hass.callWS(data);
        const eid = `${domain}.${(item && item.id) || p.plan.objectId}`;
        made.push(eid);
        if (eid !== id) notes.push(`${id} was taken, so it is ${eid}`);
        if (this._config.discovery_mode === 'label') {
          try { await this._applyLabel(eid); } catch (e) { notes.push(`couldn't add the label to ${eid}: ${errText(e)}`); }
        }
      } catch (e) { errs.push(`${id}: ${errText(e)}`); }
    }
    m.busy = false;
    if (made.length) m.name = '';
    m.msg = errs.length
      ? { kind: 'err', text: `${made.length ? `Created ${made.join(' + ')}, but ` : ''}couldn't create ${errs.join('; ')}` }
      : { kind: notes.length ? 'err' : 'ok', text: `Created ${made.join(' + ')}${notes.length ? ` (${notes.join('; ')})` : ''}.` };
    this._render();
  }

  /** Label discovery: give a new helper the card's label so it shows up. */
  async _applyLabel(entityId) {
    const slug = labelSlug(this._config.discovery_label || 'bypass');
    const labels = (await this._hass.callWS({ type: 'config/label_registry/list' })) || [];
    const hit = labels.find((l) => labelSlug(l.label_id) === slug) || labels.find((l) => labelSlug(l.name) === slug)
      || labels.find((l) => labelSlug(l.label_id).startsWith(slug));
    if (!hit) throw new Error(`there is no "${this._config.discovery_label || 'bypass'}" label`);
    const entry = await this._hass.callWS({ type: 'config/entity_registry/get', entity_id: entityId });
    await this._hass.callWS({ type: 'config/entity_registry/update', entity_id: entityId,
      labels: [...new Set([...((entry && entry.labels) || []), hit.label_id])] });
  }

  /** A helper's stored id (what timer/delete and input_boolean/delete want) is its registry unique_id; fall back to the object id. */
  async _storageId(entityId) {
    try {
      const e = await this._hass.callWS({ type: 'config/entity_registry/get', entity_id: entityId });
      if (e && e.unique_id) return e.unique_id;
    } catch (e) { /* not in the registry: try the object id */ }
    return entityId.split('.')[1];
  }

  async _delete(row, what) {
    const m = this._mg;
    const targets = [];
    if ((what === 'timer' || what === 'both') && row.timer && isEditable(this._hass, row.timer)) targets.push(['timer', row.timer]);
    if ((what === 'switch' || what === 'both') && row.bool && isEditable(this._hass, row.bool)) targets.push(['input_boolean', row.bool]);
    if (!targets.length || m.busy) return;
    m.busy = true; m.confirm = null; m.msg = null;
    this._render();
    const done = []; const errs = [];
    for (const [domain, id] of targets) {
      try {
        await this._hass.callWS({ type: `${domain}/delete`, [`${domain}_id`]: await this._storageId(id) });
        done.push(id);
        if (domain === 'timer') { delete this._inputSecs[id]; delete this._finishTimes[id]; delete this._pausedSecs[id]; }
      } catch (e) { errs.push(`${id}: ${errText(e)}`); }
    }
    m.busy = false;
    m.msg = errs.length
      ? { kind: 'err', text: `${done.length ? `Deleted ${done.join(' + ')}, but ` : ''}couldn't delete ${errs.join('; ')}` }
      : { kind: 'ok', text: `Deleted ${done.join(' + ')}.` };
    if (!m.open) m.open = true; // the result shows in the Manage section
    this._render();
  }

  _confirmHtml(row, secAttr, hid) {
    const h = this._hass;
    const t = row.timer && isEditable(h, row.timer);
    const b = row.bool && isEditable(h, row.bool);
    const yaml = [row.bool && !b && 'switch', row.timer && !t && 'timer'].filter(Boolean);
    const key = esc(row.bool || row.timer);
    const btn = (what, label) => `<button class="btn btn-del" data-del-do="${what}" data-del-row="${key}">${label}</button>`;
    return `<div class="row-confirm${hid}"${secAttr}>Delete <b>${esc(row.label)}</b>:
      ${t ? btn('timer', 'Timer') : ''}${b ? btn('switch', 'Switch') : ''}${t && b ? btn('both', 'Both') : ''}
      <button class="btn btn-cancel" data-del-cancel>Cancel</button>
      ${yaml.length ? `<span class="muted">The ${yaml.join(' and ')} ${yaml.length > 1 ? 'are' : 'is'} set up in YAML and can't be deleted here.</span>` : ''}</div>`;
  }

  _rowHtml(row, cols, hidden = false, section = '') {
    const c = this._config;
    const sl = this._c('show_button_labels');
    const t = row.timer;
    const key = row.bool || row.timer;
    const canDel = (row.timer && isEditable(this._hass, row.timer)) || (row.bool && isEditable(this._hass, row.bool));
    const secAttr = section && this._collapsible() ? ` data-sec="${esc(section)}"` : '';
    const hid = hidden ? ' sec-hidden' : '';
    const cell = {
      icon: () => `<span class="col-icon"><button class="icon-btn" data-icon-tap="${esc(row.bool || row.timer)}" title="${row.bool ? 'Turn on / off' : 'Details'}"><ha-icon icon="${esc(row.icon)}"></ha-icon></button></span>`,
      name: () => `<span class="col-name" data-more="${esc(row.bool || row.timer)}" title="${esc(row.bool || row.timer)}">${esc(row.label)}</span>`,
      btns: () => `<span class="col-btns">${t ? `<span class="timer-btns" data-timer-btns="${esc(t)}">${[
        ['show_btn_start', 'start', 'idle,paused', '▶', 'Start'],
        ['show_btn_pause', 'pause', 'active', '⏸', 'Pause'],
        ['show_btn_stop', 'stop', 'active,paused', '■', 'Stop'],
        ['show_btn_finish', 'finish', 'active,paused', '✓', 'Finish'],
      ].filter(([k]) => cfg(c, k)).map(([, act, states, glyph, name]) => `<button class="btn btn-${act}" data-act="${act}" data-timer="${esc(t)}" data-btn-state="${states}" title="${name}"${
        states.includes('idle') ? '' : ' style="display:none"'}>${glyph}${sl ? ` ${name}` : ''}</button>`).join('')}</span>` : ''}</span>`,
      time: () => `<span class="col-time">${t ? `<span class="timer-input-wrap">${this._c('show_timer_input') ? `
        <button class="btn btn-adj" data-adj="${esc(t)}" data-delta="-1" title="Less">−</button>
        <input class="timer-input idle" type="text" placeholder="5m" title="e.g. 30m, 1h, 2h30m" data-input="${esc(t)}">` : ''}${
        this._c('show_countdown') ? `<span class="countdown" data-countdown="${esc(t)}" style="display:none">—</span>` : ''}${this._c('show_timer_input') ? `
        <button class="btn btn-adj" data-adj="${esc(t)}" data-delta="1" title="More">+</button>` : ''}</span>` : ''}</span>`,
      dur: () => `<span class="col-dur"${t ? ` data-dur="${esc(t)}" data-more="${esc(t)}" title="Timer duration"` : ''}></span>`,
      toggle: () => `<span class="col-toggle">${row.bool ? `<ha-switch data-bool="${esc(row.bool)}"></ha-switch>`
        : (this._c('show_timer_badge') ? '<span class="solo-timer-badge">timer only</span>' : '')}</span>`,
      del: () => `<span class="col-del">${canDel
        ? `<button class="del-btn" data-del="${esc(key)}" title="Delete…"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>`
        : '<span class="del-na" title="Set up in YAML: can\'t be deleted here"><ha-icon icon="mdi:lock-outline"></ha-icon></span>'}</span>`,
    };
    const html = cols.map(([k], i) => {
      let h = cell[k]();
      const extra = [i === 0 && 'col-first', i === cols.length - 1 && 'col-last'].filter(Boolean).join(' ');
      if (extra) h = h.replace(/^<span class="([^"]+)"/, `<span class="$1 ${extra}"`);
      return h;
    }).join('');
    const clock = this._c('show_exact_time');
    const lc = this._c('show_last_changed') ? `<div class="row-last-changed${hid}"${secAttr}>${
      row.bool ? `<span>Switch: <span data-lc="${esc(row.bool)}">—</span>${clock ? ` <span class="lc-clock" data-lc-clock="${esc(row.bool)}"></span>` : ''}</span>` : ''}${
      t ? `<span>Timer: <span data-lc="${esc(t)}">—</span>${clock ? ` <span class="lc-clock" data-lc-clock="${esc(t)}"></span>` : ''}</span>` : ''}</div>` : '';
    const confirm = this._delMode() && this._mg.confirm === key && canDel ? this._confirmHtml(row, secAttr, hid) : '';
    return `<div class="row${row.bool ? '' : ' solo-timer'}${hid}" data-row="${esc(key)}"${secAttr}>${html}</div>${lc}${confirm}`;
  }

  _wire() {
    const root = this.shadowRoot;
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(el, e)));
    // Collapsible groups: show / hide in place, no redraw.
    on('[data-sec-toggle]', 'click', (el) => {
      const g = el.dataset.secToggle;
      const open = !this._isOpen(g);
      this._groupOpen[g] = open;
      el.classList.toggle('collapsed', !open);
      el.setAttribute('aria-expanded', String(open));
      root.querySelectorAll(`[data-sec="${cssEsc(g)}"]`).forEach((x) => x.classList.toggle('sec-hidden', !open));
      this._patch();
    });
    // Manage section
    const m = this._mg;
    on('[data-mg-toggle]', 'click', () => { m.open = !m.open; this._render(); });
    on('[data-mg-create]', 'click', (el) => { const v = el.dataset.mgCreate; m.create = m.create === v ? null : v; m.msg = null; this._render(); });
    on('[data-mg-del]', 'click', () => { m.del = !m.del; m.confirm = null; m.msg = null; this._render(); });
    on('[data-mg="name"], [data-mg="dur"]', 'input', (el) => { m[el.dataset.mg] = el.value; this._mgPreview(); });
    on('[data-mg="name"], [data-mg="dur"]', 'keydown', (el, e) => { if (e.key === 'Enter') this._create(); });
    on('[data-mg="group"]', 'change', (el) => { m.group = el.value; this._mgPreview(); });
    on('[data-mg="restore"]', 'change', (el) => { m.restore = el.checked; });
    on('[data-mg-go]', 'click', () => this._create());
    on('[data-del]', 'click', (el) => { m.confirm = m.confirm === el.dataset.del ? null : el.dataset.del; this._render(); });
    on('[data-del-cancel]', 'click', () => { m.confirm = null; this._render(); });
    on('[data-del-do]', 'click', (el) => {
      const row = this._allRows().find((r) => (r.bool || r.timer) === el.dataset.delRow);
      if (row) this._delete(row, el.dataset.delDo);
    });
    this._mgPreview();
    root.querySelectorAll('ha-switch[data-bool]').forEach((sw) => sw.addEventListener('change', () => this._toggleBool(sw.dataset.bool)));
    root.querySelectorAll('[data-icon-tap]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.iconTap;
      if (id.startsWith('input_boolean.')) this._toggleBool(id); else this._moreInfo(id);
    }));
    root.querySelectorAll('[data-more]').forEach((el) => el.addEventListener('click', () => this._moreInfo(el.dataset.more)));
    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.timer;
      ({ start: () => this._timerStart(t), pause: () => this._timerPause(t), stop: () => this._timerStop(t), finish: () => this._timerFinish(t) })[b.dataset.act]();
    }));
    root.querySelectorAll('[data-adj]').forEach((b) => b.addEventListener('click', () => this._timerAdjust(b.dataset.adj, Number(b.dataset.delta))));
    root.querySelectorAll('[data-input]').forEach((inp) => {
      const update = () => {
        const secs = parseInput(inp.value);
        if (secs > 0) this._inputSecs[inp.dataset.input] = secs;
      };
      inp.addEventListener('change', () => { update(); this._tick(); });
      inp.addEventListener('input', update);
    });
  }

  // ── Live updates ────────────────────────────────────────────────────────
  _update() {
    if (!this._hass) return;
    const next = buildSections(this._hass, this._config);
    const sig = next.map((s) => `${s.section}:${s.rows.map((r) => `${r.bool || ''}|${r.timer || ''}`).join(',')}`).join(';');
    // A bypass appeared / disappeared, or the active-first order changed: rebuild the rows.
    // Never while a time is being typed in a row — the next update catches up. (Manage fields
    // are fine: the redraw keeps their text and caret.)
    const ae = this.shadowRoot.activeElement;
    if (sig !== this._sig && !(ae && ae.dataset && ae.dataset.input)) { this._render(); return; }
    this._syncTimerTimes();
    this._patch();
  }

  /** Patch everything state-driven in place: switches, on/off rows, durations, count, glow. */
  _patch() {
    const h = this._hass;
    const root = this.shadowRoot;
    let on = 0;
    for (const row of this._allRows()) {
      const isOn = rowIsOn(h, row);
      if (isOn) on++;
      const el = root.querySelector(`.row[data-row="${cssEsc(row.bool || row.timer)}"]`);
      if (el) {
        el.classList.toggle('active', isOn);
        el.classList.toggle('timing', !!(row.timer && h.states[row.timer] && h.states[row.timer].state !== 'idle'));
      }
      if (row.bool) {
        const sw = root.querySelector(`ha-switch[data-bool="${cssEsc(row.bool)}"]`);
        if (sw) sw.checked = isOn;
      }
      if (row.timer) {
        const d = root.querySelector(`[data-dur="${cssEsc(row.timer)}"]`);
        const ts = h.states[row.timer];
        if (d) d.textContent = ts ? fmtDuration(durationToSecs(ts.attributes && ts.attributes.duration)) : '—';
      }
    }
    const count = root.querySelector('[data-count]');
    if (count) {
      count.textContent = on ? `${on} active` : 'All off';
      count.classList.toggle('on', on > 0);
    }
    // A collapsed group still says how many of its bypasses are on.
    if (this._collapsible()) {
      for (const s of this._sections) {
        const el = root.querySelector(`[data-sec-on="${cssEsc(s.section)}"]`);
        if (!el) continue;
        const n = this._isOpen(s.section) ? 0 : s.rows.filter((r) => rowIsOn(h, r)).length;
        el.textContent = n ? `· ${n} on` : '';
      }
    }
    const card = root.querySelector('ha-card');
    if (card) card.classList.toggle('glow', !!(this._c('glow_when_active') && on));
  }

  _syncTimerTimes() {
    if (!this._hass) return;
    for (const t of this._allTimers()) {
      const ts = this._hass.states[t];
      if (!ts) continue;
      if (ts.state === 'active' && ts.attributes.finishes_at) {
        this._finishTimes[t] = new Date(ts.attributes.finishes_at).getTime();
        delete this._pausedSecs[t];
      } else if (ts.state === 'paused') {
        this._pausedSecs[t] = durationToSecs(ts.attributes.remaining);
        delete this._finishTimes[t];
      } else {
        delete this._finishTimes[t];
        delete this._pausedSecs[t];
      }
    }
  }

  _startTick() {
    if (this._interval) clearInterval(this._interval);
    this._interval = setInterval(() => this._tick(), 1000);
  }

  /** Once a second: countdowns, which buttons/fields show, last-changed times. */
  _tick() {
    if (!this._hass) return;
    const root = this.shadowRoot;
    const now = Date.now();
    for (const t of this._allTimers()) {
      const ts = this._hass.states[t];
      if (!ts) continue;
      const q = (sel) => root.querySelector(`[${sel}="${cssEsc(t)}"]`);
      const inp = q('data-input');
      const cd = q('data-countdown');
      const adj = root.querySelectorAll(`[data-adj="${cssEsc(t)}"]`);
      const state = ts.state;
      const remaining = state === 'active'
        ? Math.max(0, Math.round(((this._finishTimes[t] || now) - now) / 1000))
        : state === 'paused' ? (this._pausedSecs[t] ?? durationToSecs(ts.attributes.remaining)) : null;
      // Running: read-only countdown. Idle / paused: the editable time (if shown), else the countdown while paused.
      const showInput = !!inp && state !== 'active';
      if (inp) inp.style.display = showInput ? '' : 'none';
      adj.forEach((b) => { b.style.display = showInput ? '' : 'none'; });
      if (cd) {
        const showCd = state === 'active' || (state === 'paused' && !inp);
        cd.style.display = showCd ? '' : 'none';
        if (showCd) { cd.textContent = fmtSecs(remaining); cd.classList.toggle('paused', state === 'paused'); }
      }
      if (showInput && root.activeElement !== inp) {
        const secs = state === 'paused' ? remaining : (this._inputSecs[t] ?? durationToSecs(ts.attributes.duration));
        inp.value = fmtSecs(secs);
        inp.className = `timer-input ${state}`;
      }
      const btns = q('data-timer-btns');
      if (btns) btns.querySelectorAll('[data-btn-state]').forEach((b) => { b.style.display = b.dataset.btnState.split(',').includes(state) ? '' : 'none'; });
    }
    root.querySelectorAll('[data-lc]').forEach((el) => {
      const s = this._hass.states[el.dataset.lc];
      if (s) el.textContent = fmtRelTime(s.last_changed, now);
    });
    root.querySelectorAll('[data-lc-clock]').forEach((el) => {
      const s = this._hass.states[el.dataset.lcClock];
      const clock = s ? fmtClock(s.last_changed, now) : '';
      el.textContent = clock ? `· ${clock}` : '';
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }

  _toggleBool(entityId) {
    const s = this._hass && this._hass.states[entityId];
    if (!s) return;
    this._hass.callService('input_boolean', s.state === 'on' ? 'turn_off' : 'turn_on', { entity_id: entityId });
  }

  /** Mirror a timer change locally so the row reacts before Home Assistant reports back. */
  _optimistic(t, state, remSecs) {
    if (state === 'active') { this._finishTimes[t] = Date.now() + (remSecs || 0) * 1000; delete this._pausedSecs[t]; }
    else if (state === 'paused') { this._pausedSecs[t] = remSecs || 0; delete this._finishTimes[t]; }
    else { delete this._finishTimes[t]; delete this._pausedSecs[t]; }
    if (this._hass && this._hass.states[t]) {
      this._hass = { ...this._hass, states: { ...this._hass.states, [t]: { ...this._hass.states[t], state } } };
    }
    this._tick();
  }

  _timerStart(t) {
    const ts = this._hass.states[t];
    const state = ts ? ts.state : 'idle';
    const data = { entity_id: t };
    let secs;
    if (state === 'paused') {
      secs = this._pausedSecs[t] ?? durationToSecs(ts.attributes.remaining);
      // A paused time changed with +/- restarts at the new length; otherwise resume.
      if (secs !== durationToSecs(ts.attributes.remaining)) data.duration = secsToHMS(secs);
    } else {
      secs = this._inputSecs[t] ?? (ts ? durationToSecs(ts.attributes.duration) : 0);
      if (secs > 0) data.duration = secsToHMS(secs);
    }
    this._hass.callService('timer', 'start', data);
    this._optimistic(t, 'active', secs);
  }

  _timerPause(t) {
    const rem = this._finishTimes[t] ? Math.max(0, Math.round((this._finishTimes[t] - Date.now()) / 1000)) : 0;
    this._hass.callService('timer', 'pause', { entity_id: t });
    this._optimistic(t, 'paused', rem);
  }

  _timerStop(t) {
    this._hass.callService('timer', 'cancel', { entity_id: t });
    delete this._inputSecs[t];
    this._optimistic(t, 'idle');
  }

  _timerFinish(t) {
    this._hass.callService('timer', 'finish', { entity_id: t });
    delete this._inputSecs[t];
    this._optimistic(t, 'idle');
  }

  _timerAdjust(t, delta) {
    const ts = this._hass.states[t];
    const state = ts ? ts.state : 'idle';
    const step = this._incrementSecs();
    if (state === 'active') {
      const fin = Math.max(Date.now() + 1000, (this._finishTimes[t] || Date.now()) + delta * step * 1000);
      const rem = Math.round((fin - Date.now()) / 1000);
      this._hass.callService('timer', 'start', { entity_id: t, duration: secsToHMS(rem) });
      this._optimistic(t, 'active', rem);
    } else if (state === 'paused') {
      const cur = this._pausedSecs[t] ?? durationToSecs(ts.attributes.remaining);
      this._pausedSecs[t] = Math.max(step, cur + delta * step);
      this._tick();
    } else {
      const cur = this._inputSecs[t] ?? durationToSecs((ts && ts.attributes.duration) || '0:05:00');
      this._inputSecs[t] = Math.max(step, cur + delta * step);
      this._tick();
    }
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
const THEME_COLORS = [
  ['var(--primary-color)', 'Primary'],
  ['var(--accent-color)', 'Accent'],
  ['var(--primary-text-color)', 'Primary text'],
  ['var(--secondary-text-color)', 'Secondary text'],
  ['var(--disabled-text-color)', 'Disabled text'],
  ['var(--state-active-color)', 'State active'],
  ['var(--error-color)', 'Error'],
  ['var(--warning-color)', 'Warning'],
  ['var(--success-color)', 'Success'],
  ['var(--info-color)', 'Info'],
];

function colorMode(cur) {
  cur = cur == null ? '' : String(cur);
  if (cur === '') return 'default';
  if (/^#[0-9a-fA-F]{3,8}$/.test(cur)) return 'custom';
  if (/^var\(/.test(cur) && THEME_COLORS.some(([v]) => v === cur)) return 'theme';
  return 'css';
}

const EDITOR_CSS = `
        .bmce {
          /* Font sizes (by role, not by pixel) */
          --ltek-fs-panel-title: 16px;  /* top-level panel / section title */
          --ltek-fs-header: 15px;       /* editor header, panel summary */
          --ltek-fs-group: 14px;        /* group heading inside a panel */
          --ltek-fs-label: 13px;        /* standard field label / row */
          --ltek-fs-body: 12px;         /* body text, most controls */
          --ltek-fs-small: 11px;        /* hints, secondary text */
          --ltek-fs-tiny: 10px;         /* badges, micro-labels */
          /* Font weights */
          --ltek-fw-normal: 400;        /* control labels (recede) */
          --ltek-fw-medium: 500;
          --ltek-fw-semibold: 600;
          --ltek-fw-bold: 700;          /* titles, values (lead) */
          /* Text colors */
          --ltek-c-text: var(--primary-text-color, #e1e1e1);  /* primary */
          --ltek-c-label: #ccc;         /* control labels */
          --ltek-c-muted: #888;         /* hints / disabled */
          --ltek-c-accent: var(--primary-color, #2196F3);
          /* Accent tints — hover / active fills (kept as rgba literals; one place
             to change). Default to the Material blue the cards shipped with. */
          --ltek-c-accent-fade: rgba(var(--rgb-primary-color,33,150,243),0.12);       /* active / pressed fill */
          --ltek-c-accent-fade-soft: rgba(var(--rgb-primary-color,33,150,243),0.08);  /* hover fill */
          --ltek-c-error-fade: rgba(244,67,54,0.15);         /* delete hover fill */
          /* Status colors — defer to the user's theme, fall back to Material. */
          --ltek-c-error: var(--error-color, #f44336);
          --ltek-c-success: var(--success-color, #4caf50);
          --ltek-c-warning: var(--warning-color, #ffb300);
          --ltek-c-info: var(--info-color, #2196F3);
          /* Second accent: the green "library / shared" grouping (distinct from
             the blue layout accent on purpose — NOT tied to --primary-color). */
          --ltek-c-accent-lib: #7fd18a;
          --ltek-c-on-accent: #fff;   /* text/icon on a solid accent fill */
          /* Action icons (edit/copy/hide/etc): neutral idle → brighten on hover.
             Delete stays a status color (error) on its own hover. */
          --ltek-c-icon: #aaa;        /* idle action icon */
          --ltek-c-icon-hover: #fff;  /* hovered action icon */
          /* Surfaces */
          --ltek-c-surface: rgba(255,255,255,0.015);        /* panels */
          --ltek-c-surface-raised: rgba(255,255,255,0.02);  /* cards / rows */
          /* Borders */
          --ltek-c-panel-border: #3a3a3a;   /* panels */
          --ltek-c-border: #444;            /* controls */
          --ltek-c-border-soft: #333;       /* subtle inner dividers */
          /* Radii */
          --ltek-r-panel: 12px;   /* panels */
          --ltek-r-card: 10px;    /* section cards */
          --ltek-r-md: 8px;       /* blocks */
          --ltek-r-ctrl: 6px;     /* inputs, selects, buttons */
          /* Spacing scale (4px base) */
          --ltek-sp-1: 4px;
          --ltek-sp-2: 6px;
          --ltek-sp-3: 8px;
          --ltek-sp-4: 10px;
          --ltek-sp-5: 12px;
          --ltek-sp-6: 16px;
          /* Control padding — uniform input/select/button height. */
          --ltek-ctrl-pad: 6px 10px;
          /* Icon sizes (two clear roles; one-off glyphs stay literal). */
          --ltek-icon-sm: 16px;   /* inline / action icons */
          --ltek-icon-lg: 20px;   /* panel-title icons */
          /* Slider row geometry (shared by every slider) */
          --ltek-slider-val-w: 44px;   /* value readout column width */
          display: flex; flex-direction: column; gap: 8px; font-family: var(--paper-font-body1_-_font-family, sans-serif);
        }
        .bmce ha-icon { --mdc-icon-size: 18px; vertical-align: middle; }
        .bmce-sec { border: 1px solid var(--ltek-c-panel-border); border-radius: var(--ltek-r-panel); background: var(--ltek-c-surface); overflow: hidden; }
        .bmce-sec[open] { border-color: var(--ltek-c-accent); }
        .bmce-sec > summary { display: flex; align-items: center; gap: var(--ltek-sp-3); padding: 14px 16px; cursor: pointer; user-select: none;
          list-style: none; font-size: var(--ltek-fs-panel-title); font-weight: var(--ltek-fw-bold); color: var(--ltek-c-text); }
        .bmce-sec > summary::-webkit-details-marker, .bmce-sub > summary::-webkit-details-marker { display: none; }
        .bmce-sec > summary > ha-icon:not(.chev) { color: var(--ltek-c-accent); --mdc-icon-size: var(--ltek-icon-lg); }
        .bmce-sec > summary .chev, .bmce-sub > summary .chev { margin-left: auto; color: #999; --mdc-icon-size: 20px; transition: transform .2s ease; transform: rotate(-90deg); }
        .bmce-sec[open] > summary .chev, .bmce-sub[open] > summary .chev { transform: none; }
        .bmce-body { padding: 0 16px 16px; }
        .bmce-hint { color: var(--ltek-c-muted); font-size: var(--ltek-fs-small); margin: 0 0 var(--ltek-sp-3); }
        .bmce-hint code { font-size: var(--ltek-fs-tiny); }
        .bmce-group { color: var(--accent-color, var(--ltek-c-accent)); font-size: var(--ltek-fs-group); font-weight: var(--ltek-fw-semibold);
          margin-top: var(--ltek-sp-4); padding-top: var(--ltek-sp-3); border-top: 1px solid var(--ltek-c-border-soft); }
        .bmce-group.first { margin-top: 0; padding-top: 0; border-top: none; }
        .bmce-sub { border-top: 1px solid var(--ltek-c-border-soft); border-radius: var(--ltek-r-ctrl); }
        .bmce-sub[open] { border: 1px solid var(--accent-color, var(--ltek-c-accent)); margin: var(--ltek-sp-1) 0; }
        .bmce-sub > summary { display: flex; align-items: center; gap: var(--ltek-sp-2); padding: var(--ltek-sp-3) var(--ltek-sp-2); cursor: pointer;
          list-style: none; color: var(--ltek-c-accent); font-size: var(--ltek-fs-label); font-weight: var(--ltek-fw-semibold);
          text-transform: uppercase; letter-spacing: 0.04em; }
        .bmce-sub-body { padding: 0 var(--ltek-sp-4) var(--ltek-sp-4); }
        .bmce-row { display: flex; align-items: center; gap: var(--ltek-sp-4); padding: var(--ltek-sp-1) 0; flex-wrap: wrap; justify-content: flex-start; }
        .bmce-row label.lbl { color: var(--ltek-c-label); font-size: var(--ltek-fs-body); font-weight: var(--ltek-fw-normal); flex: none; }
        .bmce-row input[type="text"], .bmce-row select { flex: 1 1 auto; min-width: 0; padding: var(--ltek-ctrl-pad);
          background: var(--secondary-background-color, #2a2a2a); border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-ctrl);
          color: var(--ltek-c-text); font-size: var(--ltek-fs-body); }
        .bmce-row input[type="range"] { flex: 1 1 auto; min-width: 100px; accent-color: var(--ltek-c-accent); cursor: pointer; }
        .bmce-val { flex: 0 0 var(--ltek-slider-val-w); text-align: right; font-weight: var(--ltek-fw-bold); font-variant-numeric: tabular-nums;
          white-space: nowrap; color: var(--ltek-c-text); font-size: var(--ltek-fs-body); }
        .bmce-nowrap { flex-wrap: nowrap; }
        .bmce-check { display: flex; align-items: center; gap: var(--ltek-sp-2); padding: var(--ltek-sp-1) 0; color: var(--ltek-c-label);
          font-size: var(--ltek-fs-body); cursor: pointer; }
        .bmce-check input { accent-color: var(--ltek-c-accent); }
        .bmce-check .muted { color: var(--ltek-c-muted); font-size: var(--ltek-fs-small); }
        .bmce-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0 var(--ltek-sp-4); }
        .bmce-color { display: flex; flex: 1 1 auto; gap: var(--ltek-sp-2); flex-wrap: wrap; min-width: 0; }
        .bmce-color select.bmce-cmode { flex: 0 0 auto; min-width: 120px; }
        .bmce-color input[type="color"] { flex: 0 0 auto; width: 44px; height: 30px; padding: 0; border: none; background: none; cursor: pointer; }
        .bmce-reset { border: none; background: none; padding: 0; color: var(--ltek-c-icon); cursor: pointer; }
        .bmce-reset:hover { color: var(--ltek-c-icon-hover); }
        .bmce-reset ha-icon { --mdc-icon-size: var(--ltek-icon-sm); }
        .bmce-list { display: flex; flex-direction: column; gap: var(--ltek-sp-2); }
        .bmce-item { display: flex; align-items: center; gap: var(--ltek-sp-2); padding: var(--ltek-sp-2) var(--ltek-sp-3);
          background: var(--ltek-c-surface-raised); border-radius: var(--ltek-r-card); }
        .bmce-item input[type="text"] { flex: 1 1 0; min-width: 0; padding: var(--ltek-ctrl-pad); background: var(--secondary-background-color, #2a2a2a);
          border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-ctrl); color: var(--ltek-c-text); font-size: var(--ltek-fs-body); }
        .bmce-item > ha-icon { color: var(--ltek-c-accent); --mdc-icon-size: var(--ltek-icon-lg); flex: none; }
        .bmce-del { border: none; background: none; padding: 0; cursor: pointer; color: var(--ltek-c-icon); flex: none; line-height: 0; }
        .bmce-del ha-icon { --mdc-icon-size: var(--ltek-icon-sm); }
        .bmce-del:hover { color: var(--ltek-c-error); }
        .bmce-add { align-self: flex-start; padding: var(--ltek-ctrl-pad); border: 1px dashed var(--ltek-c-accent); border-radius: var(--ltek-r-ctrl);
          background: transparent; color: var(--ltek-c-accent); font-size: var(--ltek-fs-body); font-weight: var(--ltek-fw-semibold); cursor: pointer; }
        .bmce-add:hover { background: var(--ltek-c-accent-fade-soft); }
        .bmce-foot { color: var(--ltek-c-muted); font-size: var(--ltek-fs-tiny); text-align: right; }
        .bmce-name { flex: 1 1 auto; min-width: 0; color: var(--ltek-c-text); font-size: var(--ltek-fs-label); font-weight: var(--ltek-fw-normal);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bmce-badge { flex: none; color: var(--ltek-c-muted); font-size: var(--ltek-fs-tiny); font-variant-numeric: tabular-nums;
          border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-ctrl); padding: 0 var(--ltek-sp-1); }
        .bmce-act { border: none; background: none; padding: 0; cursor: pointer; color: var(--ltek-c-icon); flex: none; line-height: 0; }
        .bmce-act:hover { color: var(--ltek-c-icon-hover); }
        .bmce-act.on { color: var(--ltek-c-accent); }
        .bmce-act:disabled { opacity: .3; cursor: default; }
        .bmce-act ha-icon { --mdc-icon-size: var(--ltek-icon-sm); }
        .bmce-item.off .bmce-name, .bmce-item.off > ha-icon { opacity: .45; }
`;

// Settings that show or hide other settings: changing one re-renders the editor.
const REVEAL_KEYS = new Set(['discovery_mode', 'group_rows', 'show_group_labels', 'show_dividers', 'show_icon', 'show_entity_names',
  'show_toggle', 'show_timer_input', 'show_countdown', 'show_last_changed', 'show_active_count', 'secondary_info_text',
  'collapsible_groups', 'allow_create', 'allow_delete', ...BTN_KEYS]);

class BypassManagerCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._open = new Set(['discovery']);
    this._rendered = false;
    this._cmode = {}; // color key → mode chosen this session (keeps an empty Custom CSS field visible)
  }

  setConfig(config) {
    const next = normalizeConfig(config);
    const changed = JSON.stringify(next) !== JSON.stringify(this._config);
    this._config = next;
    if (!this._rendered || changed) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._render();
  }

  _emit() {
    this._config = normalizeConfig(this._config);
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  /** Write a value; empty or default removes the key (byte-stable YAML). */
  _set(key, value) {
    if (key === 'title' && value === '') { this._config.title = ''; this._emit(); return; } // empty title = no title line
    if (value === '' || value === undefined || value === null || isDefault(key, value)) delete this._config[key];
    else this._config[key] = value;
    this._emit();
  }

  _c(key) { return cfg(this._config, key); }

  _panel(id, icon, title, body) {
    return `<details class="bmce-sec" data-panel="${id}"${this._open.has(id) ? ' open' : ''}>
      <summary><ha-icon icon="${icon}"></ha-icon>${title}<ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></summary>
      <div class="bmce-body">${body}</div></details>`;
  }

  _sub(id, title, body) {
    return `<details class="bmce-sub" data-panel="${id}"${this._open.has(id) ? ' open' : ''}>
      <summary>${title}<ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></summary>
      <div class="bmce-sub-body">${body}</div></details>`;
  }

  _check(key, label, hint = '') {
    return `<label class="bmce-check"><input type="checkbox" data-key="${key}"${this._c(key) ? ' checked' : ''}>${label}${
      hint ? ` <span class="muted">${hint}</span>` : ''}</label>`;
  }

  _text(key, label, placeholder = '') {
    const v = this._config[key] !== undefined ? this._config[key] : '';
    return `<div class="bmce-row"><label class="lbl">${label}</label><input type="text" data-key="${key}" value="${esc(v)}" placeholder="${esc(placeholder)}"></div>`;
  }

  _select(key, label, options) {
    const cur = this._c(key);
    return `<div class="bmce-row"><label class="lbl">${label}</label><select data-key="${key}">${
      options.map(([v, n]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`;
  }

  _slider(key, label, min, max, fmt = (n) => `${n}px`) {
    const v = Number(this._c(key));
    return `<div class="bmce-row bmce-nowrap"><label class="lbl">${label}</label>
      <input type="range" data-skey="${key}" min="${min}" max="${max}" step="1" value="${v}">
      <span class="bmce-val" data-val="${key}">${fmt(v)}</span>
      ${this._config[key] !== undefined ? `<button class="bmce-reset" data-reset="${key}" title="Back to default"><ha-icon icon="mdi:restore"></ha-icon></button>` : ''}</div>`;
  }

  _colorControl(key) {
    const [, label, defaultLabel, seedHex] = COLOR_DEFS.find((d) => d[0] === key);
    const cur = this._config[key] || '';
    const mode = this._cmode[key] || colorMode(cur);
    let field = '';
    if (mode === 'theme') {
      field = `<select class="bmce-ctheme" data-ckey="${key}">${THEME_COLORS.map(([v, n]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    } else if (mode === 'custom') {
      field = `<input type="color" class="bmce-chex" data-ckey="${key}" value="${/^#[0-9a-fA-F]{6}$/.test(cur) ? cur : seedHex}">`;
    } else if (mode === 'css') {
      field = `<input type="text" class="bmce-ccss" data-ckey="${key}" value="${esc(cur)}" placeholder="e.g. tomato, rgba(…), var(--my-color)">`;
    }
    const modes = [['default', defaultLabel], ['theme', 'Theme color'], ['custom', 'Custom color'], ['css', 'Custom CSS']];
    return `<div class="bmce-row"><label class="lbl">${label}</label><div class="bmce-color">
      <select class="bmce-cmode" data-ckey="${key}" data-seed="${seedHex}">${modes.map(([m, n]) => `<option value="${m}"${m === mode ? ' selected' : ''}>${n}</option>`).join('')}</select>
      ${field}</div></div>`;
  }

  _discoveryBody() {
    const c = this._config;
    const label = this._c('discovery_mode') === 'label';
    let found = '';
    if (this._hass) {
      const rows = discover(this._hass, c);
      const sw = rows.filter((r) => r.bool).length;
      const tm = rows.filter((r) => r.timer).length;
      found = `<p class="bmce-hint">Found <b>${rows.length}</b> bypass${rows.length === 1 ? '' : 'es'}: ${sw} switch${sw === 1 ? '' : 'es'}, ${tm} timer${tm === 1 ? '' : 's'}.</p>`;
    }
    return `<p class="bmce-hint">The card finds every bypass on its own: security zones, doors, motion, lights, scenes, locks and anything else.
        Each switch is paired with the timer of the same name.</p>
      ${this._select('discovery_mode', 'Find by', [['prefix', 'Entity ID prefix'], ['label', 'Home Assistant label']])}
      ${label
    ? `${this._text('discovery_label', 'Label', 'bypass')}<p class="bmce-hint">Any <code>input_boolean</code> or <code>timer</code> with this label. "bypass" also matches labels that start with it.</p>`
    : `${this._text('entity_prefix', 'Prefix', 'bypass_')}<p class="bmce-hint">Finds <code>input_boolean.&lt;prefix&gt;…</code> and <code>timer.&lt;prefix&gt;…</code>.</p>`}
      ${found}`;
  }

  _groupsBody() {
    const c = this._config;
    const custom = c.custom_types || [];
    const hidden = new Set(c.hidden_types || []);
    const grouped = this._c('group_rows');
    const collapsible = grouped && this._c('collapsible_groups');
    const collapsed = new Set(c.collapsed_groups || []);
    const order = orderedGroups(c);
    const rows = this._hass ? discover(this._hass, c) : [];
    const counts = {};
    rows.forEach((r) => { const g = groupFor(r.suffix, custom).label; counts[g] = (counts[g] || 0) + 1; });
    const act = (attr, val, icon, title, { disabled = false, on = false } = {}) => `<button class="bmce-act${on ? ' on' : ''}" ${attr}="${esc(val)}" title="${esc(title)}"${
      disabled ? ' disabled' : ''}><ha-icon icon="${icon}"></ha-icon></button>`;
    const legend = [grouped && 'arrows set the order', 'the eye shows or hides a group', collapsible && 'the chevron sets whether it starts open (⌄) or collapsed (›)'].filter(Boolean);
    return `<p class="bmce-hint">Each bypass lands in a group by the first type word in its name (motion, door, window, light, lock, scene, alarm, weather), or in Other.</p>
      <div class="bmce-group first">Groups</div>
      <p class="bmce-hint">On each row, ${legend.join(', ')}.${grouped ? '' : ' Order applies when rows are grouped.'}</p>
      <div class="bmce-list">${order.map((g, i) => {
        const off = hidden.has(g);
        const startsCollapsed = collapsed.has(g);
        return `<div class="bmce-item bmce-grp${off ? ' off' : ''}" data-grp-row="${esc(g)}">
          <ha-icon icon="${esc(groupIcon(g, custom))}"></ha-icon>
          <span class="bmce-name">${esc(g)}</span>${this._hass ? `<span class="bmce-badge" title="Bypasses in this group">${counts[g] || 0}</span>` : ''}
          ${grouped ? `${act('data-grp-up', i, 'mdi:arrow-up', 'Move up', { disabled: i === 0 })}${act('data-grp-down', i, 'mdi:arrow-down', 'Move down', { disabled: i === order.length - 1 })}` : ''}
          ${act('data-grp-vis', g, off ? 'mdi:eye-off-outline' : 'mdi:eye-outline', off ? 'Hidden: tap to show' : 'Shown: tap to hide', { on: !off })}
          ${collapsible ? act('data-grp-start', g, startsCollapsed ? 'mdi:chevron-right' : 'mdi:chevron-down',
    startsCollapsed ? 'Starts collapsed: tap to start open' : 'Starts open: tap to start collapsed', { disabled: off }) : ''}
        </div>`;
      }).join('')}</div>
      ${c.group_order ? '<button class="bmce-add" data-grp-reset>↺ Default order</button>' : ''}
      <div class="bmce-group">Layout</div>
      ${this._check('group_rows', 'Group rows by type', '(off: one list)')}
      ${grouped ? `${this._check('collapsible_groups', 'Groups can be collapsed', '(tap a group title)')}${
    collapsible ? '' : this._check('show_group_labels', 'Show group titles')}${this._check('show_dividers', 'Show a line between groups')}` : ''}
      ${this._select('sort', 'Row order', [['name', 'By name'], ['active', 'Active first, newest change first']])}
      <div class="bmce-group">Custom groups</div>
      <p class="bmce-hint">A keyword found anywhere in a name puts it in your group. Custom groups are checked before the built-in ones.</p>
      <div class="bmce-list">
        <button class="bmce-add" data-ct-add>+ Group</button>
        ${custom.map((ct, i) => `<div class="bmce-item">
          <ha-icon icon="${esc(ct.icon || OTHER_ICON)}"></ha-icon>
          <input type="text" data-ct="${i}" data-field="keyword" value="${esc(ct.keyword || '')}" placeholder="Keyword (fan)">
          <input type="text" data-ct="${i}" data-field="label" value="${esc(ct.label || '')}" placeholder="Group name (Fans)">
          <input type="text" data-ct="${i}" data-field="icon" value="${esc((ct.icon || '').replace(/^mdi:/, ''))}" placeholder="Icon (fan)">
          <button class="bmce-del" data-ct-del="${i}" title="Remove"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button></div>`).join('')}
      </div>`;
  }

  _rowsBody() {
    const anyBtn = BTN_KEYS.some((k) => this._c(k));
    return `<p class="bmce-hint">What each row shows, left to right.</p>
      <div class="bmce-group first">Switch & name</div>
      ${this._check('show_icon', 'Bypass icon', '(tap to turn on / off)')}
      ${this._check('show_entity_names', 'Name', '(tap for details)')}
      ${this._check('show_toggle', 'On / off switch')}
      ${this._c('show_toggle') ? this._check('show_timer_badge', '"timer only" on rows without a switch') : ''}
      <div class="bmce-group">Timer</div>
      ${this._check('show_timer_input', 'Set time', '(editable time + − / + buttons)')}
      ${this._check('show_countdown', 'Countdown while running')}
      ${this._check('show_duration', 'Duration', '(the timer\'s configured length)')}
      <div class="bmce-checks">
        ${this._check('show_btn_start', 'Start')}${this._check('show_btn_pause', 'Pause')}${this._check('show_btn_stop', 'Stop')}${this._check('show_btn_finish', 'Finish')}
      </div>
      ${anyBtn ? this._check('show_button_labels', 'Words on the buttons', '(▶ Start, not just ▶)') : ''}
      ${this._c('show_timer_input') ? `${this._slider('increment_step', '− / + step', 1, 60, (n) => String(n))}
      ${this._select('increment_unit', 'Step unit', [['seconds', 'Seconds'], ['minutes', 'Minutes'], ['hours', 'Hours']])}` : ''}
      <div class="bmce-group">Last changed</div>
      ${this._check('show_last_changed', 'Line under each row: when the switch and timer last changed')}
      ${this._c('show_last_changed') ? this._check('show_exact_time', 'Also the clock time', '(2h 5m ago · 3:41 PM)') : ''}`;
  }

  _headerBody() {
    return `<p class="bmce-hint">The title line. Clear the title to hide it.</p>
      ${this._text('title', 'Title', DEFAULT_TITLE)}
      ${this._text('secondary_info_text', 'Secondary text', 'Optional line under the title')}
      <div class="bmce-group">Active bypasses</div>
      ${this._check('show_active_count', 'Count on the title line', '("3 active" / "All off")')}
      ${this._check('glow_when_active', 'Glow while any bypass is on')}`;
  }

  _namesBody() {
    const words = this._config.strip_words || ['bypass'];
    return `<p class="bmce-hint">Names come from the entity ID: <code>bypass_door_front</code> shows as "Front".</p>
      ${this._check('strip_group_word', 'Remove the group word', '(door, motion, …)')}
      <div class="bmce-group">Remove these words</div>
      <div class="bmce-list">
        <button class="bmce-add" data-sw-add>+ Word</button>
        ${words.map((w, i) => `<div class="bmce-item"><input type="text" data-sw="${i}" value="${esc(w)}" placeholder="word">
          <button class="bmce-del" data-sw-del="${i}" title="Remove"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button></div>`).join('')}
      </div>`;
  }

  _manageBody() {
    const label = this._c('discovery_mode') === 'label';
    const prefix = this._config.entity_prefix || 'bypass_';
    return `<p class="bmce-hint">Create and delete bypass helpers right on the card. A <b>Manage</b> section appears under the title, collapsed,
        with a chip for each. Only admin users see it.</p>
      ${this._check('allow_create', 'Create', '(Timer, Switch, or a Matched set of both)')}
      ${this._check('allow_delete', 'Delete', '(a trash button on each row; asks first)')}
      ${this._c('allow_create') ? `<p class="bmce-hint">New helpers follow the card's naming: prefix + group word + name, so group <b>Door</b> + "Patio" is
        <code>${esc(slugify(`${prefix}door_patio`))}</code>. A name that already has a group word keeps it ("Office light" → <code>${esc(slugify(`${prefix}office_light`))}</code>).${
  label ? ` New helpers also get the "${esc(this._config.discovery_label || 'bypass')}" label so the card finds them.` : ''}</p>` : ''}
      ${this._c('allow_delete') ? '<p class="bmce-hint">Deleting is permanent. Helpers set up in YAML show a lock and can\'t be deleted here.</p>' : ''}`;
  }

  _lookBody() {
    const c = (k) => this._colorControl(k);
    const s = (k) => { const d = SIZE_DEFS.find((x) => x[0] === k); return this._slider(k, d[1], d[2], d[3]); };
    const subs = [
      ['look-title', 'Title', [s('font_size_title'), c('color_card_title'),
        ...(this._c('secondary_info_text') ? [s('secondary_info_size'), c('secondary_info_color')] : [])]],
      ['look-names', 'Names & switch', [s('font_size_name'), c('active_color'), c('color_entity_off')]],
      ...(this._c('show_icon') ? [['look-icons', 'Icons', [s('icon_size'), c('icon_color_on'), c('icon_color_off')]]] : []),
      ...(this._c('group_rows') && (this._c('show_group_labels') || this._c('collapsible_groups') || this._c('show_dividers')) ? [['look-groups', 'Groups', [
        ...(this._c('show_group_labels') || this._c('collapsible_groups') ? [s('font_size_group'), c('color_group_label')] : []),
        ...(this._c('show_dividers') ? [c('color_divider')] : [])]]] : []),
      ...(this._c('show_timer_input') || this._c('show_countdown') ? [['look-timer', 'Timer', [s('font_size_timer')]]] : []),
      ...(this._c('show_last_changed') ? [['look-lc', 'Last changed', [s('font_size_last_changed'), c('color_last_changed')]]] : []),
    ];
    return `<p class="bmce-hint">Sizes and colors. Every color can follow your theme or be custom; ↺ puts a size back to its default.</p>
      ${subs.map(([id, title, rows]) => this._sub(id, title, rows.join(''))).join('')}`;
  }

  _render() {
    this.innerHTML = `<style>${EDITOR_CSS}</style>
      <div class="bmce">
        ${this._panel('discovery', 'mdi:magnify', 'Discovery', this._discoveryBody())}
        ${this._panel('groups', 'mdi:shape-outline', 'Groups & order', this._groupsBody())}
        ${this._panel('rows', 'mdi:view-list-outline', 'Rows & timer controls', this._rowsBody())}
        ${this._panel('manage', 'mdi:wrench-outline', 'Create & delete', this._manageBody())}
        ${this._panel('header', 'mdi:format-title', 'Title', this._headerBody())}
        ${this._panel('names', 'mdi:format-letter-case', 'Names', this._namesBody())}
        ${this._panel('look', 'mdi:palette', 'Appearance', this._lookBody())}
        <div class="bmce-foot">Bypass &amp; Timer Manager Card ${BUILD_NUMBER}</div>
      </div>`;
    this._rendered = true;
    this._wire();
  }

  _wire() {
    const all = (sel, fn) => this.querySelectorAll(sel).forEach(fn);
    all('details.bmce-sec, details.bmce-sub', (d) => d.addEventListener('toggle', () => {
      if (d.open) this._open.add(d.dataset.panel); else this._open.delete(d.dataset.panel);
    }));
    all('[data-key]', (el) => el.addEventListener('change', () => {
      const key = el.dataset.key;
      this._set(key, el.type === 'checkbox' ? el.checked : el.value.trim());
      if (REVEAL_KEYS.has(key) || key === 'entity_prefix' || key === 'discovery_label') this._render();
    }));
    all('[data-skey]', (el) => {
      const key = el.dataset.skey;
      const out = () => this.querySelector(`[data-val="${key}"]`);
      el.addEventListener('input', () => { const o = out(); if (o) o.textContent = key === 'increment_step' ? el.value : `${el.value}px`; });
      el.addEventListener('change', () => { this._set(key, Number(el.value)); this._render(); });
    });
    all('[data-reset]', (b) => b.addEventListener('click', () => { this._set(b.dataset.reset, ''); this._render(); }));
    // Group rows: order, show / hide, start open / collapsed
    const move = (i, d) => {
      const o = orderedGroups(this._config);
      const j = i + d;
      if (j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]];
      this._config.group_order = o;
      this._emit(); this._render();
    };
    all('[data-grp-up]', (b) => b.addEventListener('click', () => move(Number(b.dataset.grpUp), -1)));
    all('[data-grp-down]', (b) => b.addEventListener('click', () => move(Number(b.dataset.grpDown), 1)));
    all('[data-grp-reset]', (b) => b.addEventListener('click', () => { delete this._config.group_order; this._emit(); this._render(); }));
    const flip = (key, g) => {
      const list = this._config[key] || [];
      this._config[key] = list.includes(g) ? list.filter((x) => x !== g) : [...list, g];
      this._emit(); this._render();
    };
    all('[data-grp-vis]', (b) => b.addEventListener('click', () => flip('hidden_types', b.dataset.grpVis)));
    all('[data-grp-start]', (b) => b.addEventListener('click', () => flip('collapsed_groups', b.dataset.grpStart)));
    // Custom groups
    const saveCt = (list) => { this._config.custom_types = list; this._emit(); this._render(); };
    // A renamed group keeps its place, visibility and start state.
    const renameGroup = (from, to) => {
      if (!from || from === to) return;
      for (const k of ['hidden_types', 'collapsed_groups', 'group_order']) {
        if (Array.isArray(this._config[k])) this._config[k] = this._config[k].map((g) => (g === from ? to : g)).filter(Boolean);
      }
    };
    all('[data-ct]', (el) => el.addEventListener('change', () => {
      const list = (this._config.custom_types || []).map((x) => ({ ...x }));
      const item = list[Number(el.dataset.ct)];
      if (!item) return;
      const v = el.value.trim();
      if (el.dataset.field === 'icon') { if (v) item.icon = v.includes(':') ? v : `mdi:${v}`; else delete item.icon; }
      else {
        if (el.dataset.field === 'label') renameGroup(item.label, v);
        item[el.dataset.field] = v;
      }
      saveCt(list);
    }));
    all('[data-ct-del]', (b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.ctDel);
      const removed = (this._config.custom_types || [])[i];
      const list = (this._config.custom_types || []).filter((_, j) => j !== i);
      if (removed && removed.label) {
        for (const k of ['hidden_types', 'collapsed_groups']) {
          if (this._config[k]) this._config[k] = this._config[k].filter((g) => g !== removed.label);
        }
      }
      saveCt(list);
    }));
    all('[data-ct-add]', (b) => b.addEventListener('click', () => {
      // A new row is ignored by the card until it has both a keyword and a group name.
      saveCt([...(this._config.custom_types || []), { keyword: '', label: '' }]);
      const inputs = this.querySelectorAll('[data-field="keyword"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }));
    // Strip words
    const saveSw = (list) => { this._config.strip_words = list; this._emit(); this._render(); };
    all('[data-sw]', (el) => el.addEventListener('change', () => {
      const list = [...(this._config.strip_words || ['bypass'])];
      list[Number(el.dataset.sw)] = el.value.trim();
      saveSw(list.filter(Boolean));
    }));
    all('[data-sw-del]', (b) => b.addEventListener('click', () => {
      saveSw((this._config.strip_words || ['bypass']).filter((_, j) => j !== Number(b.dataset.swDel)));
    }));
    all('[data-sw-add]', (b) => b.addEventListener('click', () => {
      this._config.strip_words = [...(this._config.strip_words || ['bypass']), ''];
      this._render();
      const inputs = this.querySelectorAll('[data-sw]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }));
    // Colors (four-mode control)
    all('.bmce-cmode', (sel) => sel.addEventListener('change', () => {
      const key = sel.dataset.ckey;
      const cur = this._config[key] || '';
      const was = colorMode(cur);
      let next = '';
      // Seed the new mode from the old value; never drop the user's color on a mode change.
      if (sel.value === 'theme') next = was === 'theme' ? cur : 'var(--primary-color)';
      else if (sel.value === 'custom') next = /^#[0-9a-fA-F]{6}$/.test(cur) ? cur : sel.dataset.seed;
      else if (sel.value === 'css') next = cur;
      this._cmode[key] = sel.value;
      this._set(key, next);
      this._render();
    }));
    all('.bmce-ctheme', (el) => el.addEventListener('change', () => this._set(el.dataset.ckey, el.value)));
    all('.bmce-chex', (el) => el.addEventListener('input', () => this._set(el.dataset.ckey, el.value)));
    all('.bmce-ccss', (el) => el.addEventListener('change', () => this._set(el.dataset.ckey, el.value.trim())));
  }
}

// Test hooks (pure helpers; no effect in the browser)
BypassManagerCard._test = {
  BUILD_NUMBER, VERSION, CARD_CSS, EDITOR_CSS, DEFAULTS, COLOR_DEFS, GROUP_ORDER, LEGACY_GROUPS,
  normalizeConfig, groupFor, cleanDisplayName, discover, buildSections, columns, rootStyleVars, colorMode,
  orderedGroups, planHelperName, slugify,
  fmtSecs, fmtDuration, fmtRelTime, fmtClock, parseInput, durationToSecs, secsToHMS,
};

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, BypassManagerCard);
if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, BypassManagerCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: 'Bypass & Timer Manager Card',
    description: 'Finds every bypass switch and timer, pairs and groups them, with full timer control.',
    preview: false,
    documentationURL: 'https://github.com/Ltek/bypass-manager-card',
  });
}

console.info(`%c BYPASS-MANAGER-CARD %c ${BUILD_NUMBER} `, 'color:#fff;background:#2196F3;font-weight:700', 'color:#2196F3;background:transparent');
