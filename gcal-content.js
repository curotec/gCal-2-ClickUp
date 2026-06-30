// gcal-content.js
// Injects a "→ ClickUp" button into the Google Calendar event detail popover,
// letting you push a single event's time into ClickUp without opening the
// extension popup. The button is state-aware: it reflects whether time is
// already logged in ClickUp for that timeframe.
//
// NOTE ON FRAGILITY: Google Calendar's DOM is obfuscated (randomized class
// names, no stable IDs) and changes without notice. ALL DOM-coupling lives in
// the SELECTORS block and the scrape* helpers below — if Google ships a UI
// change that breaks this feature, re-tune those in one place.

(() => {
  'use strict';

  // ── DOM coupling (the only Google-specific, fragile part) ──────────────────
  const SELECTORS = {
    // The Edit-event button. Google localizes the aria-label, so we match a
    // few known variants plus a data-tooltip fallback.
    editButton: [
      'button[aria-label="Edit event"]',
      'button[aria-label="Edit"]',
      'button[data-tooltip="Edit event"]',
      'button[jsaction*="edit"][aria-label*="dit"]'
    ],
    // The popover container that holds the event detail. We climb from the
    // edit button to the nearest dialog/region rather than hard-coding a class.
    popoverRoot: ['div[role="dialog"]', 'div[role="region"]']
  };

  const MARKER = 'data-clickup-injected'; // idempotency guard on the popover
  const BTN_ID = 'clickup-push-btn';
  const TICKET_REGEX = /\b([A-Z]+-\d+)\b/;
  const COMPLETE_TICKET_REGEX = /^[A-Z]+-\d+$/;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Strip ticket IDs (e.g. "CTK-1234") and surrounding separators from a title
  // so the ClickUp time-entry description stays clean — mirrors popup.js
  // cleanTitle() so both import surfaces behave identically.
  function cleanTitle(raw) {
    return (raw || '')
      .replace(/\b[A-Z]+-\d+\b/g, '')
      .replace(/^[\s|\-\u2013]+|[\s|\-\u2013]+$/g, '')
      .trim() || raw;
  }

  // Short local time label (e.g. "11:30 AM") for confirm dialogs.
  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  // icon16 inlined as a data URL so the content script needs no web_accessible_resources
  const ICON16_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAC7UlEQVR4nDWTX4hUdRTHP+f3u/fOHXd2uuM6u7YJCi1RtFIEUSGKYRQRsYb1EG0iaj1EkOBjPbRQtA8L6UsQxKIYFUVkhU8+mCVRVBQWSKu2KW7Kjrs77p+Ze+fe3+/0MOOBc57O9wvf7/cciUol3frcJBse3EvqDKqCqKCiAKCAgKqAL5j65QCb8/+YbrR4+8+/Ce4fe5f6Y4doLjVJ1ilxAKqKotzmwIB2ByaOkcVl3rizDowgT04u6HLbMvaQsn9HhBEB78EaiEJQA3kGzoEY4nyVtekP6Hz5FVpNCNLcUi17DuwoUa9astRh4gh1Hj46gdgWuu8VMCGSt9FkEDn4Gosz3xC5BoEHSqEgQJZ5XBzimm38+19jfzxHVLmMdxfIX5qA8gDSSjElJRm/QVDMY4SeZgUTGvy/KxRvnkHOXMXvegK/exvh7KeUTr6Aaf6FhCGoxxYezR2BegUFsaBrjvydWcwli3/xcYJXH6aQPehZTzQzCT89TWfX7yAhiCICAdJNSh1I1WL3bIKlOuH4MKQ5qOB2vkc6GEF5PYQ1SOd72ULQgyMCWijlZxJChLXVDtIViE9bVEYn8A6yogAx3C6j2gMrWAtzl3POnU3pqwhxJMShUImFb/+5xcXmMoHp7iLdDvCC94INhWbDMXW4w5waZps52x+xeIFTV5SpmYCB/oKTOwuGrZKpIAqBc4vgLS4fJNkgPDtuOP6x48PjyvR3ntUazJUstSE4dI9lYzUmzSIKwCAEbugtbpkAzBFCM8BTz1tGRh2nv3dcWBDa/bB7RBh7wDI6ZFj55AQLp0+xciPmjuReglKY0Vid58gPx3h928tYsdS3wN67od3uPkNfCA7LlUabzhef0fr1Z/o3bcYUfch944/quu13MX/9JrVyP8Mb1+Nc77Bs12nvFBMYtJ1z+NgfjNqYZKDC0Ws3CS59/htbCkeydZBWnrGUNhExXaeLLoGook7weUGlVsH6iKNzi0ycv8j/P4dO3R/qHMsAAAAASUVORK5CYII=";

  function dbg(...args) {
    chrome.storage.local.get(['debugMode'], (r) => {
      if (r.debugMode) console.log('[GCal→ClickUp]', ...args);
    });
  }

  // ── Storage / background helpers (mirror popup.js, kept self-contained) ─────
  function getSettings() {
    return new Promise(resolve =>
      chrome.storage.local.get(['clickupToken', 'teamId'], resolve));
  }

  function sendBg(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
          resolve(resp || {});
        });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  // ── Frequent tickets (same 30-day rolling window as the popup) ─────────────
  async function getFrequentTickets() {
    return new Promise(resolve => {
      chrome.storage.local.get(['ticketFrequency', 'ticketNames', 'ticketFavorites', 'clickupToken', 'teamId'], async (r) => {
        const freq = r.ticketFrequency || {};
        const cutoff = Date.now() - THIRTY_DAYS_MS;
        const cleaned = {};
        for (const [id, ts] of Object.entries(freq)) {
          const recent = (ts || []).filter(t => t > cutoff);
          if (recent.length) cleaned[id] = recent;
        }
        const names = { ...(r.ticketNames || {}) };
        const favIds = r.ticketFavorites || [];
        const sorted = Object.entries(cleaned)
          .sort((a, b) => b[1].length - a[1].length)
          .map(([id]) => id);

        // Resolve names missing from storage (e.g. frequents built before names
        // were cached), via the background — content scripts can't call the API.
        const wanted = [...favIds.slice(0, 3), ...sorted].filter((id, i, a) => a.indexOf(id) === i);
        const missing = wanted.filter(id => !names[id]);
        if (missing.length && r.clickupToken && r.teamId) {
          const resp = await sendBg({
            type: 'GET_TASK_NAMES',
            clickupToken: r.clickupToken,
            teamId: r.teamId,
            ids: missing
          });
          if (resp && resp.names) {
            Object.assign(names, resp.names);
            chrome.storage.local.set({ ticketNames: names });
          }
        }

        const favTickets  = favIds.slice(0, 3)
          .map(id => ({ id, name: names[id] || '', favorite: true }));
        const freqTickets = sorted.filter(id => !favIds.includes(id))
          .map(id => ({ id, name: names[id] || '', favorite: false }));
        resolve([...favTickets, ...freqTickets].slice(0, 11));
      });
    });
  }

  function recordTicketUse(ticketId, taskName) {
    if (!ticketId) return;
    chrome.storage.local.get(['ticketFrequency', 'ticketNames'], (r) => {
      const freq = r.ticketFrequency || {};
      const names = r.ticketNames || {};
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const existing = (freq[ticketId] || []).filter(t => t > cutoff);
      freq[ticketId] = [...existing, Date.now()];
      if (taskName) names[ticketId] = taskName;
      chrome.storage.local.set({ ticketFrequency: freq, ticketNames: names });
    });
  }

  // ── Tags (mirror popup.js: cached via background, per-ticket memory) ───────
  let _cachedTags = null;

  async function fetchTags() {
    if (_cachedTags) return _cachedTags;
    const settings = await getSettings();
    if (!settings.clickupToken || !settings.teamId) return [];
    const r = await sendBg({
      type: 'GET_TAGS',
      clickupToken: settings.clickupToken,
      teamId: settings.teamId
    });
    _cachedTags = (r && r.tags) || [];
    return _cachedTags;
  }

  function getTagPreference(ticketId) {
    return new Promise(resolve => {
      chrome.storage.local.get(['ticketTag'], (r) => {
        const map = r.ticketTag || {};
        resolve(map[ticketId] || '');
      });
    });
  }

  function saveTagPreference(ticketId, tag) {
    if (!ticketId) return;
    chrome.storage.local.get(['ticketTag'], (r) => {
      const map = r.ticketTag || {};
      if (tag) map[ticketId] = tag; else delete map[ticketId];
      chrome.storage.local.set({ ticketTag: map });
    });
  }

  function buildTagSelect(selectedTag, tags) {
    const sel = document.createElement('select');
    sel.className = 'clickup-tag-select';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No tag';
    sel.appendChild(empty);
    tags.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (t === selectedTag) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  // ── Live ClickUp search (reuses the popup's background handlers) ───────────
  let _clickupUserId = null;
  const _searchCache = {};

  async function getClickupUserId(token) {
    if (_clickupUserId) return _clickupUserId;
    const r = await sendBg({ type: 'GET_CLICKUP_USER', clickupToken: token });
    if (r && r.userId) { _clickupUserId = r.userId; return r.userId; }
    return null;
  }

  async function searchClickupTasks(query) {
    const q = (query || '').trim().toLowerCase();
    if (_searchCache[q]) return _searchCache[q];
    const settings = await getSettings();
    if (!settings.clickupToken || !settings.teamId) return [];
    const userId = await getClickupUserId(settings.clickupToken);
    if (!userId) return [];
    const r = await sendBg({
      type: 'SEARCH_CLICKUP_TASKS',
      clickupToken: settings.clickupToken,
      teamId: settings.teamId,
      userId, query: q
    });
    const tasks = (r && r.tasks) || [];
    _searchCache[q] = tasks;
    return tasks;
  }

  // ── Event scraping (fragile — isolated here) ───────────────────────────────
  function scrapeTitle(popover) {
    // The event title is the most prominent heading in the popover.
    const heading = popover.querySelector('[role="heading"], h2, h1');
    return heading ? heading.textContent.trim() : '';
  }

  // Google renders the date/time as accessible text on a row. We look for an
  // element whose text matches a time range and parse it against the page's
  // selected date. Returns { startISO, endISO } or null.
  function scrapeTimes(popover) {
    const text = popover.innerText || '';
    // Match e.g. "Monday, June 29  ⋅  11:30am – 12:00pm" or "11:30 – 12:00"
    const dateMatch = text.match(
      /([A-Z][a-z]+day),?\s+([A-Z][a-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?/);
    const timeMatch = text.match(
      /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[\u2013\u2014-]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    if (!timeMatch) return null;

    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth();
    let day = now.getDate();

    if (dateMatch) {
      const monthNames = ['january','february','march','april','may','june',
        'july','august','september','october','november','december'];
      const mIdx = monthNames.indexOf(dateMatch[2].toLowerCase());
      if (mIdx >= 0) month = mIdx;
      day = parseInt(dateMatch[3], 10);
      if (dateMatch[4]) year = parseInt(dateMatch[4], 10);
    }

    const parseTime = (raw, fallbackPm) => {
      const m = raw.trim().toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
      if (!m) return null;
      let h = parseInt(m[1], 10);
      const min = m[2] ? parseInt(m[2], 10) : 0;
      const ap = m[3] || fallbackPm;
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      return { h, min };
    };
    // If the start has no am/pm marker, inherit the end's (common in GCal).
    const endAp = (timeMatch[2].toLowerCase().match(/(am|pm)/) || [])[0];
    const s = parseTime(timeMatch[1], endAp);
    const e = parseTime(timeMatch[2]);
    if (!s || !e) return null;

    const start = new Date(year, month, day, s.h, s.min);
    const end   = new Date(year, month, day, e.h, e.min);
    if (end <= start) return null;
    return { startISO: start.toISOString(), endISO: end.toISOString(), dateStr: localDateStr(start) };
  }

  function localDateStr(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function findEditButton(popover) {
    for (const sel of SELECTORS.editButton) {
      const btn = popover.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  // ── State detection: is time already logged for this event's window? ───────
  // Returns { state, title } and, when state === 'logged', also { matchEntry }
  // carrying the matched entry's id + window so a click can UPDATE it in place
  // (PUT) rather than create a duplicate. Match is loose overlap on the same
  // ticket; the FIRST overlapping same-ticket entry wins (consistent with how
  // the logged state is chosen).
  async function detectState(evt) {
    const settings = await getSettings();
    if (!settings.clickupToken || !settings.teamId || !evt.times) {
      return { state: 'clean', title: '' };
    }
    const r = await sendBg({
      type: 'GET_CLICKUP_ENTRIES',
      clickupToken: settings.clickupToken,
      teamId: settings.teamId,
      date: evt.times.dateStr
    });
    const entries = (r && r.entries) || [];
    const evtStart = new Date(evt.times.startISO).getTime();
    const evtEnd   = new Date(evt.times.endISO).getTime();
    let state = 'clean', title = '';
    for (const entry of entries) {
      const entryStart = parseInt(entry.start);
      const entryEnd = entry.end && parseInt(entry.end) > 0
        ? parseInt(entry.end)
        : entryStart + (parseInt(entry.duration) || 0);
      const entryCustomId = entry.task && entry.task.custom_id
        ? entry.task.custom_id.toUpperCase() : null;
      const sameTask = evt.ticketId && entryCustomId &&
        evt.ticketId.toUpperCase() === entryCustomId;
      const overlaps = evtStart < entryEnd && evtEnd > entryStart;
      if (sameTask && overlaps) {
        return {
          state: 'logged',
          title: 'Already logged in ClickUp for ' + entryCustomId,
          matchEntry: { id: entry.id, start: entryStart, end: entryEnd }
        };
      } else if (!sameTask && overlaps && state !== 'logged') {
        state = 'conflict';
        title = 'Time conflict with existing ClickUp entry: ' + (entryCustomId || 'unknown task');
      }
    }
    return { state, title };
  }

  function applyButtonState(btn, state, title) {
    btn.classList.remove('clickup-state-clean', 'clickup-state-logged', 'clickup-state-conflict');
    // Icon + (for non-clean states) a small colored status glyph so the three
    // states stay distinguishable now that the text label is gone.
    const iconUrl = ICON16_DATA_URL;
    let glyph = '';
    if (state === 'logged') {
      glyph = '\u2713';
      btn.classList.add('clickup-state-logged');
    } else if (state === 'conflict') {
      glyph = '\u26a0';
      btn.classList.add('clickup-state-conflict');
    } else {
      btn.classList.add('clickup-state-clean');
    }
    btn.innerHTML = '';
    const img = document.createElement('img');
    img.src = iconUrl;
    img.className = 'clickup-btn-icon';
    img.alt = 'ClickUp';
    btn.appendChild(img);
    if (glyph) {
      const g = document.createElement('span');
      g.className = 'clickup-btn-glyph';
      g.textContent = glyph;
      btn.appendChild(g);
    }
    btn.title = title || 'Push this event to ClickUp';
  }

  // ── Inline ticket combo (full live search, mirrors popup behavior) ─────────
  function buildCombo(container, onResolve, prefill) {
    const wrap = document.createElement('div');
    wrap.className = 'clickup-combo';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'clickup-ticket-input';
    input.placeholder = 'Ticket ID (e.g. CTK-1234)';
    input.autocomplete = 'off';
    if (prefill) input.value = prefill;
    const dropdown = document.createElement('ul');
    dropdown.className = 'clickup-dropdown';
    wrap.appendChild(input);
    wrap.appendChild(dropdown);
    container.appendChild(wrap);

    let frequent = [];
    let searchDebounce = null;
    getFrequentTickets().then(f => { frequent = f; });

    function render(items) {
      dropdown.innerHTML = '';
      if (!items.length) { dropdown.classList.remove('open'); return; }
      items.forEach(t => {
        const li = document.createElement('li');
        li.className = 'clickup-option' + (t.favorite ? ' clickup-option-fav' : '');
        li.textContent = t.id + (t.name ? ' \u2013 ' + t.name.slice(0, 35) +
          (t.name.length > 35 ? '\u2026' : '') : '');
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = t.id;
          dropdown.classList.remove('open');
          onResolve(t.id);
        });
        dropdown.appendChild(li);
      });
      dropdown.classList.add('open');
    }

    function showInfo(text) {
      dropdown.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'clickup-option clickup-option-info';
      li.textContent = text;
      dropdown.appendChild(li);
      dropdown.classList.add('open');
    }

    function showDrop(raw) {
      const value = (raw || '').trim();
      const upper = value.toUpperCase();
      onResolve(COMPLETE_TICKET_REGEX.test(upper) ? upper : null);
      if (COMPLETE_TICKET_REGEX.test(upper)) { dropdown.classList.remove('open'); return; }
      if (!value || upper.startsWith('CTK-') || value.length < 4) { render(frequent); return; }
      showInfo('\u23f3 Searching\u2026');
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchClickupTasks(value).then(tasks => {
          if (input.value.trim().toLowerCase() !== value.toLowerCase()) return;
          if (!tasks.length) { showInfo('No matches'); return; }
          render(tasks.map(t => ({ id: t.id, name: t.name, favorite: false })));
        });
      }, 400);
    }

    input.addEventListener('focus', () => showDrop(input.value));
    input.addEventListener('input', () => showDrop(input.value));
    input.addEventListener('blur', () => setTimeout(() => dropdown.classList.remove('open'), 150));
    return input;
  }

  // ── Push ───────────────────────────────────────────────────────────────────
  async function pushEvent(evt, btn) {
    const settings = await getSettings();
    if (!settings.clickupToken || !settings.teamId) {
      alert('Set your ClickUp API token and Team ID in the extension Settings first.');
      return;
    }
    if (!evt.ticketId) { alert('Enter a ticket ID first.'); return; }
    if (!evt.times) { alert('Could not read this event\u2019s time range.'); return; }

    // Decide create-vs-update. A 'logged' state with a matched entry means the
    // same ticket already has an overlapping entry — update it in place rather
    // than creating a duplicate. 'conflict' (different ticket) still warns and
    // creates new; 'clean' creates new silently.
    const isLogged   = btn.classList.contains('clickup-state-logged');
    const isConflict = btn.classList.contains('clickup-state-conflict');
    const doUpdate   = isLogged && evt.matchEntry && evt.matchEntry.id;

    if (doUpdate) {
      const win = fmtTime(evt.matchEntry.start) + ' \u2013 ' + fmtTime(evt.matchEntry.end);
      const next = fmtTime(new Date(evt.times.startISO).getTime()) + ' \u2013 ' +
                   fmtTime(new Date(evt.times.endISO).getTime());
      if (!confirm(
        'An entry for this ticket already overlaps this time (' + win + ').\n\n' +
        'Update that entry to match this event (' + next + ')?'
      )) return;
    } else if (isLogged || isConflict) {
      const verb = isLogged
        ? 'Time already appears logged for this task/timeframe.'
        : 'This overlaps an existing ClickUp entry for a different task.';
      if (!confirm(verb + '\n\nPush anyway?')) return;
    }

    // Capture state to restore on failure (clean/logged/conflict from classes)
    const prevState = isLogged ? 'logged' : isConflict ? 'conflict' : 'clean';
    const prevTitle = btn.title;
    btn.classList.add('clickup-pushing');
    btn.disabled = true;
    const result = await sendBg(doUpdate ? {
      type: 'UPDATE_TIME_ENTRY',
      timerId: evt.matchEntry.id,
      ticketId: evt.ticketId,
      startTime: evt.times.startISO,
      endTime: evt.times.endISO,
      title: cleanTitle(evt.title),
      billable: true,
      tag: evt.tag || '',
      clickupToken: settings.clickupToken,
      teamId: settings.teamId
    } : {
      type: 'IMPORT_TIME_ENTRY',
      ticketId: evt.ticketId,
      startTime: evt.times.startISO,
      endTime: evt.times.endISO,
      title: cleanTitle(evt.title),
      billable: true,
      tag: evt.tag || '',
      clickupToken: settings.clickupToken,
      teamId: settings.teamId
    });
    btn.disabled = false;
    btn.classList.remove('clickup-pushing');
    if (result && result.success) {
      recordTicketUse(evt.ticketId, result.taskName || null);
      applyButtonState(btn, 'logged',
        (doUpdate ? 'Updated in ClickUp \u2192 ' : 'Pushed to ClickUp \u2192 ') + evt.ticketId);
    } else {
      applyButtonState(btn, prevState, prevTitle);
      alert((doUpdate ? 'Update' : 'Push') + ' failed: ' +
        ((result && result.error) || 'Unknown error'));
    }
  }

  // ── Injection ───────────────────────────────────────────────────────────────
  function inject(popover, attempt) {
    attempt = attempt || 0;

    const title = scrapeTitle(popover);
    const times = scrapeTimes(popover);
    const editBtn = findEditButton(popover);

    // The popover container can mount a tick or two before its title/time and
    // action buttons render. If this looks like an event popover but the
    // content/toolbar isn't ready yet, retry briefly instead of giving up.
    if (!times || !title || !editBtn) {
      const looksLikeEventPopover = editBtn || times || title;
      if (looksLikeEventPopover && attempt < 8) {
        setTimeout(() => inject(popover, attempt + 1), 60);
      }
      return;
    }

    // Google reuses popover DOM nodes across opens. A stale attribute marker
    // would block re-injection when the same node is reused for a different
    // event. So we key on the event's identity (title+time) AND verify our host
    // is actually still in the DOM — re-injecting when either differs.
    const eventKey = title + '|' + times.startISO + '|' + times.endISO;
    const existingHost = popover.querySelector('.clickup-inject-host');
    if (existingHost && popover.getAttribute(MARKER) === eventKey) {
      return; // already injected for this exact event — nothing to do
    }
    if (existingHost) existingHost.remove(); // stale host from a previous event
    popover.setAttribute(MARKER, eventKey);

    const ticketId = (title.match(TICKET_REGEX) || [])[1] || null;
    const evt = { title, times, ticketId, tag: '' };
    dbg('injecting for event:', evt, 'attempt', attempt);

    const host = document.createElement('span');
    host.className = 'clickup-inject-host';

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'clickup-push-btn';
    btn.type = 'button';
    applyButtonState(btn, 'clean', '');

    // Tag dropdown — lives between the ticket combo and the push button.
    // Populated once tags load; its selected value is remembered per ticket
    // (same `ticketTag` storage map the popup uses).
    const tagHost = document.createElement('div');
    tagHost.className = 'clickup-tag-host';

    // (Re)build the tag <select> for the current resolved ticket, restoring its
    // saved preference. Called on initial ticket and whenever it changes.
    function refreshTagSelect(forTicketId) {
      if (!forTicketId) {
        tagHost.innerHTML = '';
        evt.tag = '';
        return;
      }
      Promise.all([fetchTags(), getTagPreference(forTicketId)]).then(([tags, savedTag]) => {
        // Bail if the ticket changed again while we were loading.
        if (evt.ticketId !== forTicketId) return;
        tagHost.innerHTML = '';
        if (!tags.length) { evt.tag = ''; return; }
        const sel = buildTagSelect(savedTag, tags);
        evt.tag = savedTag || '';
        sel.addEventListener('change', (e) => {
          evt.tag = e.target.value;
          saveTagPreference(forTicketId, e.target.value);
        });
        tagHost.appendChild(sel);
      });
    }

    // Layout: ticket input on the LEFT, tag select, then push button (see v2.12.4).
    // Always show the ticket field, prefilled with any detected ticket ID.
    const comboHost = document.createElement('div');
    comboHost.className = 'clickup-combo-host';
    buildCombo(comboHost, (resolvedId) => {
      evt.ticketId = resolvedId;
      refreshTagSelect(resolvedId);
      // The matched entry was detected against the previous ticket — it's now
      // stale. Clear it and re-detect so the button state AND the update target
      // both reflect the newly chosen ticket.
      evt.matchEntry = null;
      detectState(evt).then(({ state, title: t, matchEntry }) => {
        evt.matchEntry = matchEntry || null;
        applyButtonState(btn, state, t);
      });
    }, ticketId);
    host.appendChild(comboHost);
    host.appendChild(tagHost);
    host.appendChild(btn);

    // Prefill the tag select for any auto-detected ticket.
    if (ticketId) refreshTagSelect(ticketId);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pushEvent(evt, btn);
    });

    // Insert into the toolbar's button row (the v2.12.4 placement that was
    // clickable). The host is absolutely positioned via CSS, so its visual
    // location is independent of where in the row it's inserted — but living
    // among the interactive buttons keeps it in a clickable stacking context.
    const row = editBtn.parentElement;
    row.insertBefore(host, row.firstChild);

    // State-aware: refine the button once we've checked ClickUp. Stash the
    // matched entry (if any) on evt so a 'logged' click can UPDATE it in place.
    detectState(evt).then(({ state, title: t, matchEntry }) => {
      evt.matchEntry = matchEntry || null;
      applyButtonState(btn, state, t);
    });
  }

  function scan() {
    for (const sel of SELECTORS.popoverRoot) {
      document.querySelectorAll(sel).forEach(p => {
        // inject() decides if this is a real event popover, whether content is
        // ready, and whether (re-)injection is needed for the current event.
        inject(p, 0);
      });
    }
  }

  // Watch for popovers opening/closing
  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
  scan(); // initial pass in case a popover is already open
})();
