// Expanded alert-details panels, keyed by a signature of the card's route list
// and then by entity id. Kept outside the class so the state survives Lovelace
// recreating the element (setConfig re-runs, theme changes, view reflows) and
// render() rebuilding the shadow DOM on every tracked-entity change.
const expandedAlertsState = new Map();

class PublicTransitCard extends HTMLElement {

  setConfig(config) {
    if (!config.routes || !config.routes.length) {
      throw new Error('You must define at least one route in the routes list.');
    }
    this.config = config;
    // Compute once — avoids resetting CSS animations on every render
    this._blinkDuration     = (Math.floor(Math.random() * (30 - 15 + 1)) + 15) / 10;
    this._alsoBlinkDuration = (Math.floor(Math.random() * (30 - 15 + 1)) + 15) / 10;

    // Restore expanded-alert state for this exact set of routes. Only on
    // first setConfig for this element instance — later setConfig re-runs
    // (theme change, etc) shouldn't stomp on state the user just set.
    this._stateKey = config.routes.map(r => r.entity).sort().join('|');
    if (!this._expandedAlerts) {
      this._expandedAlerts = new Set(expandedAlertsState.get(this._stateKey) || []);
    }
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    // Only re-render when one of our tracked entities actually changed
    const changed = !prev || (this.config?.routes || []).some(r =>
      hass.states[r.entity] !== prev.states[r.entity]
    );
    if (changed) this.render();
  }

  mins(d, now) {
    return Math.max(0, Math.round((d - now) / 60000));
  }

  fmt(d, tz, useHour12) {
    const s = d.toLocaleTimeString('en-CA', {
      hour: '2-digit', minute: '2-digit', hour12: useHour12,
      timeZone: tz || undefined
    });
    if (useHour12) {
      return s.replace(/^0/, '');
    }
    return s;
  }

  fmtParts(d, tz, useHour12) {
    let s = d.toLocaleTimeString('en-CA', {
      hour: '2-digit', minute: '2-digit', hour12: useHour12,
      timeZone: tz || undefined
    });
    let ampm = '';
    let time = s;
    if (useHour12) {
      s = s.replace(/^0/, '');
      ampm = s.slice(-4).toLowerCase();
      time = s.slice(0, -4).trim();
    }
    return { time, ampm };
  }

  parseTimes(attr) {
    const raw = attr || '';
    return (Array.isArray(raw) ? raw : String(raw).split(','))
      .map(s => new Date(String(s).trim()))
      .filter(d => !isNaN(d));
  }

