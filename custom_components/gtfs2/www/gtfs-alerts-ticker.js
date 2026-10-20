/**
 * gtfs-alerts-ticker
 * A scrolling ticker card for gtfs2 alerts.
 *
 * Config:
 *   type: custom:gtfs-alerts-ticker
 *   routes:
 *     - entity: sensor.my_gtfs2_route
 *     - entity: sensor.my_gtfs2_route_2
 *   scroll_speed: 60          # optional — pixels per second, default 60
 *   height: 36                # optional — px, default 36
 *   background: "#0a0d12"     # optional
 *   color: "#fbbf24"          # optional — alert text colour
 *   icon: "⚠"                 # optional — prefix icon
 *   separator: "   ·   "      # optional — between alerts
 *   show_if_empty: false      # optional — hide card when no alerts, default true
 *   exclude_alert_keywords: ["elevator"] # optional — case-insensitive
 */

// Expanded/collapsed state keyed by route list, kept outside the class so it
// survives Lovelace tearing down and recreating the element (which happens
// on setConfig re-runs, theme changes, view reflows, etc). Without this the
// panel silently collapses on every rebuild even though nothing "closed" it.
const expandedState = new Map();

// Feed-supplied text (alerts) is rendered via innerHTML, so escape it first.
const escTicker = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

class GtfsAlertsTicker extends HTMLElement {

  setConfig(config) {
    if (!config.routes || !config.routes.length) {
      throw new Error('Define at least one route in the routes list.');
    }
    this.config = config;
    this._animFrame = null;
    this._offset = 0;
    this._lastTs = null;
    this._loopWidth = 0;
    this._text = '';
    this._resizeObserver = null;

    // setConfig can be called again on the same element (theme change, view
    // re-render, returning from the edit dialog...). Don't reset expanded
    // state on those re-runs — only initialize it the first time, and
    // restore whatever was last recorded for this exact set of routes.
    this._stateKey = config.routes.map(r => r.entity).sort().join('|');
    if (this._expanded === undefined) {
      this._expanded = expandedState.get(this._stateKey) ?? false;
    }
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    const changed = !prev || (this.config?.routes || []).some(r =>
      hass.states[r.entity] !== prev.states[r.entity]
    );
    if (changed) this._updateAlerts();
  }

  connectedCallback() {
    this._startTicker();
    if (!this._resizeObserver && 'ResizeObserver' in window) {
      this._resizeObserver = new ResizeObserver(() => this._buildTrack());
      this._resizeObserver.observe(this);
    }
  }

  disconnectedCallback() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  _collectAlerts() {
    if (!this._hass) return [];
    const seen = new Set();
    const alerts = [];
    for (const r of this.config.routes) {
      const ent = this._hass.states[r.entity];
      if (!ent) continue;
      const a = ent.attributes;
      const exclusions = [
        ...(Array.isArray(this.config.exclude_alert_keywords)
          ? this.config.exclude_alert_keywords
          : []),
        ...(Array.isArray(r.exclude_alert_keywords)
          ? r.exclude_alert_keywords
          : []),
      ]
        .map(keyword => String(keyword).trim().toLowerCase())
        .filter(Boolean);
      [a.origin_stop_alert, a.destination_stop_alert].forEach(v => {
        if (
          v &&
          v.toLowerCase() !== 'no info' &&
          !exclusions.some(keyword => v.toLowerCase().includes(keyword)) &&
          !seen.has(v)
        ) {
          seen.add(v);
          alerts.push(v);
        }
      });
    }
    return alerts;
  }

