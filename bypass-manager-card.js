/**
 * Bypass Manager Card
 *
 * Two discovery modes (discovery_mode):
 *   "prefix" (default) — finds all input_boolean.<prefix>* and timer.<prefix>* entities.
 *   "label"            — finds all input_boolean.* and timer.* that carry a given HA label.
 *
 * In prefix mode the entity_prefix (default "bypass_") is stripped to derive the suffix used
 * for pairing and grouping. In label mode the full object_id (after the domain dot) is used
 * as the suffix, and friendly_name is used for display when available.
 * Pairs them by matching suffix. Unpaired entities show as solo rows.
 *
 * Timer states:
 *   idle    → shows configured duration, Start button
 *   active  → shows countdown, Pause / Cancel / Finish + +/- buttons
 *   paused  → shows remaining time, Start (resume) / Cancel / Finish + +/- buttons
 */

const VERSION = "2026.05.23.31";

const GROUP_ORDER = ["Motion", "Door", "Window", "Light", "Other"];
// INCREMENT_STEP is now read from config (increment_step + increment_unit).
// Helper: resolve config → seconds at runtime (called wherever the step is needed).

function suffixOf(entityId, prefix) {
  const p = (prefix || "bypass_").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = entityId.match(new RegExp(`^(?:input_boolean|timer)\\.${p}(.+)$`));
  return m ? m[1] : null;
}

// customTypes: array of { keyword, label } from config
function allGroups(customTypes) {
  return [...GROUP_ORDER, ...(customTypes || []).map(t => t.label).filter(l => l && !GROUP_ORDER.includes(l))];
}

function groupForSuffix(suffix, customTypes) {
  const s = suffix.toLowerCase();
  // Check custom types first so they can shadow built-ins if desired
  for (const ct of (customTypes || [])) {
    if (ct.keyword && s.includes(ct.keyword.toLowerCase())) return ct.label;
  }
  if (s.includes("motion"))  return "Motion";
  if (s.includes("door"))    return "Door";
  if (s.includes("window"))  return "Window";
  if (s.includes("light"))   return "Light";
  return "Other";
}

/**
 * Core display-name cleaner used by both prefix and label discovery modes.
 *
 * @param {string}   suffix        - Object-ID fragment (after prefix stripped, or full object_id)
 * @param {string[]} stripWords    - Words to remove regardless of position (lowercased comparison)
 * @param {boolean}  stripGroup    - Whether to also remove the group keyword for this suffix
 * @param {Array}    customTypes   - Custom type definitions [{ keyword, label }]
 */
