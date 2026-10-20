/**
 * gtfs-departures-card
 * A departure board card for gtfs2 sensors — inspired by GO Transit's station displays.
 *
 * Config:
 *   type: custom:gtfs-departures-card
 *   title: "Train Departures"          # optional
 *   show_clock: true                   # optional, default true
 *   show_header: true                  # optional, default true
 *   timezone: "Europe/London"          # optional — defaults to the Home Assistant timezone
 *   use_12h: false                     # optional
 *   max_lookahead_minutes: 180         # optional
 *   omit_line_in_dest: false           # optional
 *   omit_agency_in_dest: false         # optional
 *   exclude_alert_keywords: ["elevator"] # optional — case-insensitive
 *   routes:
 *     - entity: sensor.my_gtfs2_route
 *       destination_override: "Downtown" # optional — overrides trip headsign
 *       stops_attribute: true          # optional — show intermediate stops
 *       exclude_alert_keywords: ["elevator"] # optional route override
 */

// Expanded alert-details rows, keyed by a signature of the card's route list
// and then by a per-row key (entity + departure time). Kept outside the class
// so the state survives Lovelace recreating the element and render() rebuilding
// the shadow DOM (on every tracked-entity change and on a 30s tick).
const expandedAlertsState = new Map();

// Feed- and config-supplied text is rendered via innerHTML, so escape it first.
const escDepartures = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Route colours come from the feed and end up in a style attribute, so only
// accept plain hex values.
const safeHexColor = (value, fallback) =>
  /^[0-9a-f]{3,8}$/i.test(String(value ?? '')) ? '#' + value : fallback;

class GtfsDeparturesCard extends HTMLElement {

  setConfig(config) {
    if (!config.routes || !config.routes.length) {
      throw new Error('Define at least one route in the routes list.');
    }
    this.config = config;
    this._tickInterval = null;

    // Restore expanded-alert state for this exact set of routes. Only on
    // first setConfig for this element instance — later setConfig re-runs
    // shouldn't stomp on state the user just set.
    this._stateKey = config.routes.map(r => r.entity).sort().join('|');
    if (!this._expandedAlerts) {
      this._expandedAlerts = new Set(expandedAlertsState.get(this._stateKey) || []);
    }
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    const changed = !prev || (this.config?.routes || []).some(r =>
      hass.states[r.entity] !== prev.states[r.entity]
    );
    if (changed) this.render();
  }

  connectedCallback() {
    // Tick every 30s to keep relative times fresh
    this._tickInterval = setInterval(() => this.render(), 30000);
  }

  disconnectedCallback() {
    clearInterval(this._tickInterval);
  }

  parseTimes(attr) {
    const raw = attr || '';
    return (Array.isArray(raw) ? raw : String(raw).split(','))
      .map(s => new Date(String(s).trim()))
      .filter(d => !isNaN(d));
  }

  fmt(d, tz, use12h) {
    return d.toLocaleTimeString('en-CA', {
      hour: '2-digit', minute: '2-digit',
      hour12: use12h,
      timeZone: tz || undefined
    }).replace(/^0/, '');
  }

  fmtClock(d, tz) {
    return d.toLocaleTimeString('en-CA', {
      hour: '2-digit', minute: '2-digit',
      hour12: false,
      timeZone: tz || undefined
    });
  }

  minsUntil(d, now) {
    return Math.max(0, Math.round((d - now) / 60000));
  }

  render() {
    if (!this._hass || !this.config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });

    const config     = this.config;
    const hass       = this._hass;
    const now        = new Date();
    // Timezone: card config, else the Home Assistant timezone, else the browser's.
    const tz         = config.timezone || hass.config?.time_zone;
    const use12h     = config.use_12h || false;
    const showHeader = config.show_header !== false;
    const showClock  = config.show_clock !== false;
    const title      = config.title || 'Departures';
    const icon       = config.icon  || '🚆';
    const maxRows    = config.max_rows ?? null;
    const maxMs      = (config.max_lookahead_minutes ?? 180) * 60000;
    const globalAlertExclusions = Array.isArray(config.exclude_alert_keywords)
      ? config.exclude_alert_keywords
      : [];