  // Escapes text for safe use inside HTML content (feed/config-supplied strings).
  _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Escapes text for safe use inside a double-quoted HTML attribute (title).
  _attr(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // Parses "HH:MM" (24h) into minutes-since-midnight. Returns null on
  // anything malformed so callers can safely no-op an invalid config
  // instead of throwing during render.
  _parseHHMM(str) {
    if (typeof str !== 'string') return null;
    const match = str.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  // Current local time, as minutes-since-midnight, in the given timezone.
  _minutesSinceMidnight(date, tz) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: tz || undefined
    }).formatToParts(date);
    let h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    if (h === 24) h = 0; // some environments render midnight as "24" with hour12:false
    return h * 60 + m;
  }

  // Whether `nowMinutes` falls within [start, end). Handles windows that
  // wrap past midnight (e.g. start 01:30, end 05:00 — normal overnight
  // gap; or start 23:30, end 02:00 — wraps across midnight).
  _inMinuteWindow(nowMinutes, startMinutes, endMinutes) {
    if (startMinutes === endMinutes) return false;
    if (startMinutes < endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  // Resolves an end_of_service_hours block (route-level overrides global)
  // and tells you whether `now` currently falls inside it. Realtime data
  // should be ignored for the duration of this window — see rtValid below.
  _inEndOfServiceWindow(routeConfig, globalConfig, now, tz) {
    const eos = routeConfig?.end_of_service_hours || globalConfig?.end_of_service_hours;
    if (!eos || !eos.start || !eos.end) return false;
    const start = this._parseHHMM(eos.start);
    const end   = this._parseHHMM(eos.end);
    if (start === null || end === null) return false;
    const nowMinutes = this._minutesSinceMidnight(now, tz);
    return this._inMinuteWindow(nowMinutes, start, end);
  }

  occupancyLabel(value) {
    const labels = {
      EMPTY: 'Empty',
      MANY_SEATS_AVAILABLE: 'Many seats',
      FEW_SEATS_AVAILABLE: 'Few seats',
      STANDING_ROOM_ONLY: 'Standing',
      CRUSHED_STANDING_ROOM_ONLY: 'Crowded',
      FULL: 'Full',
      NOT_ACCEPTING_PASSENGERS: 'Closed',
    };
    return labels[String(value || '').toUpperCase()] || String(value || '');
  }

  occupancyIcon(value) {
    const status = String(value || '').toUpperCase();
    if (!status) return '';

    const people = {
      EMPTY: 1,
      MANY_SEATS_AVAILABLE: 1,
      FEW_SEATS_AVAILABLE: 2,
      STANDING_ROOM_ONLY: 2,
      CRUSHED_STANDING_ROOM_ONLY: 3,
      FULL: 3,
      NOT_ACCEPTING_PASSENGERS: 3,
    }[status];
    if (!people) return '';

    const person = (x, opacity) => `
      <g transform="translate(${x} 0)" opacity="${opacity}">
        <circle cx="6" cy="4" r="3" fill="currentColor"/>
        <path d="M1.5 14c.3-3 2-4.5 4.5-4.5s4.2 1.5 4.5 4.5z" fill="currentColor"/>
      </g>`;
    const peopleSvg = [0, 1, 2]
      .map((index) => person(index * 10, index < people ? 1 : 0.18))
      .join('');
    const label = this.occupancyLabel(value);

    return `<span class="occupancy occupancy-${people}" title="${label}" aria-label="${label}">
      <svg viewBox="0 0 30 16" role="img" aria-hidden="true">${peopleSvg}</svg>
    </span>`;
  }

  render() {
    if (!this._hass || !this.config) return;

    // 1. Inject the font globally (guarded so it only runs once per page load)
    if (!document.getElementById('noto-sans-symbols-font')) {
      const link = document.createElement('link');
      link.id = 'noto-sans-symbols-font';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Symbols+2&display=swap';
      document.head.appendChild(link);
    }


    // Stable blink durations set once in setConfig
    const randomDuration     = this._blinkDuration;
    const alsoRandomDuration = this._alsoBlinkDuration;

    const hass       = this._hass;
    const config     = this.config;
    const now        = new Date();
    // Timezone: card config, else the Home Assistant timezone, else the browser's.
    const tz         = config.timezone    || hass.config?.time_zone;
    const useHour12  = config.use_12h     || false;
    const title      = config.title       || null;
    const showAlerts = config.show_alerts !== false;
    // When true (default), alert badges (!) show AND the footer alert-text list shows.
    // When false, alert badges still show (if showAlerts) but the footer list + its
    // divider are suppressed — useful for a compact "icon only" display.
    const showAlertDetails = config.show_alert_details !== false;
    const globalAlertExclusions = Array.isArray(config.exclude_alert_keywords)
      ? config.exclude_alert_keywords
      : [];
    // 4th also departure only when using 24h (times are shorter so it fits)
    const alsoCount = useHour12 ? 3 : 4;
    // Optional cap on how many upcoming departures (the small pills under the
    // main bubble) are shown. Set globally with `max_upcoming`, or per route
    // with `routes[].max_upcoming` (route value wins). 0 hides the row.
    // Falls back to the default above when unset or invalid.
    const parseLimit = v => {
      if (v === undefined || v === null || v === '') return null;
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const globalUpcomingLimit = parseLimit(config.max_upcoming);

    // Direction arrows rotated based on display orientation
    // Supports cardinal (North/East/South/West) and
    // intercardinal (Northeast/Southeast/Southwest/Northwest) display_facing
    const facingRaw = (config.display_facing || 'North').toLowerCase().replace(/[\s-]/g, '');
    const facingNorm = {
      north: 'North', n: 'North',
      east: 'East', e: 'East',
      south: 'South', s: 'South',
      west: 'West', w: 'West',
      northeast: 'Northeast', ne: 'Northeast',
      southeast: 'Southeast', se: 'Southeast',
      southwest: 'Southwest', sw: 'Southwest',
      northwest: 'Northwest', nw: 'Northwest',
    }[facingRaw] || 'North';

    // For each display_facing, map cardinal directions to the correct double-line arrow
    const arrowMap = {
      North:     { North: '🡩', East: '🡪', South: '🡫', West: '🡨' },
      Northeast: { North: '🡬', East: '🡭', South: '🡮', West: '🡯' },
      East:      { North: '🡨', East: '🡩', South: '🡪', West: '🡫' },
      Southeast: { North: '🡯', East: '🡬', South: '🡭', West: '🡮' },
      South:     { North: '🡫', East: '🡨', South: '🡩', West: '🡪' },
      Southwest: { North: '🡮', East: '🡯', South: '🡬', West: '🡭' },
      West:      { North: '🡪', East: '🡫', South: '🡨', West: '🡩' },
      Northwest: { North: '🡭', East: '🡮', South: '🡯', West: '🡬' },
    };
    const dirArrows = arrowMap[facingNorm] || arrowMap.North;

    const blockData = (config.routes || []).map(r => {
      const ent = hass.states[r.entity];
      if (!ent) return { html: `<div class="route-unavailable">Entity not found: ${this._esc(r.entity)}</div>`, alerts: [] };
      if (ent.state === 'unavailable' || ent.state === 'unknown') {
        const color = r.color || '#7a1a1a';
        const badge = r.badge || '#ed1c24';
        const icon  = r.icon  || '';
        const short = ent.attributes?.route_route_short_name || r.entity.split('.').pop();
        return {
          alerts: [],
          html: `
          <div class="route-row" style="background:${color};opacity:0.5;">
            <div class="route-info">
              <div class="route-top">
                <span class="route-badge" style="background:${badge};">${icon ? this._esc(icon) + ' ' : ''}${this._esc(short)}</span>
                <span class="route-sign" style="font-size:14px;color:white;">Unavailable</span>
              </div>
              <div class="route-org" style="color:white;opacity:0.6;">No data available</div>
            </div>
            <span class="no-data">—</span>
          </div>
          <div class="also-wrap"><div class="no-deps">Waiting for data…</div></div>`
        };
      }

      const a = ent.attributes;

      // Whether we're currently inside this route's configured end-of-service
      // window. If so, realtime data is treated as unavailable below —
      // some GTFS-RT feeds keep reporting stale/ghost realtime departures
      // (or misfire) during hours when the route has actually stopped
      // running, so this lets realtime be ignored entirely for that window
      // and falls back to scheduled times only (which naturally show
      // "No service" once they run out).
      const inEndOfService = this._inEndOfServiceWindow(r, config, now, tz);

      // Determine whether realtime data is present and valid
      const rtRaw   = a.next_departures_realtime;
      const rtValid = rtRaw && String(rtRaw).trim() !== '-' && String(rtRaw).trim() !== '' && !inEndOfService;

      // Parse both sets independently
      const rtTimes        = rtValid ? this.parseTimes(rtRaw) : [];
      const scheduledTimes = this.parseTimes(a.next_departures);

      // Build a Set of rt timestamps (ms) for per-departure rt-dot tracking
      const rtMs = new Set(rtTimes.map(d => d.getTime()));

      // RT times that are still upcoming (or just departed within 30s)
      const rtFuture = rtTimes.filter(d => d >= now - 30000).sort((a, b) => a - b);
      const staticTimesSorted = [...scheduledTimes].sort((a, b) => a - b);
      const lastStaticTime = staticTimesSorted[staticTimesSorted.length - 1] || null;
      const staticServiceEnded = (
        lastStaticTime &&
        now > lastStaticTime &&
        (a.last === true || String(a.last).toLowerCase() === 'true')
      );
      const realtimeGraceMs = 15 * 60 * 1000;
      const displayRtFuture = staticServiceEnded
        ? rtFuture.filter(d => d - lastStaticTime <= realtimeGraceMs)
        : rtFuture;

      // Dedup static times:
      // 1. If RT data exists, drop static times before the first RT departure
      //    (unconfirmed — may be cancelled or RT hasn't picked them up yet)
      // 2. Remove any within 3 min of an RT time (same vehicle, slight time diff)
      // 3. Remove any sandwiched between two consecutive RT times
      // 4. Keep everything after the last RT time to pad remaining slots
      const DEDUP_WINDOW_MS = 3 * 60 * 1000;
      const rtFirst = displayRtFuture.length ? displayRtFuture[0] : null;
      const dedupedStatic = scheduledTimes.filter(st => {
        if (rtFirst && st < rtFirst) return false;
        if (displayRtFuture.some(rt => Math.abs(st - rt) < DEDUP_WINDOW_MS)) return false;
        for (let i = 0; i < displayRtFuture.length - 1; i++) {
          if (st > displayRtFuture[i] && st < displayRtFuture[i + 1]) return false;
        }
        return true;
      });

      const merged = [...displayRtFuture, ...dedupedStatic]
        .filter(d => d >= now - 30000)
        .sort((a, b) => a - b);

      // Cap lookahead — don't show departures more than X minutes away.
      // Prevents next-day static trips showing as "1380 min" after midnight.
      const maxLookaheadMs = (config.max_lookahead_minutes ?? 180) * 60 * 1000;
      const future = merged.filter(d => d - now <= maxLookaheadMs);
      const occupancy = Array.isArray(a.next_departures_occupancy)
        ? a.next_departures_occupancy
        : [];

      // RT icon SVG — two-arc signal icon with wave-passing animation
      const rtIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 147.402 147.402" width="14" height="14" xml:space="preserve">
        <path class="rt-inner" d="M9 56.158c-4.971 0-9 4.029-9 9s4.029 9 9 9c35.425 0 64.244 28.819 64.244 64.244 0 4.971 4.029 9 9 9s9-4.029 9-9C91.244 93.053 54.35 56.158 9 56.158"/>
        <path class="rt-outer" d="M9 0a9 9 0 0 0 0 18c66.39 0 120.402 54.012 120.402 120.401 0 4.971 4.029 9 9 9s9-4.029 9-9C147.402 62.087 85.315 0 9 0"/>
      </svg>`;
      const alsoRtIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 147.402 147.402" width="6" height="6" xml:space="preserve">
        <path class="rt-inner" d="M9 56.158c-4.971 0-9 4.029-9 9s4.029 9 9 9c35.425 0 64.244 28.819 64.244 64.244 0 4.971 4.029 9 9 9s9-4.029 9-9C91.244 93.053 54.35 56.158 9 56.158"/>
        <path class="rt-outer" d="M9 0a9 9 0 0 0 0 18c66.39 0 120.402 54.012 120.402 120.401 0 4.971 4.029 9 9 9s9-4.029 9-9C147.402 62.087 85.315 0 9 0"/>
      </svg>`;

      const short     = a.route_route_short_name || '?';
      const headsign  = a.trip_trip_headsign     || '';
      const dirMatch  = headsign.match(/^(West|East|North|South)/i);
      const direction = dirMatch ? dirMatch[1] : '';

      const towardsMatch = headsign.match(/towards\s+(.+)$/i);
      const sign = towardsMatch
        ? towardsMatch[1].replace(/\s+(station|centre|center|terminal)$/i, '').trim()
        : headsign.replace(/^(West|East|North|South)\s+-\s+\d+\s+\S+\s+towards\s+/i, '');

      const orgRaw      = (a.origin_station_stop_name || '').replace(/ at /gi, ' @ ');
      const orgDirMatch = orgRaw.match(/[-–]?\s*(West|East|North|South)bound\s+Platform/i);
      const orgDir      = orgDirMatch ? orgDirMatch[1] : '';
      const org = orgRaw.replace(/\s*[-–]?\s*(West|East|North|South)bound\s+Platform/i, '').trim();
      const resolvedDir = direction || orgDir;

      // `sign` and `org` are rendered in full; CSS (text-overflow: ellipsis)
      // truncates them to the width actually available.

      const color     = r.color      || '#7a1a1a';
      const badge     = r.badge      || '#ed1c24';
      const icon      = r.icon;
      const timeColor = r.time_color || 'white';

      const next   = future[0];
      const m      = next ? this.mins(next, now) : null;
      const urgent = m !== null && m <= (config.urgent_threshold ?? 5);

      const bubbleStyle = urgent
        ? `background:${color};border:2px solid ${timeColor};filter:brightness(1.6);`
        : `background:transparent;border:2px solid ${timeColor};`;

      const nextParts = next ? this.fmtParts(next, tz, useHour12) : null;
      const nextOccupancy = next
        ? this.occupancyIcon(occupancy[0])
        : '';

      // Show rt icon only if that specific departure is realtime
      const rtDot = (next && rtMs.has(next.getTime()))
        ? `<span class="rt-icon" title="Real-time">${rtIconSvg}</span>` : '';

      // Alert badge is computed here (rather than down where displayAlerts
      // is built) so it's in scope down at render time — it's positioned
      // absolutely in the top-right corner of the route row (see
      // .badge-alert CSS), independent of the flex layout, so its presence
      // never shifts the time or occupancy icon.
      const alertRawForBadge = [a.origin_stop_alert, a.destination_stop_alert]
        .filter(v => v && v.toLowerCase() !== 'no info')
        .filter((v, i, arr) => arr.indexOf(v) === i);
      const alertExclusionsForBadge = [
        ...globalAlertExclusions,
        ...(Array.isArray(r.exclude_alert_keywords) ? r.exclude_alert_keywords : []),
      ]
        .map(keyword => String(keyword).trim().toLowerCase())
        .filter(Boolean);
      const hasAlertForBadge = showAlerts && alertRawForBadge.some(alert =>
        !alertExclusionsForBadge.some(keyword => String(alert).toLowerCase().includes(keyword))
      );
      const alertSymbol = hasAlertForBadge
        ? `<span class="badge-alert" title="Service alert">!</span>` : '';

      const nextHtml = next ? `
        <div class="next-bubble-wrap">
          <div class="bubble-outer">
            ${rtDot}
            <div class="bubble" style="${bubbleStyle}">
              <span class="bubble-num" style="color:${timeColor};">${m}</span>
            </div>
            <span class="bubble-min" style="background:${urgent ? color : color};color:${urgent ? badge : badge};${urgent ? 'filter:brightness(1.6);' : ''}">MIN</span>
          </div>
          <div class="next-time-wrap">
            <span class="next-time-line">
              <span class="next-time" style="color:${timeColor};${useHour12 ? 'font-size:15px;' : ''}">${nextParts.time}</span>
              ${useHour12 ? `<span class="next-ampm" style="color:${timeColor};">${nextParts.ampm}</span>` : ''}
            </span>
            ${nextOccupancy ? `<span class="occupancy next-occupancy">${nextOccupancy}</span>` : ''}
          </div>
        </div>` : `<span class="no-data">No service</span>`;

      // Direction pill — color + rotated arrow based on display_facing
      const dirPill = resolvedDir ? (() => {
        const dirMap = {
          North: { arrow: dirArrows.North, bg: '#50a0dc40',  border: 'rgba(80,160,220,0.5)',  text: '#7ab8e8' },
          South: { arrow: dirArrows.South, bg: '#dc8c3c40', border: 'rgba(220,140,60,0.5)',  text: '#e8a86a' },
          East:  { arrow: dirArrows.East,  bg: '#15673140', border: 'rgba(80,200,120,0.5)',  text: '#6ae8a0' },
          West:  { arrow: dirArrows.West,  bg: '#b450dc40', border: 'rgba(180,80,220,0.5)',  text: '#c87ae8' },
        };
        const d = dirMap[resolvedDir] || { arrow: '', bg: 'rgba(0,0,0,0.25)', border: 'rgba(255,255,255,0.2)', text: 'rgba(255,255,255,0.7)' };
        return `<span class="dir-pill" style="background:${d.bg};border:1px solid ${d.border};color:${d.text};"><strong>${d.arrow}</strong> ${resolvedDir.substring(0,1)}</span>`;
      })() : '';

      // Reuses the same raw/exclusion logic as alertSymbol above, kept
      // separate because this feeds the expandable per-route details panel
      // and the card-level footer list, not just the presence badge.
      const visibleAlerts = alertRawForBadge.filter(alert =>
        !alertExclusionsForBadge.some(keyword =>
          String(alert).toLowerCase().includes(keyword)
        )
      );
      const displayAlerts = showAlerts ? visibleAlerts : [];

      const alsoLimit = parseLimit(r.max_upcoming) ?? globalUpcomingLimit ?? alsoCount;
      const subItems = future.slice(1, 1 + alsoLimit);
      const subHtml  = alsoLimit === 0 ? '' : subItems.length ? `
        <div class="also-row">
          ${subItems.map(d => {
            const dm        = this.mins(d, now);
            const isRt      = rtMs.has(d.getTime());
            const alsoRtDot = isRt ? `<span class="also-rt-icon" title="Real-time">${alsoRtIconSvg}</span>` : '';
            const departureIndex = future.indexOf(d);
            const departureOccupancy = this.occupancyIcon(occupancy[departureIndex]);
            const alsoParts = this.fmtParts(d, tz, useHour12);
            return `<div class="also-pill">
              <div class="also-bubble-wrap">
                <div class="also-bubble">
                  <span class="also-num">${dm}</span>
                </div>
                ${alsoRtDot}
              </div>
              <span class="also-time-wrap">
                <span class="also-time-line">
                  <span class="also-time">${alsoParts.time}</span>
                  ${useHour12 ? `<span class="also-ampm">${alsoParts.ampm}</span>` : ''}
                </span>
                ${departureOccupancy ? `<span class="occupancy">${departureOccupancy}</span>` : ''}
              </span>
            </div>`;
          }).join('')}
        </div>`
        : `<div class="no-deps">No upcoming service</div>`;

      // Whether this route's alert-details panel is expanded, per the persisted state.
      const isExpanded = this._expandedAlerts.has(r.entity);

      // Footer shows only the short alert headers. Exclusion keywords are still
      // matched against the full alert text, so existing filters keep working.
      // If a header is missing, it falls back to the full alert so nothing
      // silently disappears.
      const footerAlerts = (showAlerts && showAlertDetails)
        ? [
            [a.origin_stop_alert,      a.origin_stop_alert_header],
            [a.destination_stop_alert, a.destination_stop_alert_header],
          ]
            .filter(([full]) => full && String(full).toLowerCase() !== 'no info')
            .filter(([full]) => !alertExclusionsForBadge.some(k =>
              String(full).toLowerCase().includes(k)))
            .map(([full, header]) =>
              header && String(header).trim() && String(header).toLowerCase() !== 'no info'
                ? header
                : full)
        : [];
      // Alerts feeding the footer list are only surfaced if the footer is
      // actually enabled; the "!" badge in the row's top-right corner uses
      // `alertSymbol` (computed above) and is independent of this.
      return {
        alerts: footerAlerts,
        html: `
        <div class="route-row ${displayAlerts.length ? 'has-alert-details' : ''}" data-entity="${r.entity}" role="${displayAlerts.length ? 'button' : ''}" tabindex="${displayAlerts.length ? '0' : '-1'}" aria-expanded="${isExpanded}" style="background:${color};">
          ${alertSymbol}
          <div class="route-info">
            <div class="route-top">
              <span class="route-badge" style="background:${badge};">${icon ? this._esc(icon) + ' ' : ''}${this._esc(short)}</span>
              <span class="route-sign" title="${this._attr(sign)}" style="color:${timeColor};">${this._esc(sign)}</span>
            </div>
            <div class="route-org" style="color:${timeColor};opacity:0.75;">${dirPill}<span class="org-text" title="${this._attr(org)}">${this._esc(org)}</span></div>
          </div>
          ${nextHtml}
        </div>
        <div class="also-wrap${subHtml ? '' : ' also-empty'}">${subHtml}</div>
        ${displayAlerts.length ? `<div class="route-alert-details" data-entity="${r.entity}" ${isExpanded ? '' : 'hidden'}>${displayAlerts.map(alert => `<div><span class="alert-icon">⚠</span>${this._esc(alert)}</div>`).join('')}</div>` : ''}`
      };
    });

    const allAlerts = [...new Set(blockData.flatMap(b => b.alerts || []))];
    const alertsFooterHtml = allAlerts.map(a => `
        <div class="footer-alert">
          <span class="alert-icon">⚠</span>
          <span class="alert-text">${this._esc(a)}</span>
        </div>`).join('');

    const html = `
      <ha-card>
        <div class="card-body">
          ${title ? '<div class="card-title">' + this._esc(title) + '</div>' : ''}
          ${blockData.map((b, i) =>
            b.html + (i < blockData.length - 1 ? '<hr class="route-divider">' : '')
          ).join('')}
          ${(showAlertDetails && alertsFooterHtml) ? '<div class="card-footer">' + alertsFooterHtml + '</div>' : ''}
        </div>
      </ha-card>`;

    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }

    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          background: #0d1b2e;
          border-radius: 14px;
          overflow: hidden;
          container-type: inline-size;
        }
        .card-body {
          padding: 8px;
          font-family: var(--primary-font-family, sans-serif);
        }
        .card-title {
          font-size: 20px;
          font-weight: 500;
          color: #a8c8e8;
          text-align: center;
          padding-bottom: 12px;
        }
        .route-row {
          position: relative;
          border-radius: 10px;
          padding: 5px 12px 4px;
          display: flex;
          align-items: center;
          gap: 10px;
          box-sizing: border-box;
        }
        .route-row.has-alert-details { cursor: pointer; }
        .route-row.has-alert-details:focus-visible {
          outline: 2px solid rgba(255,255,255,0.8);
          outline-offset: 2px;
        }
        .route-alert-details {
          margin: 4px 0 6px;
          padding: 8px 12px;
          border-radius: 8px;
          background: rgba(0,0,0,0.22);
          color: rgba(255,255,255,0.82);
          font-size: 12px;
          line-height: 1.4;
        }
        .route-alert-details > div + div { margin-top: 6px; }
        .route-alert-details .alert-icon { margin-right: 6px; }
        .route-info {
          flex: 1;
          min-width: 0;
          overflow: hidden;
        }
        .route-top {
          display: flex;
          align-items: center;
          flex-wrap: nowrap;
          gap: 4px;
        }
        .route-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 13px;
          padding: 2px 7px;
          border-radius: 4px;
          font-weight: 600;
          white-space: nowrap;
          flex-shrink: 0;
          color: white;
        }
        .badge-alert {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          background: #f87171;
          color: #1a1000;
          font-size: 10px;
          font-weight: 800;
          border-radius: 50%;
          line-height: 1;
          flex-shrink: 0;
          position: absolute;
          top: 6px;
          right: 8px;
        }
        .route-sign {
          flex: 1 1 auto;
          min-width: 0;
          font-size: 17px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .dir-pill {
          font-size: 12px;
          font-weight: bold;
          padding: 1px 7px;
          border-radius: 20px;
          white-space: nowrap;
          flex-shrink: 0;
          letter-spacing: 0.3px;
        }
        .dir-pill strong {
          font-family: 'Noto Sans Symbols 2', sans-serif !important;
          font-weight: normal;
        }
        .route-org {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 13px;
          margin-top: 3px;
          white-space: nowrap;
          overflow: hidden;
        }
        .org-text {
          flex: 1 1 auto;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .next-bubble-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
          margin-left: 8px;
        }
        .bubble-outer {
          position: relative;
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          flex-shrink: 0;
          margin-top: 6px;
          margin-right: 6px;
          padding-bottom: 8px;
        }
        .bubble {
          width: 54px;
          height: 54px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          flex-shrink: 0;
        }
        .bubble-num {
          font-size: 20px;
          font-weight: 700;
          line-height: 1;
        }
        .bubble-min {
          position: absolute;
          bottom: 1px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 8px;
          font-weight: 800;
          letter-spacing: 0.6px;
          padding: 1px 6px;
          border-radius: 4px;
          white-space: nowrap;
          line-height: 1.4;
          z-index: 1;
        }
        .rt-icon {
          position: absolute;
          top: -5px;
          right: -6px;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .also-rt-icon {
          position: absolute;
          top: -2px;
          right: -3px;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        /* Default arc colour — grey */
        .rt-icon .rt-inner, .rt-icon .rt-outer,
        .also-rt-icon .rt-inner, .also-rt-icon .rt-outer {
          fill: rgba(255,255,255,0.25);
        }
        /* Wave passes inner → both → outer → neither */
        .rt-icon .rt-inner, .also-rt-icon .rt-inner {
          animation: rt-wave-inner ${randomDuration}s ease-in-out infinite;
        }
        .rt-icon .rt-outer, .also-rt-icon .rt-outer {
          animation: rt-wave-outer ${randomDuration}s ease-in-out infinite;
        }
        @keyframes rt-wave-inner {
          0%   { fill: rgba(255,255,255,0.25); }
          20%  { fill: rgba(255,255,255,1);    }
          40%  { fill: rgba(255,255,255,1);    }
          60%  { fill: rgba(255,255,255,0.25); }
          100% { fill: rgba(255,255,255,0.25); }
        }
        @keyframes rt-wave-outer {
          0%   { fill: rgba(255,255,255,0.25); }
          20%  { fill: rgba(255,255,255,0.25); }
          40%  { fill: rgba(255,255,255,1);    }
          60%  { fill: rgba(255,255,255,1);    }
          80%  { fill: rgba(255,255,255,0.25); }
          100% { fill: rgba(255,255,255,0.25); }
        }
        .next-time-wrap {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          margin-left: 9px;
          position: relative;
          top: -3px;
        }
        .next-time-line {
          display: flex;
          align-items: baseline;
          gap: 3px;
        }
        .next-time {
          font-size: 17px;
          font-weight: 500;
          white-space: nowrap;
          line-height: 1.2;
        }
        .next-ampm {
          font-size: 11px;
          letter-spacing: 0.3px;
          line-height: 1;
          white-space: nowrap;
        }
        .next-occupancy {
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          margin-top: 4px;
        }
        .occupancy {
          display: block;
          color: rgba(255,255,255,0.62);
          font-size: 9px;
          line-height: 1.2;
          white-space: nowrap;
          text-align: right;
        }
        .occupancy svg {
          display: block;
          width: 24px;
          height: 14px;
        }
        .occupancy-1 { color: #86efac; }
        .occupancy-2 { color: #fbbf24; }
        .occupancy-3 { color: #f87171; }
        .no-data {
          color: #7a9ab8;
          font-size: 13px;
          flex-shrink: 0;
        }
        .also-wrap {
          padding: 0 4px;
          min-height: 38px;
        }
        .also-wrap.also-empty {
          min-height: 0;
          padding: 0;
        }
        .also-row {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 3px 4px 0;
          flex-wrap: wrap;
        }
        .also-pill {
          display: flex;
          align-items: center;
          gap: 5px;
          background: rgba(255,255,255,0.04);
          border-radius: 20px;
          padding: 4px 10px 4px 6px;
          flex-shrink: 0;
        }
        .also-bubble-wrap {
          position: relative;
          display: inline-flex;
          flex-shrink: 0;
        }
        .also-bubble {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: 1.5px solid #2a4a6a;
          display: flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
        }
        .also-num {
          font-size: 12px;
          font-weight: 500;
          color: #7a9ab8;
          line-height: 1;
        }
        .also-time-line {
          display: flex;
          align-items: baseline;
          gap: 2px;
        }
        .also-time {
          font-size: 13px;
          color: #7a9ab8;
          white-space: nowrap;
          line-height: 1;
        }
        .also-ampm {
          font-size: 9px;
          color: #7a9ab8;
          letter-spacing: 0.2px;
          line-height: 1;
          white-space: nowrap;
        }
        .also-time-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 33px;
        }
        .no-deps {
          padding: 8px 0;
          color: #4a6a88;
          font-size: 13px;
        }
        .card-footer {
          border-top: 1px solid #1e3a52;
          margin-top: 5px;
          padding-top: 7px;
        }
        .footer-alert {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          background: rgba(220,160,0,0.10);
          border: 1px solid rgba(220,160,0,0.25);
          border-radius: 3px;
          padding: 7px 10px;
          margin-bottom: 3px;
        }
        .footer-alert:last-child { margin-bottom: 0; }
        .alert-icon {
          font-size: 13px;
          flex-shrink: 0;
          line-height: 1.5;
        }
        .alert-text {
          font-size: 12px;
          color: #d4a843;
          line-height: 1.5;
        }
        .route-divider {
          border: none;
          margin: 2px 0 1px;
        }
        .route-unavailable {
          color: #7a9ab8;
          font-size: 12px;
          padding: 8px 0;
          font-style: italic;
        }
        .error {
          color: #e07070;
          font-size: 12px;
          padding: 8px 0;
        }

        /* ── Responsive: shrink text and the time block as the card narrows ── */
        @container (max-width: 420px) {
          .route-sign { font-size: 15px; }
          .route-org { font-size: 12px; }
          .route-badge { font-size: 12px; padding: 2px 6px; }
          .bubble { width: 46px; height: 46px; }
          .bubble-num { font-size: 17px; }
          .next-time { font-size: 15px; }
          .next-bubble-wrap { gap: 6px; margin-left: 4px; }
          .next-time-wrap { margin-left: 4px; }
        }
        @container (max-width: 340px) {
          .route-sign { font-size: 14px; }
          .route-org { font-size: 11px; }
          .bubble { width: 40px; height: 40px; }
          .next-time { font-size: 14px; }
        }
      </style>
      ${html}`;

    this.shadowRoot.querySelectorAll('.route-row.has-alert-details').forEach(row => {
      const entityId = row.dataset.entity;
      const toggle = () => {
        const details = row.nextElementSibling?.nextElementSibling;
        if (!details) return;
        const willExpand = details.hidden;
        details.hidden = !willExpand;
        row.setAttribute('aria-expanded', String(willExpand));
        // Persist the new state — both on the instance (so re-renders
        // triggered later in this session pick it up) and on the
        // module-level map (so it survives the element itself being
        // torn down and recreated, e.g. a view reflow).
        if (willExpand) {
          this._expandedAlerts.add(entityId);
        } else {
          this._expandedAlerts.delete(entityId);
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
  }

  getCardSize() {
    return (this.config?.routes?.length || 1) * 3;
  }

  static getConfigElement() {
    return document.createElement('public-transit-card-editor');
  }

  static getStubConfig() {
    return {
      title: 'Public Transit',
      urgent_threshold: 5,
      show_alerts: true,
      show_alert_details: true,
      exclude_alert_keywords: [],
      routes: [
        {
          entity: 'sensor.my_gtfs2_sensor',
          color: '#7a1a1a',
          badge: '#ed1c24',
          icon: '🚌',
          time_color: 'white'
        }
      ]
    };
  }
}

customElements.define('public-transit-card', PublicTransitCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'public-transit-card',
  name: 'Public Transit Card',
  description: 'Shows GTFS2 departure times for multiple transit routes.',
  preview: false,
})