function cleanDisplayName(suffix, stripWords, stripGroup, customTypes) {
  const words = suffix.split("_");

  // Build the full remove-set: user strip words + optionally the group keyword
  const removeSet = new Set((stripWords || []).map(w => w.toLowerCase()));
  if (stripGroup !== false) {
    // Find which group keyword applies to this suffix
    const s = suffix.toLowerCase();
    const builtinKeywords = ["motion", "door", "window", "light"];
    for (const ct of (customTypes || [])) {
      if (ct.keyword && s.includes(ct.keyword.toLowerCase())) {
        removeSet.add(ct.keyword.toLowerCase()); break;
      }
    }
    for (const k of builtinKeywords) {
      if (s.includes(k)) { removeSet.add(k); break; }
    }
  }

  const filtered = words.filter(w => !removeSet.has(w.toLowerCase()));
  // If every word was stripped, fall back to the full suffix title-cased
  const result = filtered.length > 0 ? filtered : words;
  return result.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Backwards-compatible wrapper used by prefix mode (strip_words + strip_group come from config)
function labelFromSuffix(suffix, customTypes, stripWords, stripGroup) {
  return cleanDisplayName(suffix, stripWords, stripGroup, customTypes);
}

// Normalise a string to the slug format HA uses for label IDs (lowercase, spaces→underscores)
function labelSlug(label) {
  return (label || "").toLowerCase().replace(/\s+/g, "_");
}

// Returns true if any of the entity's label IDs match the target slug.
// HA stores label IDs on hass.entities[id].labels (not on hass.states).
// Matching: the target slug must equal a label ID, or a label ID must start
// with the target slug (so "bypass" matches "bypass_helper", "bypass_timer", etc.)
function entityHasLabel(hassEntities, entityId, targetSlug) {
  const entityLabels = hassEntities?.[entityId]?.labels ?? [];
  return entityLabels.some(l => {
    const ls = labelSlug(l);
    return ls === targetSlug || ls.startsWith(targetSlug);
  });
}

// For label-mode: derive a human-readable name from the object_id, stripping
// group keywords (motion, door, window, light + any custom keywords) exactly
// as labelFromSuffix does. friendly_name is intentionally NOT used here —
// it is often set to the full unstripped name (e.g. "Motion Front Door") and
// would undo the cleaning. The object_id is the reliable, consistent source.
function labelFromEntityId(entityId, hassState, customTypes, stripWords, stripGroup) {
  const obj = entityId.replace(/^[^.]+\./, ""); // strip domain
  return cleanDisplayName(obj, stripWords, stripGroup, customTypes);
}

function buildRows(hassStates, hassEntities, allowedGroups, customTypes, prefix, discoveryMode, discoveryLabel, stripWords, stripGroup) {
  const booleans = {}; // suffix → entity id
  const timers   = {}; // suffix → entity id
  const labels   = {}; // suffix → display label (for label-mode)

  if (discoveryMode === "label") {
    // Label-based discovery: scan input_boolean.* and timer.* for entities carrying the label.
    // Labels live on hass.entities[id].labels (array of label ID strings), NOT on hass.states.
    // hassEntities is passed in as the hass.entities map.
    const targetSlug = labelSlug(discoveryLabel || "bypass");
    Object.keys(hassStates).forEach(id => {
      if (!entityHasLabel(hassEntities, id, targetSlug)) return;
      const state = hassStates[id];
      if (id.startsWith("input_boolean.")) {
        const suffix = id.slice("input_boolean.".length);
        booleans[suffix] = id;
        labels[suffix]   = labelFromEntityId(id, state, customTypes, stripWords, stripGroup);
      } else if (id.startsWith("timer.")) {
        const suffix = id.slice("timer.".length);
        timers[suffix] = id;
        if (!labels[suffix]) labels[suffix] = labelFromEntityId(id, state, customTypes, stripWords, stripGroup);
      }
    });
    // For pairs, prefer the boolean's friendly name; fill in from timer if bool absent
    Object.keys(timers).forEach(s => {
      if (!labels[s]) {
        const state = hassStates[timers[s]];
        labels[s] = labelFromEntityId(timers[s], state, customTypes, stripWords, stripGroup);
      }
    });
  } else {
    // Prefix-based discovery (default)
    const pfx = prefix || "bypass_";
    Object.keys(hassStates).forEach(id => {
      const suffix = suffixOf(id, pfx);
      if (!suffix) return;
      if (id.startsWith(`input_boolean.${pfx}`)) booleans[suffix] = id;
      if (id.startsWith(`timer.${pfx}`))         timers[suffix]   = id;
    });
  }

  const order  = allGroups(customTypes);
  const groups = {};
  order.forEach(g => (groups[g] = []));

  const allSuffixes = new Set([...Object.keys(booleans), ...Object.keys(timers)]);
  allSuffixes.forEach(suffix => {
    const group = groupForSuffix(suffix, customTypes);
    if (!groups[group]) groups[group] = [];
    // In label mode use the pre-computed friendly label; in prefix mode derive from suffix
    const displayLabel = discoveryMode === "label"
      ? (labels[suffix] || suffix)
      : labelFromSuffix(suffix, customTypes, stripWords, stripGroup);
    groups[group].push({
      label: displayLabel,
      bool:  booleans[suffix] || null,
      timer: timers[suffix]   || null,
    });
  });

  order.forEach(g => groups[g].sort((a, b) => a.label.localeCompare(b.label)));
  const visible = allowedGroups && allowedGroups.length > 0 ? allowedGroups : order;
  return order.filter(g => visible.includes(g) && groups[g] && groups[g].length > 0)
              .map(g => ({ section: g, rows: groups[g] }));
}

// Parse "H:MM:SS" or "HH:MM:SS" duration string → seconds
function durationToSecs(dur) {
  if (!dur) return 0;
  const parts = dur.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// Seconds → "HH:MM:SS" for service calls
function secsToHMS(secs) {
  secs = Math.max(0, secs);
  return [
    String(Math.floor(secs / 3600)).padStart(2, "0"),
    String(Math.floor((secs % 3600) / 60)).padStart(2, "0"),
    String(secs % 60).padStart(2, "0"),
  ].join(":");
}

// Seconds → human-readable display — always includes seconds so sub-minute
// timers are legible: "1h 05m 30s" / "5m 30s" / "45s"
function fmtSecs(secs) {
  secs = Math.max(0, secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// Format a last-changed timestamp (ISO string or Date) as a relative time string
// e.g. "just now", "2m ago", "1h 15m ago", "3d ago"
function fmtRelTime(isoStr) {
  if (!isoStr) return "—";
  const diffMs = Date.now() - new Date(isoStr).getTime();
  if (isNaN(diffMs) || diffMs < 0) return "—";
  const s = Math.floor(diffMs / 1000);
  if (s < 10)  return "just now";
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24)  return rm > 0 ? `${h}h ${rm}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Parse user-typed duration string → seconds
function parseInput(raw) {
  if (!raw) return 0;
  raw = raw.trim();
  let secs = 0;
  const hm     = raw.match(/^(\d+)h\s*(\d+)m$/i);
  const honly  = raw.match(/^(\d+)h$/i);
  const minsec = raw.match(/^(\d+)m\s*(\d+)s$/i);
  const monly  = raw.match(/^(\d+)m$/i);
  const sonly  = raw.match(/^(\d+)s$/i);
  const plain  = raw.match(/^(\d+)$/);
  if      (hm)     secs = parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60;
  else if (honly)  secs = parseInt(honly[1]) * 3600;
  else if (minsec) secs = parseInt(minsec[1]) * 60 + parseInt(minsec[2]);
  else if (monly)  secs = parseInt(monly[1]) * 60;
  else if (sonly)  secs = parseInt(sonly[1]);
  else if (plain)  secs = parseInt(plain[1]) * 60;
  return secs;
}

// ---------------------------------------------------------------------------

class BypassManagerCard extends HTMLElement {
  constructor() {
    super();
    this._hass        = null;
    this._interval    = null;
    this._finishTimes = {};   // timerEntity → epoch ms (when active)
    this._pausedSecs  = {};   // timerEntity → remaining seconds (when paused)
    this._inputSecs   = {};   // timerEntity → pending seconds in input field
    this._rows        = null;
    this.attachShadow({ mode: "open" });
  }

  // ── Config helpers ────────────────────────────────────────────────────────

  /** Returns the configured +/- step in seconds (default: 60s = 1 minute). */
  _incrementSecs() {
    const cfg   = this._config ?? {};
    const value = Number(cfg.increment_step ?? 1);
    const unit  = cfg.increment_unit ?? "minutes";
    if (unit === "hours")   return value * 3600;
    if (unit === "seconds") return value;
    return value * 60; // minutes (default)
  }

  // ── Optimistic state helpers ──────────────────────────────────────────────

  /**
   * Immediately mirror a timer state change in local caches so _tick()
   * reflects the new state without waiting for the HA websocket update.
   * @param {string} timerId
   * @param {"active"|"paused"|"idle"} newState
   * @param {number} [remSecs]  remaining seconds (required for active/paused)
   */
  _optimisticTimerState(timerId, newState, remSecs) {
    if (newState === "active") {
      this._finishTimes[timerId] = Date.now() + (remSecs ?? 0) * 1000;
      delete this._pausedSecs[timerId];
    } else if (newState === "paused") {
      this._pausedSecs[timerId] = remSecs ?? 0;
      delete this._finishTimes[timerId];
    } else {
      delete this._finishTimes[timerId];
      delete this._pausedSecs[timerId];
    }
    // Patch the local hass states cache so _tick()'s state reads agree.
    if (this._hass?.states[timerId]) {
      this._hass = {
        ...this._hass,
        states: {
          ...this._hass.states,
          [timerId]: { ...this._hass.states[timerId], state: newState },
        },
      };
    }
    this._tick();
  }

  setConfig(config) {
    this._config = config;
    this._showBtnLabels     = config.show_button_labels  === true;  // default: icons only
    this._showToggle        = config.show_toggle         !== false; // default: true
    this._showTimerInput    = config.show_timer_input    !== false; // default: true
    this._showTimerControls = config.show_timer_controls !== false; // default: true
    this._showEntityNames   = config.show_entity_names   !== false; // default: true
    this._showLastChanged   = config.show_last_changed   === true;  // default: false
    this._entityPrefix      = config.entity_prefix       ?? "bypass_";
    this._discoveryMode     = config.discovery_mode      ?? "prefix";
    this._discoveryLabel    = config.discovery_label     ?? "bypass";
  }

  set hass(hass) {
    const firstSet = !this._hass;
    this._hass = hass;
    if (firstSet) {
      this._rows = buildRows(hass.states, hass.entities, this._config?.type_filters, this._config?.custom_types, this._config?.entity_prefix, this._config?.discovery_mode, this._config?.discovery_label, this._config?.strip_words ?? ["bypass"], this._config?.strip_group_word !== false);
      this._render();
      this._startTick();
    } else {
      this._updateStates();
    }
    this._syncTimerTimes();
  }

  // ── Timer sync ───────────────────────────────────────────────────────────

  _syncTimerTimes() {
    if (!this._hass || !this._rows) return;
    this._allTimers().forEach(timerId => {
      const ts = this._hass.states[timerId];
      if (!ts) return;
      if (ts.state === "active" && ts.attributes.finishes_at) {
        this._finishTimes[timerId] = new Date(ts.attributes.finishes_at).getTime();
        delete this._pausedSecs[timerId];
      } else if (ts.state === "paused") {
        const rem = durationToSecs(ts.attributes.remaining);
        this._pausedSecs[timerId] = rem;
        delete this._finishTimes[timerId];
      } else {
        delete this._finishTimes[timerId];
        delete this._pausedSecs[timerId];
      }
    });
  }

  _allTimers() {
    if (!this._rows) return [];
    return this._rows.flatMap(s => s.rows.map(r => r.timer).filter(Boolean));
  }

  // ── Tick ─────────────────────────────────────────────────────────────────

  _startTick() { this._interval = setInterval(() => this._tick(), 1000); }

  _tick() {
    if (!this._rows) return;
    const now = Date.now();
    this._allTimers().forEach(timerId => {
      const inp       = this.shadowRoot.querySelector(`[data-input="${timerId}"]`);
      const cdEl      = this.shadowRoot.querySelector(`[data-countdown="${timerId}"]`);
      const adjBtns   = this.shadowRoot.querySelectorAll(`[data-adj="${timerId}"]`);
      const timerBtns = this.shadowRoot.querySelector(`[data-timer-btns="${timerId}"]`);
      const ts        = this._hass && this._hass.states[timerId];
      if (!ts) return;

      const state = ts.state; // idle | active | paused

      if (state === "active") {
        // Hide editable input + adj buttons; show read-only countdown
        if (inp)  inp.style.display  = "none";
        if (cdEl) {
          cdEl.style.display = "";
          const fin = this._finishTimes[timerId];
          if (fin) {
            const rem = Math.max(0, Math.round((fin - now) / 1000));
            cdEl.textContent = fmtSecs(rem);
            cdEl.className   = "countdown running";
          }
        }
        adjBtns.forEach(b => (b.style.display = "none"));
      } else {
        // idle or paused — show editable input + adj buttons; hide countdown span
        if (inp)  inp.style.display  = "";
        if (cdEl) cdEl.style.display = "none";
        adjBtns.forEach(b => (b.style.display = ""));

        // Write current value into the input (don't overwrite while user is focused)
        if (inp && document.activeElement !== inp) {
          let secs;
          if (state === "paused") {
            secs = this._pausedSecs[timerId] ?? durationToSecs(ts.attributes.remaining);
          } else {
            secs = this._inputSecs[timerId] ?? durationToSecs(ts.attributes.duration);
          }
          inp.value     = fmtSecs(secs);
          inp.className = `timer-input ${state}`; // adds .paused styling when needed
        }
      }

      // Show/hide correct action button set
      if (timerBtns) {
        timerBtns.querySelectorAll("[data-btn-state]").forEach(el => {
          const visible = el.dataset.btnState.split(",").includes(state);
          el.style.display = visible ? "" : "none";
        });
      }
    });

    // Update last-changed relative times
    if (this._showLastChanged && this._hass) {
      this.shadowRoot.querySelectorAll("[data-lc-bool]").forEach(el => {
        const s = this._hass.states[el.dataset.lcBool];
        if (s) el.textContent = fmtRelTime(s.last_changed);
      });
      this.shadowRoot.querySelectorAll("[data-lc-timer]").forEach(el => {
        const s = this._hass.states[el.dataset.lcTimer];
        if (s) el.textContent = fmtRelTime(s.last_changed);
      });
    }
  }

  // ── State updates (booleans) ─────────────────────────────────────────────

  _updateStates() {
    if (!this._hass || !this._rows) return;
    this._rows.forEach(s => s.rows.forEach(row => {
      if (!row.bool) return;
      const bs  = this._hass.states[row.bool];
      const tog = this.shadowRoot.querySelector(`[data-bool="${row.bool}"]`);
      if (tog && bs) {
        const on = bs.state === "on";
        tog.checked = on;
        tog.closest(".row")?.classList.toggle("active", on);
      }
    }));
  }

  // ── Service calls ────────────────────────────────────────────────────────

  _toggleBool(entityId, currentState) {
    this._hass.callService("input_boolean",
      currentState === "on" ? "turn_off" : "turn_on",
      { entity_id: entityId });
  }

  _timerStart(timerId) {
    const ts   = this._hass && this._hass.states[timerId];
    const secs = this._inputSecs[timerId]
      ?? (ts ? durationToSecs(ts.attributes.duration) : 0);
    const data = { entity_id: timerId };
    if (secs && secs > 0) data.duration = secsToHMS(secs);
    this._hass.callService("timer", "start", data);
    // Optimistic: show as active immediately
    this._optimisticTimerState(timerId, "active", secs || durationToSecs(ts?.attributes?.duration));
  }

  _timerPause(timerId) {
    // Optimistic: snapshot remaining time from the finish time we're tracking
    const remSecs = this._finishTimes[timerId]
      ? Math.max(0, Math.round((this._finishTimes[timerId] - Date.now()) / 1000))
      : 0;
    this._hass.callService("timer", "pause", { entity_id: timerId });
    this._optimisticTimerState(timerId, "paused", remSecs);
  }

  _timerCancel(timerId) {
    this._hass.callService("timer", "cancel", { entity_id: timerId });
    delete this._inputSecs[timerId];
    this._optimisticTimerState(timerId, "idle");
  }

  _timerFinish(timerId) {
    this._hass.callService("timer", "finish", { entity_id: timerId });
    delete this._inputSecs[timerId];
    this._optimisticTimerState(timerId, "idle");
  }

  _timerAdjust(timerId, delta) {
    const ts    = this._hass && this._hass.states[timerId];
    const state = ts ? ts.state : "idle";
    const step  = this._incrementSecs();

    if (state === "active") {
      const fin    = this._finishTimes[timerId] || Date.now();
      const newFin = Math.max(Date.now() + 1000, fin + delta * step * 1000);
      const remSecs = Math.round((newFin - Date.now()) / 1000);
      this._finishTimes[timerId] = newFin;
      // Restart with new duration so HA is in sync; also optimistic-update
      this._hass.callService("timer", "start", { entity_id: timerId, duration: secsToHMS(remSecs) });
      this._optimisticTimerState(timerId, "active", remSecs);
    } else if (state === "paused") {
      const cur = this._pausedSecs[timerId] ?? durationToSecs(ts.attributes.remaining);
      const next = Math.max(step, cur + delta * step);
      this._pausedSecs[timerId] = next;
      this._tick();
    } else {
      // idle — adjust the pending input value
      const cur = this._inputSecs[timerId] ?? durationToSecs(ts?.attributes?.duration ?? "0:05:00");
      this._inputSecs[timerId] = Math.max(step, cur + delta * step);
      const inp = this.shadowRoot.querySelector(`[data-input="${timerId}"]`);
      if (inp) inp.value = fmtSecs(this._inputSecs[timerId]);
    }
  }

  // ── Row HTML ─────────────────────────────────────────────────────────────

  _rowHtml(row) {
    const hasBool           = !!row.bool;
    const hasTimer          = !!row.timer;
    const sl                = this._showBtnLabels;
    const showBadge         = this._config?.show_timer_badge === true;
    const showToggle        = this._showToggle;
    const showTimerInput    = this._showTimerInput;
    const showTimerControls = this._showTimerControls;
    const showEntityNames   = this._showEntityNames;

    const timerOnlyHtml = showBadge ? `<span class="solo-timer-badge">timer only</span>` : "";

    // Determine which column is rightmost (carries the 16px right padding)
    const lastCol =
      showToggle        ? "toggle" :
      showTimerInput    ? "input"  :
      showTimerControls ? "btns"   : "name";

    const col1 = showEntityNames
      ? `<span class="col-name label${lastCol === "name" ? " col-last" : ""}">${row.label}</span>`
      : "";

    const col2 = showTimerControls ? `<span class="col-btns${lastCol === "btns" ? " col-last" : ""}">${hasTimer ? `<span class="timer-btns" data-timer-btns="${row.timer}">
          <button class="btn btn-start"  data-btn-state="idle,paused"   data-start="${row.timer}"  title="Start">▶${sl ? " Start" : ""}</button>
          <button class="btn btn-pause"  data-btn-state="active"        data-pause="${row.timer}"  title="Pause"  style="display:none">⏸${sl ? " Pause" : ""}</button>
          <button class="btn btn-cancel" data-btn-state="active,paused" data-cancel="${row.timer}" title="Cancel" style="display:none">✕${sl ? " Cancel" : ""}</button>
          <button class="btn btn-finish" data-btn-state="active,paused" data-finish="${row.timer}" title="Finish" style="display:none">✓${sl ? " Finish" : ""}</button>
        </span>` : ""}</span>` : "";

    const col3 = showTimerInput ? `<span class="col-input${lastCol === "input" ? " col-last" : ""}">${hasTimer ? `<span class="timer-input-wrap">
          <button class="btn btn-adj" data-adj="${row.timer}" data-delta="-1">−</button>
          <input class="timer-input idle" type="text" placeholder="5m" title="e.g. 30m, 1h, 2h30m" data-input="${row.timer}" />
          <span class="countdown running" data-countdown="${row.timer}" style="display:none">—</span>
          <button class="btn btn-adj" data-adj="${row.timer}" data-delta="1">+</button>
        </span>` : ""}</span>` : "";

    const col4 = showToggle ? `<span class="col-toggle col-last">${hasBool ? `<ha-switch data-bool="${row.bool}"></ha-switch>` : timerOnlyHtml}</span>` : "";

    // Last-changed sub-row (always rendered, visibility controlled by CSS display)
    const lcBoolId  = row.bool  ? `data-lc-bool="${row.bool}"`   : "";
    const lcTimerId = row.timer ? `data-lc-timer="${row.timer}"` : "";
    const lastChangedRow = `<div class="row-last-changed" ${row.bool ? `data-lc-row="${row.bool}"` : ""}>
        ${row.bool  ? `<span>Switch: <span ${lcBoolId}>—</span></span>`  : ""}
        ${row.timer ? `<span>Timer: <span ${lcTimerId}>—</span></span>` : ""}
      </div>`;

    return `
      <div class="row${hasBool ? "" : " solo-timer"}" ${hasBool ? `data-row="${row.bool}"` : ""}>
        ${col1}${col2}${col3}${col4}
      </div>
      ${lastChangedRow}`;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  _render() {
    const cfg             = this._config ?? {};
    const title           = cfg.title           ?? "BYPASS & TIMER MANAGER";
    const activeColor     = cfg.active_color    ?? "var(--primary-color)";
    const fontTitle       = cfg.font_size_title ? `${cfg.font_size_title}px` : "13px";
    const fontName        = cfg.font_size_name  ? `${cfg.font_size_name}px` : "14px";
    const fontGroup       = cfg.font_size_group ? `${cfg.font_size_group}px` : "11px";
    const fontTimer       = cfg.font_size_timer ? `${cfg.font_size_timer}px` : "13px";
    const colorCardTitle  = cfg.color_card_title  ?? "var(--secondary-text-color)";
    const colorGroupLabel = cfg.color_group_label ?? "var(--secondary-text-color)";
    const colorDivider    = cfg.color_divider     ?? "var(--divider-color)";
    const colorEntityOff  = cfg.color_entity_off  ?? "var(--primary-text-color)";
    const secInfoText     = cfg.secondary_info_text ?? "";
    const secInfoSize     = cfg.secondary_info_size ? `${cfg.secondary_info_size}px` : "11px";
    const secInfoColor    = cfg.secondary_info_color ?? "var(--primary-color)";
    const showLastChanged = cfg.show_last_changed === true; // default: false
    const fontLastChanged = cfg.font_size_last_changed ? `${cfg.font_size_last_changed}px` : "11px";
    const colorLastChanged = cfg.color_last_changed ?? "var(--secondary-text-color)";
    // Sync instance flags (setConfig may have been called before _render)
    this._showToggle        = cfg.show_toggle         !== false;
    this._showTimerInput    = cfg.show_timer_input    !== false;
    this._showTimerControls = cfg.show_timer_controls !== false;
    this._showEntityNames   = cfg.show_entity_names   !== false;
    this._showLastChanged   = cfg.show_last_changed   === true;
    this._entityPrefix      = cfg.entity_prefix       ?? "bypass_";
    // Rebuild rows in case prefix or filters changed
    if (this._hass) {
      this._discoveryMode  = cfg.discovery_mode  ?? "prefix";
      this._discoveryLabel = cfg.discovery_label ?? "bypass";
      this._rows = buildRows(this._hass.states, this._hass.entities, cfg.type_filters, cfg.custom_types, this._entityPrefix, this._discoveryMode, this._discoveryLabel, cfg.strip_words ?? ["bypass"], cfg.strip_group_word !== false);
    }
    const showGroupLabels  = cfg.show_group_labels  !== false; // default: true
    const showDividers     = cfg.show_dividers      !== false; // default: true
    // Grid: optional [name] [ctrl-btns (optional)], then optional [input] [toggle]
    const gridCols = [
      this._showEntityNames   ? "1fr"         : null,
      this._showTimerControls ? "max-content" : null,
      this._showTimerInput    ? "max-content" : null,
      this._showToggle        ? "max-content" : null,
    ].filter(Boolean).join(" ");

    const sectionsHtml = this._rows.map((section, si) => `
      ${si > 0 && showDividers ? '<div class="divider"></div>' : ""}
      ${showGroupLabels ? `<div class="section-label">${section.section}</div>` : ""}
      ${section.rows.map(row => this._rowHtml(row)).join("")}
    `).join("");

    this.shadowRoot.innerHTML = `
<style>
  :host { display: block; font-family: var(--primary-font-family, sans-serif); }
  .card { background: var(--card-background-color); border-radius: var(--ha-card-border-radius, 12px); padding: 12px 0 8px; }
  .card-title { font-size: ${fontTitle}; font-weight: 600; letter-spacing: .05em; color: ${colorCardTitle}; padding: 0 16px 4px; }
  .card-secondary { font-size: ${secInfoSize}; font-weight: 500; letter-spacing: 0; text-transform: none; color: ${secInfoColor}; padding: 0 16px 8px; display: ${secInfoText ? "block" : "none"}; }
  .section-label { font-size: ${fontGroup}; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: ${colorGroupLabel}; opacity: .7; padding: 10px 16px 4px; }

  /* ── Grid layout ── */
  .card { display: grid !important;
          grid-template-columns: ${gridCols};
          align-items: center;
          column-gap: 12px; }
  .card-title  { grid-column: 1 / -1; }
  .card-secondary { grid-column: 1 / -1; }
  .section-label, .divider { grid-column: 1 / -1; }

  .row { display: contents; }
  .row > span { padding: 5px 0; }
  .row-last-changed { grid-column: 1 / -1; font-size: ${fontLastChanged}; color: ${colorLastChanged};
                      padding: 0 16px 6px; display: ${showLastChanged ? "flex" : "none"};
                      gap: 16px; flex-wrap: wrap; }

  .row:hover > span { background: var(--secondary-background-color); }
  .row.active .label { color: ${activeColor}; font-weight: 700; }
  .row.solo-timer > span { opacity: .75; }

  /* Column 1 — Name */
  .col-name { padding-left: 16px !important; font-size: ${fontName}; color: var(--primary-text-color);
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 400; }
  .row:not(.active) .col-name { color: ${colorEntityOff}; }

  /* Countdown span */
  .countdown { font-size: ${fontTimer}; font-family: var(--paper-font-code_-_font-family, monospace);
               font-weight: 600; min-width: 80px; text-align: center; display: inline-block; }
  .countdown.running { color: var(--primary-color); }

  /* Column 2 — Control buttons (left-justified) */
  .col-btns { display: flex; justify-content: flex-start; }
  .timer-btns { display: inline-flex; gap: 6px; }

  /* Column 3 — Input / countdown */
  .col-input { }
  .timer-input-wrap { display: inline-flex; align-items: center; gap: 4px; }
  .timer-input { height: 26px; width: 80px; font-size: 12px; padding: 0 6px;
                 border: 1px solid var(--divider-color); border-radius: 6px;
                 background: var(--card-background-color); color: var(--primary-text-color);
                 text-align: center; }
  .timer-input:focus { outline: none; border-color: var(--primary-color); }
  .timer-input.paused { border-color: var(--warning-color, #f4b942);
                        color: var(--warning-color, #f4b942); }

  /* Column 4 — Toggle */
  .col-toggle { }
  /* Always pad the rightmost visible column */
  .col-last { padding-right: 16px !important; }
  .btn { height: 26px; padding: 0 8px; font-size: 11px; font-weight: 500; border: none; border-radius: 6px; cursor: pointer; white-space: nowrap; transition: opacity .15s; line-height: 26px; }
  .btn:active { opacity: .7; }
  .btn-adj    { width: 26px; padding: 0; text-align: center; background: var(--secondary-background-color); color: var(--primary-text-color); font-size: 16px; line-height: 24px; }
  .btn-start  { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .btn-pause  { background: var(--warning-color, #f4b942); color: #000; }
  .btn-cancel { background: var(--error-color, #db4437); color: #fff; }
  .btn-finish { background: var(--success-color, #43a047); color: #fff; }

  .solo-timer-badge { font-size: 10px; color: var(--disabled-text-color, var(--secondary-text-color)); font-style: italic; padding-right: 4px; padding-top: 6px; }
  ha-switch { --mdc-theme-secondary: ${activeColor}; }
  .divider { height: 1px; background: ${colorDivider}; margin: 4px 16px; opacity: .5; }
</style>
<ha-card class="card">
  <div class="card-title">${title}</div>
  <div class="card-secondary">${secInfoText}</div>
  ${sectionsHtml}
</ha-card>`;

    // Boolean toggles
    this.shadowRoot.querySelectorAll("ha-switch").forEach(sw => {
      sw.addEventListener("change", () => {
        const bs = this._hass?.states[sw.dataset.bool];
        if (bs) this._toggleBool(sw.dataset.bool, bs.state);
      });
    });

    // Timer action buttons
    this.shadowRoot.querySelectorAll("[data-start]").forEach(btn =>
      btn.addEventListener("click", () => this._timerStart(btn.dataset.start)));
    this.shadowRoot.querySelectorAll("[data-pause]").forEach(btn =>
      btn.addEventListener("click", () => this._timerPause(btn.dataset.pause)));
    this.shadowRoot.querySelectorAll("[data-cancel]").forEach(btn =>
      btn.addEventListener("click", () => this._timerCancel(btn.dataset.cancel)));
    this.shadowRoot.querySelectorAll("[data-finish]").forEach(btn =>
      btn.addEventListener("click", () => this._timerFinish(btn.dataset.finish)));

    // +/- adjust buttons
    this.shadowRoot.querySelectorAll("[data-adj]").forEach(btn =>
      btn.addEventListener("click", () =>
        this._timerAdjust(btn.dataset.adj, parseInt(btn.dataset.delta))));

    // Manual input field — update _inputSecs on change
    this.shadowRoot.querySelectorAll("[data-input]").forEach(inp => {
      const update = () => {
        const secs = parseInput(inp.value);
        if (secs > 0) {
          this._inputSecs[inp.dataset.input] = secs;
          // _tick() will reflect the new value on the next cycle;
          // for instant feedback, force a tick now only when idle
          const ts = this._hass && this._hass.states[inp.dataset.input];
          if (!ts || ts.state === "idle") this._tick();
        }
      };
      inp.addEventListener("change", update);
      inp.addEventListener("input",  update);
    });

    this._updateStates();
    this._syncTimerTimes();
    this._tick();
  }

  disconnectedCallback() { if (this._interval) clearInterval(this._interval); }

  getCardSize() {
    return this._rows
      ? this._rows.reduce((n, s) => n + s.rows.length, 0) + this._rows.length
      : 12;
  }

  static getConfigElement() { return document.createElement("bypass-manager-card-editor"); }
  static getStubConfig()    { return { title: "BYPASS & TIMER MANAGER", type_filters: ["Motion","Door","Window","Light","Other"] }; }
}

customElements.define("bypass-manager-card", BypassManagerCard);

// ---------------------------------------------------------------------------
// Visual Editor
// ---------------------------------------------------------------------------

class BypassManagerCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  // Fire the HA config-changed event so the editor saves the new value
  _fire(config) {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  _set(key, value) {
    const next = { ...this._config, [key]: value };
    // Remove keys that match defaults to keep YAML tidy
    if (key === "title"              && value === "BYPASS & TIMER MANAGER")           delete next.title;
    if (key === "entity_prefix"      && (!value || value === "bypass_"))              delete next.entity_prefix;
    if (key === "discovery_mode"     && value === "prefix")                           delete next.discovery_mode;
    if (key === "discovery_label"    && (!value || value === "bypass"))               delete next.discovery_label;
    if (key === "show_button_labels" && value === false)                              delete next.show_button_labels;
    if (key === "active_color"       && (!value || value === ""))                     delete next.active_color;
    if (key === "color_card_title"   && (!value || value === ""))                     delete next.color_card_title;
    if (key === "color_group_label"  && (!value || value === ""))                     delete next.color_group_label;
    if (key === "color_divider"      && (!value || value === ""))                     delete next.color_divider;
    if (key === "color_entity_off"   && (!value || value === ""))                     delete next.color_entity_off;
    if (key === "secondary_info_text"  && (!value || value === ""))                  delete next.secondary_info_text;
    if (key === "secondary_info_size"  && (!value || value === 11))                  delete next.secondary_info_size;
    if (key === "secondary_info_color" && (!value || value === ""))                  delete next.secondary_info_color;
    if (key === "show_last_changed"    && value === false)                            delete next.show_last_changed;
    if (key === "font_size_last_changed" && (!value || value === 11))                delete next.font_size_last_changed;
    if (key === "color_last_changed"   && (!value || value === ""))                  delete next.color_last_changed;
    if (key === "font_size_name"     && (!value || value === 14))                     delete next.font_size_name;
    if (key === "font_size_group"    && (!value || value === 11))                     delete next.font_size_group;
    if (key === "font_size_timer"    && (!value || value === 13))                     delete next.font_size_timer;
    if (key === "show_timer_badge"   && value === false)                              delete next.show_timer_badge;
    if (key === "show_toggle"          && value === true)  delete next.show_toggle;
    if (key === "show_timer_controls"  && value === true)  delete next.show_timer_controls;
    if (key === "show_entity_names"    && value === true)  delete next.show_entity_names;
    if (key === "font_size_title"      && (!value || value === 13)) delete next.font_size_title;
    if (key === "show_timer_input"    && value === true)                               delete next.show_timer_input;
    if (key === "show_group_labels"    && value === true)                               delete next.show_group_labels;
    if (key === "show_dividers"        && value === true)                               delete next.show_dividers;
    if (key === "custom_types"       && (!value || value.length === 0))               delete next.custom_types;
    if (key === "increment_step"     && (value === 1 || value === "1"))               delete next.increment_step;
    if (key === "increment_unit"     && value === "minutes")                          delete next.increment_unit;
    if (key === "strip_words"       && (!value || (value.length === 1 && value[0] === "bypass"))) delete next.strip_words;
    if (key === "strip_group_word"  && value === true)                                             delete next.strip_group_word;
    this._config = next;
    this._fire(next);
  }

  _render() {
    const cfg             = this._config;
    const title           = cfg.title              ?? "BYPASS & TIMER MANAGER";
    const entityPrefix    = cfg.entity_prefix      ?? "bypass_";
    const discoveryMode   = cfg.discovery_mode     ?? "prefix";
    const discoveryLabel  = cfg.discovery_label    ?? "bypass";
    const showBtnLabels   = cfg.show_button_labels === true;
    const showBadge       = cfg.show_timer_badge   === true;
    const activeColor     = cfg.active_color       ?? "";
    const colorCardTitle  = cfg.color_card_title   ?? "";
    const colorGroupLabel = cfg.color_group_label  ?? "";
    const colorDivider    = cfg.color_divider      ?? "";
    const colorEntityOff  = cfg.color_entity_off   ?? "";
    const secInfoText     = cfg.secondary_info_text  ?? "";
    const secInfoSize     = cfg.secondary_info_size  ?? 11;
    const secInfoColor    = cfg.secondary_info_color ?? "";
    const showLastChanged = cfg.show_last_changed    === true;
    const fontLastChanged = cfg.font_size_last_changed ?? 11;
    const colorLastChanged = cfg.color_last_changed  ?? "";
    const fontTitle       = cfg.font_size_title    ?? 13;
    const fontName        = cfg.font_size_name     ?? 14;
    const fontGroup       = cfg.font_size_group    ?? 11;
    const fontTimer       = cfg.font_size_timer    ?? 13;
    const incrementStep   = cfg.increment_step     ?? 1;
    const incrementUnit   = cfg.increment_unit     ?? "minutes";
    const showToggle        = cfg.show_toggle         !== false;
    const showTimerInput    = cfg.show_timer_input    !== false;
    const showTimerControls = cfg.show_timer_controls !== false;
    const showEntityNames   = cfg.show_entity_names   !== false;
    const showGroupLabels   = cfg.show_group_labels   !== false;
    const showDividers      = cfg.show_dividers       !== false;
    const typeFilters     = cfg.type_filters       ?? [...GROUP_ORDER];
    const customTypes     = cfg.custom_types       ?? [];   // [{ keyword, label }]
    const stripWords      = cfg.strip_words       ?? ["bypass"];
    const stripGroupWord  = cfg.strip_group_word  !== false; // default: true

    // All groups = built-ins + any custom labels
    const allGroupsList = allGroups(customTypes);

    // Filter chips — built-ins + custom labels
    const filterBoxes = allGroupsList.map(g => `
      <label class="chip ${typeFilters.includes(g) ? "chip-on" : ""}">
        <input type="checkbox" class="filter-check" data-group="${g}" ${typeFilters.includes(g) ? "checked" : ""} />
        ${g}
      </label>`).join("");

    // Custom type rows
    const customRows = customTypes.map((ct, i) => `
      <div class="ct-row" data-index="${i}">
        <input class="text-input ct-keyword" type="text" placeholder="keyword (e.g. fan)"
               value="${(ct.keyword || "").replace(/"/g, "&quot;")}" data-field="keyword" data-index="${i}">
        <input class="text-input ct-label"   type="text" placeholder="group label (e.g. Fan)"
               value="${(ct.label   || "").replace(/"/g, "&quot;")}" data-field="label"   data-index="${i}">
        <button class="ct-remove" data-index="${i}" title="Remove">✕</button>
      </div>`).join("");

    this.shadowRoot.innerHTML = `
<style>
  :host { display: block; }
  .editor { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; }

  .section-header {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .07em; color: var(--secondary-text-color);
    border-bottom: 1px solid var(--divider-color);
    padding-bottom: 6px; margin-bottom: 2px;
  }

  .field-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; }
  .field-row.col { flex-direction: column; align-items: stretch; gap: 6px; }

  .field-label { font-size: 13px; color: var(--primary-text-color); flex: 1; line-height: 1.3; }
  .field-hint  { font-size: 11px; color: var(--secondary-text-color); margin-top: 2px; display: block; }

  .text-input, .num-input {
    height: 34px; padding: 0 10px; font-size: 13px;
    border: 1px solid var(--divider-color); border-radius: 8px;
    background: var(--card-background-color); color: var(--primary-text-color);
    box-sizing: border-box;
  }
  .text-input { width: 100%; }
  .num-input  { width: 72px; text-align: center; }
  .text-input:focus, .num-input:focus { outline: none; border-color: var(--primary-color); }

  /* Color */
  .color-row { display: flex; align-items: center; gap: 8px; }
  .color-swatch { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--divider-color);
                  padding: 2px; cursor: pointer; background: var(--card-background-color); flex-shrink: 0; }
  .color-swatch input[type=color] { width: 100%; height: 100%; border: none; background: none;
                                     padding: 0; cursor: pointer; border-radius: 6px; }
  .color-text { flex: 1; }
  .color-clear { height: 34px; padding: 0 10px; font-size: 12px; border: 1px solid var(--divider-color);
                 border-radius: 8px; background: transparent; color: var(--secondary-text-color);
                 cursor: pointer; white-space: nowrap; }
  .color-clear:hover { border-color: var(--primary-color); color: var(--primary-color); }

  /* Font size */
  .font-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; }

  /* Timer increment */
  .increment-row { display: flex; align-items: center; gap: 8px; }
  .unit-select { height: 34px; padding: 0 10px; font-size: 13px;
                 border: 1px solid var(--divider-color); border-radius: 8px;
                 background: var(--card-background-color); color: var(--primary-text-color);
                 cursor: pointer; }
  .unit-select:focus { outline: none; border-color: var(--primary-color); }

  /* Segmented button group */
  .seg-group { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 8px; overflow: hidden; align-self: flex-start; }
  .seg-btn { height: 34px; padding: 0 16px; font-size: 13px; font-weight: 500; border: none; border-right: 1px solid var(--divider-color);
             background: var(--card-background-color); color: var(--secondary-text-color); cursor: pointer; transition: background .15s, color .15s; }
  .seg-btn:last-child { border-right: none; }
  .seg-btn:hover { background: var(--secondary-background-color); }
  .seg-btn.seg-on { background: color-mix(in srgb, var(--primary-color) 15%, transparent); color: var(--primary-color); font-weight: 600; }

  /* Filter chips */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px 4px 8px;
          border-radius: 20px; font-size: 12px; cursor: pointer; border: 1px solid var(--divider-color);
          color: var(--secondary-text-color); background: var(--card-background-color);
          user-select: none; transition: all .15s; }
  .chip input[type=checkbox] { accent-color: var(--primary-color); width: 13px; height: 13px; }
  .chip-on { border-color: var(--primary-color); color: var(--primary-color);
             background: color-mix(in srgb, var(--primary-color) 10%, transparent); }

  /* Custom types list & strip-words list */
  .ct-list, .sw-list { display: flex; flex-direction: column; gap: 8px; }
  .sw-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; }
  .sw-row .text-input { font-size: 12px; height: 30px; }
  .ct-row { display: grid; grid-template-columns: 1fr 1fr auto; align-items: center; gap: 8px; }
  .ct-row .text-input { font-size: 12px; height: 30px; }
  .ct-remove { height: 30px; width: 30px; border: 1px solid var(--divider-color); border-radius: 8px;
               background: transparent; color: var(--error-color, #db4437); cursor: pointer;
               font-size: 13px; display: flex; align-items: center; justify-content: center;
               flex-shrink: 0; transition: background .15s; }
  .ct-remove:hover { background: color-mix(in srgb, var(--error-color, #db4437) 12%, transparent); }
  .ct-header { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; }
  .ct-header span { font-size: 10px; font-weight: 600; text-transform: uppercase;
                    letter-spacing: .05em; color: var(--secondary-text-color); padding: 0 2px; }
  .btn-add { height: 32px; padding: 0 14px; font-size: 12px; font-weight: 600;
             border: 1px dashed var(--primary-color); border-radius: 8px;
             background: transparent; color: var(--primary-color); cursor: pointer;
             align-self: flex-start; transition: background .15s; }
  .btn-add:hover { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }

  ha-switch { --mdc-theme-secondary: var(--primary-color); flex-shrink: 0; }

  /* Grouped sub-fields shown beneath a toggle or heading */
  .sub-fields { display: flex; flex-direction: column; gap: 10px;
                border-left: 2px solid var(--divider-color); margin-left: 4px; padding-left: 12px; }

  .info-box { background: var(--secondary-background-color); border-radius: 8px; padding: 10px 12px;
              font-size: 12px; color: var(--secondary-text-color); line-height: 1.5; }
  .info-box code { font-family: var(--paper-font-code_-_font-family, monospace);
                   background: var(--divider-color); border-radius: 3px; padding: 1px 4px; font-size: 11px; }
</style>

<div class="editor">

  <!-- ── How it works ── -->
  <div class="section-header">About — v${VERSION}</div>
  <div class="info-box">
    This card <strong>auto-discovers</strong> entities — no manual list needed.<br>
    In <strong>Prefix</strong> mode it pairs every <code>input_boolean.&lt;prefix&gt;*</code> with a matching <code>timer.&lt;prefix&gt;*</code>.<br>
    In <strong>Label</strong> mode it finds any <code>input_boolean</code> or <code>timer</code> tagged with the chosen HA label, and pairs them by matching object ID.<br>
    Rows are grouped by type (<em>Motion, Door, Window, Light, Other</em> + custom types).
  </div>

  <!-- ── Discovery ── -->
  <div class="section-header">Discovery</div>

  <div class="field-row col">
    <label class="field-label">Discovery mode
      <span class="field-hint">How the card finds bypass entities. <strong>Prefix</strong> matches entity IDs starting with the given prefix. <strong>Label</strong> finds any <code>input_boolean</code> or <code>timer</code> tagged with a specific HA label.</span>
    </label>
    <div class="seg-group" id="discovery_mode_group">
      <button class="seg-btn ${discoveryMode === "prefix" ? "seg-on" : ""}" data-mode="prefix">Prefix</button>
      <button class="seg-btn ${discoveryMode === "label"  ? "seg-on" : ""}" data-mode="label">Label</button>
    </div>
  </div>

  <div class="field-row col" id="prefix_row" style="${discoveryMode === "label" ? "display:none" : ""}">
    <label class="field-label">Entity prefix
      <span class="field-hint">The card looks for <code>input_boolean.&lt;prefix&gt;*</code> and <code>timer.&lt;prefix&gt;*</code>. Default: <code>bypass_</code></span>
    </label>
    <input id="entity_prefix" class="text-input" type="text" placeholder="bypass_"
           value="${entityPrefix.replace(/"/g, "&quot;")}">
  </div>

  <div class="field-row col" id="label_row" style="${discoveryMode !== "label" ? "display:none" : ""}">
    <label class="field-label">HA label
      <span class="field-hint">The card finds all <code>input_boolean</code> and <code>timer</code> entities that have this label assigned in Home Assistant. Default: <code>bypass</code>. Partial matches work — <code>bypass</code> matches <em>bypass_helper</em>, <em>bypass_timer</em>, etc.</span>
    </label>
    <input id="discovery_label" class="text-input" type="text" placeholder="bypass"
           value="${discoveryLabel.replace(/"/g, "&quot;")}">
  </div>

  <!-- ── Entity Groups ── -->
  <div class="section-header">Entity Groups</div>
  <div class="field-row col">
    <label class="field-label">Show only these entity types
      <span class="field-hint">Uncheck a group to hide it entirely from the card. Custom types appear here automatically.</span>
    </label>
    <div class="chips" id="filter-chips">${filterBoxes}</div>
  </div>

  <div class="field-row col">
    <label class="field-label">Custom entity groups
      <span class="field-hint">Each entry maps a keyword (matched against the entity suffix) to a group label. Custom types are checked before built-ins.</span>
    </label>
    <div class="ct-list" id="ct-list">
      ${customTypes.length > 0 ? `
      <div class="ct-header">
        <span>Keyword (suffix match)</span>
        <span>Group label</span>
        <span></span>
      </div>` : ""}
      ${customRows}
    </div>
    <button class="btn-add" id="ct-add">+ Add type</button>
  </div>

  <!-- ── Name Cleaning ── -->
  <div class="section-header">Name cleaning</div>
  <div class="field-row col">
    <label class="field-label">Words to remove from display names
      <span class="field-hint">These words are stripped (case-insensitive) from entity names. Add or remove words to suit your naming convention.</span>
    </label>
    <div class="sw-list" id="sw-list">
      ${stripWords.map((w, i) => `
        <div class="sw-row">
          <input class="text-input sw-word" type="text" value="${w.replace(/"/g, "&quot;")}" data-index="${i}" placeholder="word">
          <button class="ct-remove sw-remove" data-index="${i}" title="Remove">✕</button>
        </div>`).join("")}
    </div>
    <button class="btn-add" id="sw-add">+ Add word</button>
  </div>

  <div class="field-row">
    <label class="field-label" for="strip_group_word">Remove group name from display name
      <span class="field-hint">Strip the group keyword (Motion, Door, Window, etc.) from each entity's display name.</span>
    </label>
    <ha-switch id="strip_group_word" ${stripGroupWord ? "checked" : ""}></ha-switch>
  </div>

  <!-- ── Timer increment ── -->
  <div class="section-header">Timer increment</div>
  <div class="field-row col">
    <label class="field-label">+/- button step
      <span class="field-hint">How much each + or − press adjusts a timer. Default: 1 minute.</span>
    </label>
    <div class="increment-row">
      <input id="increment_step" class="num-input" type="number" min="1" max="999" step="1" value="${incrementStep}">
      <select id="increment_unit" class="unit-select">
        <option value="seconds" ${incrementUnit === "seconds" ? "selected" : ""}>seconds</option>
        <option value="minutes" ${incrementUnit === "minutes" ? "selected" : ""}>minutes</option>
        <option value="hours"   ${incrementUnit === "hours"   ? "selected" : ""}>hours</option>
      </select>
    </div>
  </div>

  <!-- ── Appearance ── -->
  <div class="section-header">Appearance</div>

  <!-- Toggle-only items (no font/color sub-options) -->
  <div class="field-row">
    <label class="field-label" for="show_button_labels">Show button labels
      <span class="field-hint">Add text next to ▶ ⏸ ✕ ✓ icons.</span>
    </label>
    <ha-switch id="show_button_labels" ${showBtnLabels ? "checked" : ""}></ha-switch>
  </div>

  <!-- Last changed row — toggle + font size + color -->
  <div class="field-row">
    <label class="field-label" for="show_last_changed">Show last changed row
      <span class="field-hint">Display a second line under each entity row showing when the switch and timer last changed.</span>
    </label>
    <ha-switch id="show_last_changed" ${showLastChanged ? "checked" : ""}></ha-switch>
  </div>
  <div class="sub-fields" id="last_changed_sub" style="${showLastChanged ? "" : "display:none"}">
    <div class="field-row font-row">
      <label class="field-label" for="font_size_last_changed">Font size
        <span class="field-hint">Default: 11</span>
      </label>
      <input id="font_size_last_changed" class="num-input" type="number" min="8" max="24" step="1" value="${fontLastChanged}">
    </div>
    <div class="field-row col">
      <label class="field-label">Color
        <span class="field-hint">Leave blank to use the theme secondary text color.</span>
      </label>
      <div class="color-row">
        <div class="color-swatch"><input type="color" id="color_last_changed_picker" value="${colorLastChanged.startsWith("#") ? colorLastChanged : "#9e9e9e"}"></div>
        <input id="color_last_changed" class="text-input color-text" type="text" placeholder="var(--secondary-text-color) or #hex" value="${colorLastChanged.replace(/"/g, "&quot;")}">
        <button class="color-clear" id="color_last_changed_clear">Reset</button>
      </div>
    </div>
  </div>

  <div class="field-row">
    <label class="field-label" for="show_timer_badge">Show "timer only" badge
      <span class="field-hint">Show an italic "timer only" label on rows that have a timer but no bypass switch.</span>
    </label>
    <ha-switch id="show_timer_badge" ${showBadge ? "checked" : ""}></ha-switch>
  </div>

  <!-- Card title — text + font size + color -->
  <div class="field-row col">
    <label class="field-label">Card title
      <span class="field-hint">Shown at the top of the card.</span>
    </label>
    <input id="title" class="text-input" type="text" placeholder="BYPASS &amp; TIMER MANAGER"
           value="${title.replace(/"/g, "&quot;")}">
    <div class="sub-fields">
      <div class="field-row font-row">
        <label class="field-label" for="font_size_title">Font size
          <span class="field-hint">Default: 13</span>
        </label>
        <input id="font_size_title" class="num-input" type="number" min="8" max="32" step="1" value="${fontTitle}">
      </div>
      <div class="field-row col">
        <label class="field-label">Color
          <span class="field-hint">Leave blank to use the theme color.</span>
        </label>
        <div class="color-row">
          <div class="color-swatch"><input type="color" id="color_card_title_picker" value="${colorCardTitle.startsWith("#") ? colorCardTitle : "#9e9e9e"}"></div>
          <input id="color_card_title" class="text-input color-text" type="text" placeholder="var(--secondary-text-color) or #hex" value="${colorCardTitle.replace(/"/g, "&quot;")}">
          <button class="color-clear" id="color_card_title_clear">Reset</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Secondary info — text + font size + color -->
  <div class="field-row col">
    <label class="field-label">Secondary information text
      <span class="field-hint">Optional line shown below the card title. Leave blank to hide.</span>
    </label>
    <input id="secondary_info_text" class="text-input" type="text" placeholder="e.g. v2026.05 · Main Floor"
           value="${secInfoText.replace(/"/g, "&quot;")}">
    <div class="sub-fields">
      <div class="field-row font-row">
        <label class="field-label" for="secondary_info_size">Font size
          <span class="field-hint">Default: 11</span>
        </label>
        <input id="secondary_info_size" class="num-input" type="number" min="8" max="32" step="1" value="${secInfoSize}">
      </div>
      <div class="field-row col">
        <label class="field-label">Color
          <span class="field-hint">Leave blank to use the theme accent color.</span>
        </label>
        <div class="color-row">
          <div class="color-swatch"><input type="color" id="secondary_info_color_picker" value="${secInfoColor.startsWith("#") ? secInfoColor : "#03a9f4"}"></div>
          <input id="secondary_info_color" class="text-input color-text" type="text" placeholder="var(--primary-color) or #hex" value="${secInfoColor.replace(/"/g, "&quot;")}">
          <button class="color-clear" id="secondary_info_color_clear">Reset</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Entity names — toggle + font size + color (off state) -->
  <div class="field-row">
    <label class="field-label" for="show_entity_names">Show entity names
      <span class="field-hint">Show the entity name on each row.</span>
    </label>
    <ha-switch id="show_entity_names" ${showEntityNames ? "checked" : ""}></ha-switch>
  </div>
  <div class="sub-fields">
    <div class="field-row font-row">
      <label class="field-label" for="font_size_name">Font size
        <span class="field-hint">Default: 14</span>
      </label>
      <input id="font_size_name" class="num-input" type="number" min="8" max="32" step="1" value="${fontName}">
    </div>
    <div class="field-row col">
      <label class="field-label">Color (Off state)
        <span class="field-hint">Entity name color when bypass is off. Leave blank to use theme color.</span>
      </label>
      <div class="color-row">
        <div class="color-swatch"><input type="color" id="color_entity_off_picker" value="${colorEntityOff.startsWith("#") ? colorEntityOff : "#212121"}"></div>
        <input id="color_entity_off" class="text-input color-text" type="text" placeholder="var(--primary-text-color) or #hex" value="${colorEntityOff.replace(/"/g, "&quot;")}">
        <button class="color-clear" id="color_entity_off_clear">Reset</button>
      </div>
    </div>
  </div>

  <!-- Group section titles — toggle + font size + color -->
  <div class="field-row">
    <label class="field-label" for="show_group_labels">Show group titles
      <span class="field-hint">Show the Motion / Door / Window … headings above each group.</span>
    </label>
    <ha-switch id="show_group_labels" ${showGroupLabels ? "checked" : ""}></ha-switch>
  </div>
  <div class="sub-fields">
    <div class="field-row font-row">
      <label class="field-label" for="font_size_group">Font size
        <span class="field-hint">Default: 11</span>
      </label>
      <input id="font_size_group" class="num-input" type="number" min="8" max="24" step="1" value="${fontGroup}">
    </div>
    <div class="field-row col">
      <label class="field-label">Color
        <span class="field-hint">Leave blank to use the theme color.</span>
      </label>
      <div class="color-row">
        <div class="color-swatch"><input type="color" id="color_group_label_picker" value="${colorGroupLabel.startsWith("#") ? colorGroupLabel : "#9e9e9e"}"></div>
        <input id="color_group_label" class="text-input color-text" type="text" placeholder="var(--secondary-text-color) or #hex" value="${colorGroupLabel.replace(/"/g, "&quot;")}">
        <button class="color-clear" id="color_group_label_clear">Reset</button>
      </div>
    </div>
  </div>

  <!-- Divider lines — toggle + color -->
  <div class="field-row">
    <label class="field-label" for="show_dividers">Show divider lines
      <span class="field-hint">Show the horizontal rule between groups.</span>
    </label>
    <ha-switch id="show_dividers" ${showDividers ? "checked" : ""}></ha-switch>
  </div>
  <div class="sub-fields">
    <div class="field-row col">
      <label class="field-label">Divider color
        <span class="field-hint">Leave blank to use the theme color.</span>
      </label>
      <div class="color-row">
        <div class="color-swatch"><input type="color" id="color_divider_picker" value="${colorDivider.startsWith("#") ? colorDivider : "#e0e0e0"}"></div>
        <input id="color_divider" class="text-input color-text" type="text" placeholder="var(--divider-color) or #hex" value="${colorDivider.replace(/"/g, "&quot;")}">
        <button class="color-clear" id="color_divider_clear">Reset</button>
      </div>
    </div>
  </div>

  <!-- On/Off toggle — toggle + active color -->
  <div class="field-row">
    <label class="field-label" for="show_toggle">Show on/off toggle
      <span class="field-hint">Show the boolean bypass switch on each row.</span>
    </label>
    <ha-switch id="show_toggle" ${showToggle ? "checked" : ""}></ha-switch>
  </div>
  <div class="sub-fields">
    <div class="field-row col">
      <label class="field-label">'On' color
        <span class="field-hint">Color of the switch and row label when active. Leave blank to use the theme color.</span>
      </label>
      <div class="color-row">
        <div class="color-swatch"><input type="color" id="active_color_picker" value="${activeColor || "#03a9f4"}"></div>
        <input id="active_color" class="text-input color-text" type="text" placeholder="var(--primary-color) or #hex" value="${activeColor.replace(/"/g, "&quot;")}">
        <button class="color-clear" id="active_color_clear">Reset</button>
      </div>
    </div>
  </div>

  <!-- Timer controls — toggle only -->
  <div class="field-row">
    <label class="field-label" for="show_timer_controls">Show timer controls
      <span class="field-hint">Show the Start / Pause / Cancel / Finish buttons.</span>
    </label>
    <ha-switch id="show_timer_controls" ${showTimerControls ? "checked" : ""}></ha-switch>
  </div>

  <!-- Timer time control — toggle + countdown font size -->
  <div class="field-row">
    <label class="field-label" for="show_timer_input">Show timer time control
      <span class="field-hint">Show the editable duration input, countdown, and +/− buttons.</span>
    </label>
    <ha-switch id="show_timer_input" ${showTimerInput ? "checked" : ""}></ha-switch>
  </div>
  <div class="sub-fields">
    <div class="field-row font-row">
      <label class="field-label" for="font_size_timer">Countdown font size
        <span class="field-hint">Default: 13</span>
      </label>
      <input id="font_size_timer" class="num-input" type="number" min="8" max="32" step="1" value="${fontTimer}">
    </div>
  </div>