    // Collect all upcoming departures across all route entities
    const rows = [];

    for (const r of config.routes) {
      const ent = hass.states[r.entity];
      if (!ent || ent.state === 'unavailable' || ent.state === 'unknown') continue;

      const a = ent.attributes;
      const alertRaw = [a.origin_stop_alert, a.destination_stop_alert]
        .filter(v => v && String(v).toLowerCase() !== 'no info')
        .filter((v, i, arr) => arr.indexOf(v) === i);
      const alertExclusions = [
        ...globalAlertExclusions,
        ...(Array.isArray(r.exclude_alert_keywords) ? r.exclude_alert_keywords : []),
      ]
        .map(keyword => String(keyword).trim().toLowerCase())
        .filter(Boolean);
      const visibleAlerts = alertRaw.filter(alert =>
        !alertExclusions.some(keyword =>
          String(alert).toLowerCase().includes(keyword)
        )
      );
      const tripAlert = visibleAlerts.length > 0;

      // Parse departures
      const rtRaw   = a.next_departures_realtime;
      const rtValid = rtRaw && String(rtRaw).trim() !== '-' && String(rtRaw).trim() !== '';
      const rtTimes = rtValid ? this.parseTimes(rtRaw) : [];
      const stTimes = this.parseTimes(a.next_departures);
      const rtMs    = new Set(rtTimes.map(d => d.getTime()));

      // Merge with same dedup logic as transit card
      const DEDUP = 3 * 60000;
      const rtFirst = rtTimes.filter(d => d >= now - 30000).sort((a,b) => a-b)[0] || null;
      const dedupedStatic = stTimes.filter(st => {
        if (rtFirst && st < rtFirst) return false;
        if (rtTimes.some(rt => Math.abs(st - rt) < DEDUP)) return false;
        return true;
      });
      const merged = [...rtTimes, ...dedupedStatic]
        .filter(d => d >= now - 30000 && d - now <= maxMs)
        .sort((a,b) => a-b);

      if (!merged.length) continue;

      const headsign = a.trip_trip_headsign || '';
      const headsignEntries = Array.isArray(a.next_departures_headsign)
        ? a.next_departures_headsign
        : [];
      const headsignsByTime = new Map();
      const destinationEntries = Array.isArray(a.next_departures_destinations)
        ? a.next_departures_destinations
        : [];
      const destinationsByTime = new Map();

      for (const entry of headsignEntries) {
        const match = String(entry).match(/^(.+?)\s+\(([^()]*)\)$/);
        if (!match) continue;

        const departureTime = new Date(match[1].trim()).getTime();
        if (!isNaN(departureTime)) {
          headsignsByTime.set(departureTime, match[2].trim());
        }
      }

      for (const entry of destinationEntries) {
        const match = String(entry).match(/^(.+?)\s+\(([^()]*)\)$/);
        if (!match) continue;

        const departureTime = new Date(match[1].trim()).getTime();
        if (!isNaN(departureTime)) {
          destinationsByTime.set(departureTime, match[2].trim());
        }
      }

      // Destination — prefer the destination associated with each departure.
      const fallbackDestination = headsign
        .replace(/^(West|East|North|South)\s+-\s+\d+\s+\S+\s+towards\s+/i, '')
        .replace(/^.*?\s+towards\s+/i, '');

      // Line name / route colour
      const routeShort = a.route_route_short_name || '';
      const routeLong  = a.route_route_long_name  || '';
      const routeColor = safeHexColor(a.route_route_color, '#555555');
      const routeText  = safeHexColor(a.route_route_text_color, '#ffffff');

      // Intermediate stops from next_departures_stops sensor attribute
      const rawStopsList = Array.isArray(a.next_departures_stops) ? a.next_departures_stops : [];

      for (const [i, dep] of merged.slice(0, r.max_rows || 3).entries()) {
        const isRt  = rtMs.has(dep.getTime());
        const isLast = (
          (a.last === true || String(a.last).toLowerCase() === 'true')
          && i === 0
        );
        const mins  = this.minsUntil(dep, now);
        let rawDest = r.destination_override
          || headsignsByTime.get(dep.getTime())
          || destinationsByTime.get(dep.getTime())
          || fallbackDestination;

        // Optionally strip the line and agency portions of the destination.
        const omitLine = config.omit_line_in_dest ?? false;
        if (omitLine) {
          rawDest = rawDest.replace(/^[A-Z]{1,3}\s*[-–]\s*/i, '').trim();
        }
        const omitAgency = config.omit_agency_in_dest ?? false;
        if (omitAgency) {
          rawDest = rawDest
            .replace(/\s+(GO|TTC)\s*$/i, '')
            .replace(/^(UP\s+Express)\s+/i, '')
            .trim();
        }

        // Get stops for this specific departure index
        let stopsArr = [];
        const rawStops = rawStopsList[i] || a.intermediate_stops || r.stops_text || '';
        if (typeof rawStops === 'string' && rawStops) {
          stopsArr = rawStops.split(' · ').filter(Boolean);
        }
        // Apply stops_filter
        if (r.stops_filter) {
          stopsArr = stopsArr.filter(s => s.toLowerCase().includes(r.stops_filter.toLowerCase()));
        }
        // Apply max_stops
        if (r.max_stops != null) {
          stopsArr = stopsArr.slice(0, r.max_stops);
        }
        const stops = stopsArr.join(' · ');

        // Stable-ish key for this specific departure, used to remember
        // whether its alert panel is expanded. Departure timestamps don't
        // change once a trip is scheduled, only fall off the list once
        // departed, so entity+time is a good enough identity across
        // rerenders of the same upcoming trip.
        const rowKey = `${r.entity}|${dep.getTime()}`;

        rows.push({
          dep, isRt, isLast, mins, rawDest, routeShort, routeLong,
          routeColor, routeText, stops, tripAlert,
          alertText: visibleAlerts.join(' · '), r, rowKey
        });
      }
    }