  _updateAlerts() {
    const alerts = this._collectAlerts();
    const showIfEmpty = this.config.show_if_empty !== false;

    if (!alerts.length && !showIfEmpty) {
      this.style.display = 'none';
      return;
    }
    this.style.display = '';

    const icon  = this.config.icon      ?? '⚠';
    const sep   = this.config.separator  ?? '   ·   ';
    const color = this.config.color      || '#fbbf24';
    const bg    = this.config.background || '#0a0d12';
    const height = this.config.height    || 36;

    const text = alerts.length
      ? alerts.map(a => `${escTicker(icon)} ${escTicker(a)}`).join(escTicker(sep))
      : 'No current alerts';
    const alertDetails = alerts.length
      ? alerts.map(alert => `<div class="alert-detail"><span>${escTicker(icon)}</span>${escTicker(alert)}</div>`).join('')
      : '<div class="alert-detail">No current alerts</div>';

    // Build the shell (styles + skeleton) exactly once. GTFS sensors push a
    // new state object on almost every poll even when the alert text itself
    // hasn't changed, and alert text can also mutate slightly ("10 minutes"
    // -> "15 minutes") on legitimate updates. Rebuilding the whole shadow
    // tree on those polls reset the scroll offset (looked like a jump) and
    // re-added click/keydown listeners every time (event handlers piling
    // up, so one click could fire the toggle N times). Now the shell is
    // built once, and only the parts that actually changed get patched.
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }
          ha-card {
            background: ${bg};
            border-radius: 8px;
            overflow: hidden;
            min-height: ${height}px;
            display: flex;
            flex-direction: column;
            border: 1px solid rgba(255,255,255,0.07);
            cursor: pointer;
          }
          .ticker-card-main {
            width: 100%;
            height: ${height}px;
            display: flex;
            align-items: center;
          }
          .alert-details {
            width: 100%;
            box-sizing: border-box;
            padding: 8px 14px 10px;
            border-top: 1px solid rgba(255,255,255,0.08);
            color: ${color};
            font-family: var(--primary-font-family, sans-serif);
            font-size: 12px;
            line-height: 1.4;
          }
          .alert-detail + .alert-detail { margin-top: 6px; }
          .alert-detail span { margin-right: 6px; }
          .ticker-card-main:focus-visible {
            outline: 2px solid rgba(255,255,255,0.8);
            outline-offset: -2px;
          }
          .ticker-wrap {
            width: 100%;
            overflow: hidden;
            height: 100%;
            display: flex;
            align-items: center;
            position: relative;
          }
          .ticker-track {
            display: flex;
            align-items: center;
            white-space: nowrap;
            position: absolute;
            will-change: transform;
          }
          .ticker-text {
            font-family: var(--primary-font-family, sans-serif);
            font-size: 12px;
            color: ${color};
            padding: 0 32px;
            line-height: 1.4;
          }
          /* Fade edges */
          .ticker-wrap::before,
          .ticker-wrap::after {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            width: 40px;
            z-index: 1;
            pointer-events: none;
          }
          .ticker-wrap::before {
            left: 0;
            background: linear-gradient(to right, ${bg}, transparent);
          }
          .ticker-wrap::after {
            right: 0;
            background: linear-gradient(to left, ${bg}, transparent);
          }
        </style>
        <ha-card>
          <div class="ticker-card-main" id="ticker-main" role="button" tabindex="0">
          <div class="ticker-wrap" id="wrap">
            <div class="ticker-track" id="track"></div>
          </div>
          </div>
          <div class="alert-details" id="alert-details" hidden></div>
        </ha-card>`;
      this._bindEvents();
    }

    // Patch the details panel content + visibility every update (cheap),
    // without touching the ticker track unless the text actually changed.
    const details = this.shadowRoot.getElementById('alert-details');
    if (details) {
      details.innerHTML = alertDetails;
      details.hidden = !this._expanded;
    }
    const main = this.shadowRoot.getElementById('ticker-main');
    if (main) main.setAttribute('aria-expanded', String(this._expanded));

    if (text !== this._text) {
      this._text = text;
      this._buildTrack();
      this._offset = 0;
      this._lastTs = null;
      this._startTicker();
    }
  }

  // Attached once, right after the shadow tree is first built.
  _bindEvents() {
    const main = this.shadowRoot.getElementById('ticker-main');
    if (!main) return;
    const toggle = () => {
      this._expanded = !this._expanded;
      expandedState.set(this._stateKey, this._expanded);
      const details = this.shadowRoot.getElementById('alert-details');
      if (details) details.hidden = !this._expanded;
      main.setAttribute('aria-expanded', String(this._expanded));
    };
    main.addEventListener('click', toggle);
    main.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  }

  // Builds however many copies of the text are needed so the track always
  // extends at least one full loop-width past the visible wrap width.
  // Without this, short text (e.g. a single short alert) runs out of
  // content mid-scroll and has to snap back — that's the "jump".
  _buildTrack() {
    const track = this.shadowRoot?.getElementById('track');
    const wrap  = this.shadowRoot?.getElementById('wrap');
    if (!track || !wrap || !this._text) return;

    track.innerHTML = `<span class="ticker-text" id="text">${this._text}</span>`;
    const textEl = track.querySelector('#text');
    const textWidth = textEl.offsetWidth;
    const wrapWidth = wrap.offsetWidth || 0;

    this._loopWidth = textWidth;
    if (textWidth <= 0) return;

    // Enough copies to cover the visible area plus one extra loop-width,
    // so there's always more track ahead than can be seen before wrapping.
    const copies = Math.max(2, Math.ceil((wrapWidth + textWidth) / textWidth) + 1);

    for (let i = 1; i < copies; i++) {
      const span = document.createElement('span');
      span.className = 'ticker-text';
      span.setAttribute('aria-hidden', 'true');
      span.innerHTML = this._text;
      track.appendChild(span);
    }
  }

  _startTicker() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    const speed = this.config.scroll_speed || 60; // px/s

    const tick = (ts) => {
      const track = this.shadowRoot?.getElementById('track');
      if (!track) return;

      if (this._lastTs !== null) {
        const delta = (ts - this._lastTs) / 1000;
        this._offset += speed * delta;

        if (this._loopWidth > 0 && this._offset >= this._loopWidth) {
          this._offset -= this._loopWidth;
        }
        track.style.transform = `translateX(${-this._offset}px)`;
      }
      this._lastTs = ts;
      this._animFrame = requestAnimationFrame(tick);
    };

    this._animFrame = requestAnimationFrame(tick);
  }

  getCardSize() { return 1; }

  static getStubConfig() {
    return {
      routes: [{ entity: 'sensor.my_gtfs2_route' }],
      scroll_speed: 60,
      height: 36,
    };
  }
}

customElements.define('gtfs-alerts-ticker', GtfsAlertsTicker);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'gtfs-alerts-ticker',
  name: 'GTFS Alerts Ticker',
  description: 'Scrolling ticker for gtfs2 service alerts',
  preview: false,
});

console.info('%c GTFS-ALERTS-TICKER %c loaded',
  'color:white;background:#d97706;font-weight:bold;padding:2px 4px;border-radius:3px 0 0 3px;',
  'color:#d97706;background:#1a1a2e;font-weight:bold;padding:2px 4px;border-radius:0 3px 3px 0;');