</div>`;

    // ── Title ──
    const titleEl = this.shadowRoot.getElementById("title");
    titleEl.addEventListener("change", () => this._set("title", titleEl.value || "BYPASS & TIMER MANAGER"));

    // ── Discovery mode (segmented button group) ──
    const modeGroup = this.shadowRoot.getElementById("discovery_mode_group");
    const prefixRow = this.shadowRoot.getElementById("prefix_row");
    const labelRow  = this.shadowRoot.getElementById("label_row");
    modeGroup.querySelectorAll(".seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        this._set("discovery_mode", mode);
        // Toggle visibility of the relevant sub-field rows
        prefixRow.style.display = mode === "label"  ? "none" : "";
        labelRow.style.display  = mode === "label"  ? ""     : "none";
        // Update active button styling without full re-render
        modeGroup.querySelectorAll(".seg-btn").forEach(b =>
          b.classList.toggle("seg-on", b.dataset.mode === mode));
      });
    });

    // ── Entity prefix ──
    const prefixEl = this.shadowRoot.getElementById("entity_prefix");
    prefixEl?.addEventListener("change", () => this._set("entity_prefix", prefixEl.value.trim() || "bypass_"));

    // ── Discovery label ──
    const discoveryLabelEl = this.shadowRoot.getElementById("discovery_label");
    discoveryLabelEl?.addEventListener("change", () => this._set("discovery_label", discoveryLabelEl.value.trim() || "bypass"));

    // ── Show button labels ──
    const lblEl = this.shadowRoot.getElementById("show_button_labels");
    lblEl.addEventListener("change", () => this._set("show_button_labels", lblEl.checked));

    // ── Show timer badge ──
    const badgeEl = this.shadowRoot.getElementById("show_timer_badge");
    badgeEl.addEventListener("change", () => this._set("show_timer_badge", badgeEl.checked));

    // ── Show/hide toggles ──
    const showToggleEl         = this.shadowRoot.getElementById("show_toggle");
    const showTimerInputEl     = this.shadowRoot.getElementById("show_timer_input");
    const showTimerControlsEl  = this.shadowRoot.getElementById("show_timer_controls");
    const showEntityNamesEl    = this.shadowRoot.getElementById("show_entity_names");
    const showGroupLabelsEl    = this.shadowRoot.getElementById("show_group_labels");
    const showDividersEl       = this.shadowRoot.getElementById("show_dividers");
    showToggleEl.addEventListener("change",        () => this._set("show_toggle",         showToggleEl.checked));
    showTimerInputEl.addEventListener("change",    () => this._set("show_timer_input",    showTimerInputEl.checked));
    showTimerControlsEl.addEventListener("change", () => this._set("show_timer_controls", showTimerControlsEl.checked));
    showEntityNamesEl.addEventListener("change",   () => this._set("show_entity_names",   showEntityNamesEl.checked));
    showGroupLabelsEl.addEventListener("change",   () => this._set("show_group_labels",   showGroupLabelsEl.checked));
    showDividersEl.addEventListener("change",      () => this._set("show_dividers",       showDividersEl.checked));

    // ── Active color ──
    const colorPicker = this.shadowRoot.getElementById("active_color_picker");
    const colorText   = this.shadowRoot.getElementById("active_color");
    const colorClear  = this.shadowRoot.getElementById("active_color_clear");
    colorPicker.addEventListener("input", () => {
      colorText.value = colorPicker.value;
      this._set("active_color", colorPicker.value);
    });
    colorText.addEventListener("change", () => {
      const v = colorText.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) colorPicker.value = v;
      this._set("active_color", v);
    });
    colorClear.addEventListener("click", () => {
      colorText.value = ""; colorPicker.value = "#03a9f4";
      this._set("active_color", "");
    });

    // ── Helper to wire up a color field ──
    const wireColor = (key, pickerId, textId, clearId, fallback) => {
      const picker = this.shadowRoot.getElementById(pickerId);
      const text   = this.shadowRoot.getElementById(textId);
      const clear  = this.shadowRoot.getElementById(clearId);
      if (!picker || !text || !clear) return;
      picker.addEventListener("input", () => {
        text.value = picker.value;
        this._set(key, picker.value);
      });
      text.addEventListener("change", () => {
        const v = text.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) picker.value = v;
        this._set(key, v);
      });
      clear.addEventListener("click", () => {
        text.value = ""; picker.value = fallback;
        this._set(key, "");
      });
    };
    wireColor("color_card_title",  "color_card_title_picker",  "color_card_title",  "color_card_title_clear",  "#9e9e9e");
    wireColor("color_group_label", "color_group_label_picker", "color_group_label", "color_group_label_clear", "#9e9e9e");
    wireColor("color_divider",     "color_divider_picker",     "color_divider",     "color_divider_clear",     "#e0e0e0");
    wireColor("color_entity_off",  "color_entity_off_picker",  "color_entity_off",  "color_entity_off_clear",  "#212121");
    wireColor("secondary_info_color", "secondary_info_color_picker", "secondary_info_color", "secondary_info_color_clear", "#03a9f4");
    wireColor("color_last_changed",   "color_last_changed_picker",   "color_last_changed",   "color_last_changed_clear",   "#9e9e9e");

    // ── Secondary info text ──
    const secTextEl = this.shadowRoot.getElementById("secondary_info_text");
    secTextEl?.addEventListener("change", () => this._set("secondary_info_text", secTextEl.value.trim()));

    // ── Secondary info font size ──
    const secSizeEl = this.shadowRoot.getElementById("secondary_info_size");
    secSizeEl?.addEventListener("change", () => {
      const v = parseInt(secSizeEl.value);
      if (!isNaN(v) && v >= 8) this._set("secondary_info_size", v);
    });

    // ── Show last changed toggle (with conditional sub-fields) ──
    const showLcEl         = this.shadowRoot.getElementById("show_last_changed");
    const lcSubEl          = this.shadowRoot.getElementById("last_changed_sub");
    showLcEl?.addEventListener("change", () => {
      const on = showLcEl.checked;
      this._set("show_last_changed", on);
      if (lcSubEl) lcSubEl.style.display = on ? "" : "none";
    });

    // ── Last changed font size ──
    const lcFontEl = this.shadowRoot.getElementById("font_size_last_changed");
    lcFontEl?.addEventListener("change", () => {
      const v = parseInt(lcFontEl.value);
      if (!isNaN(v) && v >= 8) this._set("font_size_last_changed", v);
    });

    // ── Font sizes ──
    ["font_size_title", "font_size_name", "font_size_group", "font_size_timer"].forEach(id => {
      const el = this.shadowRoot.getElementById(id);
      el.addEventListener("change", () => {
        const v = parseInt(el.value);
        if (!isNaN(v) && v >= 8) this._set(id, v);
      });
    });

    // ── Timer increment step + unit ──
    const incrStepEl = this.shadowRoot.getElementById("increment_step");
    const incrUnitEl = this.shadowRoot.getElementById("increment_unit");
    const saveIncrement = () => {
      const v = parseInt(incrStepEl.value);
      if (!isNaN(v) && v >= 1) this._set("increment_step", v);
      this._set("increment_unit", incrUnitEl.value);
    };
    incrStepEl.addEventListener("change", saveIncrement);
    incrUnitEl.addEventListener("change", saveIncrement);

    // ── Custom types — helper to read all rows and save ──
    const saveCustomTypes = () => {
      const rows = [...this.shadowRoot.querySelectorAll(".ct-row")].map(row => ({
        keyword: row.querySelector("[data-field=keyword]").value.trim(),
        label:   row.querySelector("[data-field=label]").value.trim(),
      })).filter(r => r.keyword || r.label);
      this._set("custom_types", rows);
      // Re-render so filter chips update; preserve scroll position
      const scrollY = this.shadowRoot.host?.closest(".editor-container")?.scrollTop ?? 0;
      this._render();
      this.shadowRoot.host?.closest(".editor-container")?.scrollTo(0, scrollY);
    };

    // Input changes on existing rows
    this.shadowRoot.querySelectorAll(".ct-row input").forEach(inp => {
      inp.addEventListener("change", saveCustomTypes);
    });

    // Remove buttons
    this.shadowRoot.querySelectorAll(".ct-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index);
        const next = [...customTypes];
        next.splice(idx, 1);
        this._set("custom_types", next);
        this._render();
      });
    });

    // Add button
    this.shadowRoot.getElementById("ct-add").addEventListener("click", () => {
      const next = [...customTypes, { keyword: "", label: "" }];
      this._set("custom_types", next);
      this._render();
      // Focus the new keyword input
      const rows = this.shadowRoot.querySelectorAll(".ct-row");
      rows[rows.length - 1]?.querySelector("[data-field=keyword]")?.focus();
    });

    // ── Strip words ──
    const saveStripWords = () => {
      const words = [...this.shadowRoot.querySelectorAll(".sw-word")]
        .map(el => el.value.trim()).filter(Boolean);
      this._set("strip_words", words.length > 0 ? words : ["bypass"]);
      const scrollY = this.shadowRoot.host?.closest(".editor-container")?.scrollTop ?? 0;
      this._render();
      this.shadowRoot.host?.closest(".editor-container")?.scrollTo(0, scrollY);
    };
    this.shadowRoot.querySelectorAll(".sw-word").forEach(inp =>
      inp.addEventListener("change", saveStripWords));
    this.shadowRoot.querySelectorAll(".sw-remove").forEach(btn =>
      btn.addEventListener("click", () => {
        const next = [...stripWords];
        next.splice(parseInt(btn.dataset.index), 1);
        this._set("strip_words", next.length > 0 ? next : []);
        this._render();
      }));
    this.shadowRoot.getElementById("sw-add")?.addEventListener("click", () => {
      const next = [...stripWords, ""];
      this._set("strip_words", next);
      this._render();
      const rows = this.shadowRoot.querySelectorAll(".sw-word");
      rows[rows.length - 1]?.focus();
    });

    // ── Strip group word toggle ──
    const stripGroupEl = this.shadowRoot.getElementById("strip_group_word");
    stripGroupEl?.addEventListener("change", () => this._set("strip_group_word", stripGroupEl.checked));

    // ── Group filter chips ──
    this.shadowRoot.querySelectorAll(".filter-check").forEach(cb => {
      cb.addEventListener("change", () => {
        const checked = [...this.shadowRoot.querySelectorAll(".filter-check")]
          .filter(c => c.checked).map(c => c.dataset.group);
        if (checked.length === 0) { cb.checked = true; return; }
        cb.closest(".chip").classList.toggle("chip-on", cb.checked);
        this._set("type_filters", checked);
      });
    });
  }
}

customElements.define("bypass-manager-card-editor", BypassManagerCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type:        "bypass-manager-card",
  name:        "Bypass Manager Card",
  description: "Auto-discovers bypass input_boolean + timer pairs and groups them by type.",
});