    // Sort all rows by departure time and apply global max_rows cap
    rows.sort((a, b) => a.dep - b.dep);
    const displayRows = maxRows !== null ? rows.slice(0, maxRows) : rows;

    const rowsHtml = displayRows.length ? displayRows.map(row => {
      const urgentClass = row.mins <= 5 ? 'urgent' : row.mins <= 15 ? 'soon' : '';
      const badges = [
        row.isLast ? '<span class="last-badge">Last</span>' : '',
        row.isRt ? '<span class="rt-badge">Live</span>' : '',
        row.tripAlert
          ? '<span class="alert-badge" title="Service alert">!</span>'
          : '',
      ].join('');
      // Ticker: duplicate the stop-list content so the marquee can loop seamlessly.
      // Whether it actually animates is decided after render, once we know if it overflows.
      // Render a single copy — the looping duplicate is only added in JS,
      // and only once we know the content actually overflows its box.
      const stopsHtml = row.stops
        ? `<span class="stops-list">
             <span class="stops-ticker">
               <span class="stops-segment">${escDepartures(row.stops)}</span>
             </span>
           </span>`
        : '';
      // Whether this row's alert-details is expanded, per the persisted state.
      const isExpanded = row.tripAlert && this._expandedAlerts.has(row.rowKey);
      return `
        <tr class="dep-row ${urgentClass} ${row.tripAlert ? 'has-alert-details' : ''}" data-row-key="${row.rowKey}" ${row.tripAlert ? `tabindex="0" role="button" aria-expanded="${isExpanded}"` : ''}>
          <td class="col-time">
            <span class="sched-time">${this.fmt(row.dep, tz, use12h)}</span>
          </td>
          <td class="col-line">
            <span class="line-badge" style="background:${row.routeColor};color:${row.routeText};">${escDepartures(row.routeShort || row.routeLong)}</span>
          </td>
          <td class="col-dest">
            <span class="dest-name">${escDepartures(row.rawDest)}</span>
            ${stopsHtml}
          </td>
          <td class="col-mins">
            <span class="mins-line">
              <span class="mins-val ${urgentClass}">${row.mins}</span>
              <span class="mins-label">min</span>
            </span>
            <span class="status-badges">${badges}</span>
          </td>
        </tr>
        ${row.tripAlert ? `<tr class="alert-details-row" data-row-key="${row.rowKey}" ${isExpanded ? '' : 'hidden'}><td colspan="4"><div class="alert-details"><span class="alert-icon">⚠</span>${escDepartures(row.alertText)}</div></td></tr>` : ''}`;
    }).join('') : `
        <tr><td colspan="4" class="no-deps">No upcoming departures</td></tr>`;

    this.shadowRoot.innerHTML = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

        :host { display: block; }

        ha-card {
          background: #0a0d12;
          border-radius: 10px;
          overflow: hidden;
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
          color: #e2e8f0;
          border: 1px solid rgba(255,255,255,0.07);
          container-type: inline-size;
        }

        /* ── Header ── */
        .board-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 18px 10px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.02);
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .header-icon {
          font-size: 18px;
          opacity: 0.7;
        }
        .header-title {
          font-size: 16px;
          font-weight: 600;
          color: #f1f5f9;
          letter-spacing: -0.2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .header-clock {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 18px;
          font-weight: 500;
          color: #f1f5f9;
          letter-spacing: 1px;
        }

        /* ── Table ── */
        .dep-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        .dep-table th, .dep-table td { box-sizing: border-box; }

        /* Fixed columns; "To" takes the remaining space */
        .col-headers th:nth-child(1) { width: 84px; }
        .col-headers th:nth-child(2) { width: 64px; }
        .col-headers th:nth-child(4) { width: 90px; }

        .col-headers th {
          padding: 6px 8px 6px;
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.06em;
          color: rgba(255,255,255,0.3);
          text-align: left;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .col-headers th.col-mins { text-align: right; }
        .col-headers th:first-child { padding-left: 18px; }
        .col-headers th:last-child  { padding-right: 18px; }

        .dep-row td {
          padding: 9px 8px 8px;
          border-bottom: 1px solid rgba(255,255,255,0.04);
          vertical-align: middle;
        }
        .dep-row:last-child td { border-bottom: none; }
        .dep-row td:first-child { padding-left: 18px; }
        .dep-row td:last-child  { padding-right: 18px; }

        .dep-row:hover {
          background: rgba(255,255,255,0.025);
        }
        .dep-row.has-alert-details { cursor: pointer; }
        .dep-row.has-alert-details:focus-visible {
          outline: 2px solid rgba(255,255,255,0.8);
          outline-offset: -2px;
        }
        .alert-details-row td {
          padding: 0 18px 9px;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .alert-details {
          padding: 8px 10px;
          border-radius: 6px;
          background: rgba(251,191,36,0.1);
          color: rgba(255,255,255,0.82);
          font-size: 12px;
          line-height: 1.4;
        }
        .alert-details .alert-icon { margin-right: 6px; }

        /* Highlight upcoming */
        .dep-row.soon  { background: rgba(255,200,50,0.03); }
        .dep-row.urgent { background: rgba(255,80,50,0.06); }

        /* Time */
        .sched-time {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 15px;
          font-weight: 500;
          color: #cbd5e1;
        }

        /* Line badge */
        .line-badge {
          display: inline-block;
          font-size: 13px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
        }

        /* Destination */
        .col-dest {
          min-width: 0;
          overflow: hidden;
        }
        .dest-name {
          display: block;
          font-size: 15px;
          font-weight: 500;
          color: #f1f5f9;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Stops ticker — behaves like an alerts marquee */
        .stops-list {
          display: block;
          font-size: 11px;
          color: rgba(255,255,255,0.35);
          margin-top: 2px;
          width: 100%;
          overflow: hidden;
          position: relative;
          height: 1.4em;
        }
        /* Edge fade only makes sense once text is actually scrolling —
           applying it to static text just clips the first/last letter. */
        .stops-list.has-fade {
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
                  mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
        }
        .stops-ticker {
          display: flex;
          position: absolute;
          left: 0;
          top: 0;
          white-space: nowrap;
          will-change: transform;
        }
        .stops-ticker.scrolling {
          animation-name: stops-scroll;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .stops-segment {
          padding-right: 28px;
        }
        @keyframes stops-scroll {
          from { transform: translateX(0); }
          to   { transform: translateX(var(--scroll-dist, 0px)); }
        }
        @media (prefers-reduced-motion: reduce) {
          .stops-ticker.scrolling { animation: none; }
        }

        /* Minutes. The .status-badges slot is always present in the
           markup below (even when there are no badges for a row) and is
           given a fixed height here, matching the tallest badge. Every
           row reserves the same vertical space for badges whether it
           uses it or not, so the row height and the time's position never
           change based on whether a badge is showing. */
        .col-mins {
          text-align: right;
          white-space: nowrap;
        }
        .mins-val {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 20px;
          font-weight: 500;
          color: rgba(255,255,255,0.55);
        }
        .mins-val.soon   { color: #fbbf24; }
        .mins-val.urgent { color: #f87171; }
        .mins-label {
          font-size: 10px;
          color: rgba(255,255,255,0.3);
          margin-left: 2px;
        }
        .mins-line {
          display: block;
          white-space: nowrap;
          padding: 5px 0 0 0;
        }
        /* Every badge is display:inline-flex with an explicit height and
           box-sizing:border-box, so its rendered box is exactly 14px tall
           no matter what the browser's default line-height/font metrics
           would otherwise produce. */
        .rt-badge {
          display: inline-flex;
          align-items: center;
          height: 14px;
          box-sizing: border-box;
          font-size: 8px;
          font-weight: 600;
          padding: 0 3px;
          border-radius: 3px;
          background: rgba(74,222,128,0.15);
          color: #4ade80;
          border: 1px solid rgba(74,222,128,0.25);
        }
        .last-badge {
          display: inline-flex;
          align-items: center;
          height: 14px;
          box-sizing: border-box;
          font-size: 8px;
          font-weight: 600;
          padding: 0 3px;
          border-radius: 3px;
          background: rgba(248,113,113,0.15);
          color: #f87171;
          border: 1px solid rgba(248,113,113,0.3);
        }
        .alert-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 14px;
          width: 14px;
          box-sizing: border-box;
          font-size: 9px;
          font-weight: 700;
          border-radius: 50%;
          background: rgba(251,191,36,0.18);
          color: #fbbf24;
          border: 1px solid rgba(251,191,36,0.4);
          cursor: help;
        }
        /* The slot itself gets a hard, fixed height plus overflow:hidden,
           so the row height can't depend on what's inside here. */
        .status-badges {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: 4px;
          margin-top: 4px;
          height: 14px;
          overflow: hidden;
        }

        .no-deps {
          text-align: center;
          padding: 24px;
          color: rgba(255,255,255,0.25);
          font-size: 13px;
        }

        /* ── Responsive: shrink text and columns as the card narrows ── */
        @container (max-width: 520px) {
          .sched-time, .dest-name { font-size: 13px; }
          .mins-val { font-size: 17px; }
          .line-badge { font-size: 11px; }
          .header-title { font-size: 14px; }
          .header-clock { font-size: 16px; }
          .col-headers th:nth-child(1) { width: 70px; }
          .col-headers th:nth-child(2) { width: 54px; }
          .col-headers th:nth-child(4) { width: 76px; }
          .dep-row td:first-child, .col-headers th:first-child { padding-left: 12px; }
          .dep-row td:last-child,  .col-headers th:last-child  { padding-right: 12px; }
          .board-header { padding-left: 12px; padding-right: 12px; }
        }
        @container (max-width: 400px) {
          .sched-time, .dest-name { font-size: 12px; }
          .mins-val { font-size: 15px; }
          .stops-list { font-size: 10px; }
          .col-headers th:nth-child(1) { width: 60px; }
          .col-headers th:nth-child(4) { width: 66px; }
        }
      </style>

      <ha-card>
        ${showHeader ? `
        <div class="board-header">
          <div class="header-left">
            <span class="header-icon">${escDepartures(icon)}</span>
            <span class="header-title">${escDepartures(title)}</span>
          </div>
          ${showClock ? `<span class="header-clock">${this.fmtClock(now, tz)}</span>` : ''}
        </div>` : ''}

        <table class="dep-table">
          <thead>
            <tr class="col-headers">
              <th>Scheduled</th>
              <th>Line</th>
              <th>To</th>
              <th class="col-mins">In</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </ha-card>`;

    this.shadowRoot.querySelectorAll('.dep-row.has-alert-details').forEach(row => {
      const rowKey = row.dataset.rowKey;
      const toggle = () => {
        const details = row.nextElementSibling;
        if (!details) return;
        const willExpand = details.hidden;
        details.hidden = !willExpand;
        row.setAttribute('aria-expanded', String(willExpand));
        // Persist so the next rerender (30s tick, or a hass state change)
        // renders `hidden` correctly instead of resetting to closed.
        if (willExpand) {
          this._expandedAlerts.add(rowKey);
        } else {
          this._expandedAlerts.delete(rowKey);
        }
        expandedAlertsState.set(this._stateKey, new Set(this._expandedAlerts));
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
    });

    this._setupTickers(config);
  }

  /**
   * Decide, per row, whether the stops list actually overflows its box.
   *
   * - If it fits, leave the single rendered copy alone — no scrolling,
   *   no duplicate text.
   * - If it overflows, clone the segment once (so the marquee has a
   *   second copy to loop into) and animate.
   *
   * render() rebuilds the whole table every 30s, which would normally
   * reset every ticker back to frame 0 — a visible jump. To avoid that,
   * we stamp a single "epoch" timestamp the first time the card renders
   * and, on every subsequent render, work out how far into the loop we
   * *should* be by now (elapsed time mod duration) and start the fresh
   * animation there via a negative animation-delay. Same content plus
   * same speed means the motion reads as continuous even though the
   * DOM node is new each time.
   */
  _setupTickers(config) {
    const pxPerSecond = config.ticker_speed ?? 30; // higher = faster scroll
    if (this._tickerEpoch == null) this._tickerEpoch = performance.now();
    const epoch = this._tickerEpoch;

    requestAnimationFrame(() => {
      const tickers = this.shadowRoot.querySelectorAll('.stops-ticker');
      tickers.forEach(ticker => {
        const container = ticker.parentElement;
        const segment = ticker.querySelector('.stops-segment');
        if (!container || !segment) return;

        // Measure the single rendered copy before any clone is added.
        const segWidth = segment.getBoundingClientRect().width;
        const containerWidth = container.getBoundingClientRect().width;

        if (segWidth > containerWidth) {
          if (ticker.children.length < 2) {
            ticker.appendChild(segment.cloneNode(true));
          }
          // segWidth already includes the segment's trailing padding,
          // so translating by exactly that distance lines the clone up
          // seamlessly where the original left off.
          const duration = segWidth / pxPerSecond;
          const elapsed = (performance.now() - epoch) / 1000;
          const offset = elapsed % duration;

          ticker.style.setProperty('--scroll-dist', `-${segWidth}px`);
          ticker.style.animationDuration = `${duration}s`;
          ticker.style.animationDelay = `-${offset}s`;
          ticker.classList.add('scrolling');
          container.classList.add('has-fade');
        } else {
          ticker.classList.remove('scrolling');
          ticker.style.transform = 'translateX(0)';
          container.classList.remove('has-fade');
          while (ticker.children.length > 1) {
            ticker.removeChild(ticker.lastChild);
          }
        }
      });
    });
  }

  getCardSize() {
    const count = (this.config?.routes || []).reduce((s, r) => s + (r.max_rows || 3), 0);
    return Math.ceil(count / 2) + 2;
  }

  static getStubConfig() {
    return {
      title: 'Train Departures',
      show_header: true,
      show_clock: true,
      omit_agency_in_dest: false,
      exclude_alert_keywords: [],
      routes: [
        { entity: 'sensor.my_gtfs2_route', max_rows: 3 }
      ]
    };
  }
}

customElements.define('gtfs-departures-card', GtfsDeparturesCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'gtfs-departures-card',
  name: 'GTFS Departures Board',
  description: 'Departure board style card for gtfs2 sensors',
  preview: false,
});

console.info('%c GTFS-DEPARTURES-CARD %c loaded',
  'color:white;background:#1a56db;font-weight:bold;padding:2px 4px;border-radius:3px 0 0 3px;',
  'color:#1a56db;background:#1a1a2e;font-weight:bold;padding:2px 4px;border-radius:0 3px 3px 0;');