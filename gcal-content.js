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

  // Inline "remove" icon (circled X). Colored via CSS `fill: currentColor` so it
  // can inherit the button's red. viewBox kept from the source path.
  const DELETE_ICON_SVG =
    '<svg class="clickup-del-icon" viewBox="0 0 122.87 122.87" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M18,18A61.45,61.45,0,1,1,0,61.44,61.28,61.28,0,0,1,18,18ZM77.38,39l6.53,6.54a4,4,0,0,1,0,5.63L73.6,61.44,83.91,71.75a4,4,0,0,1,0,5.63l-6.53,6.53a4,4,0,0,1-5.63,0L61.44,73.6,51.13,83.91a4,4,0,0,1-5.63,0L39,77.38a4,4,0,0,1,0-5.63L49.28,61.44,39,51.13a4,4,0,0,1,0-5.63L45.5,39a4,4,0,0,1,5.63,0L61.44,49.28,71.75,39a4,4,0,0,1,5.63,0ZM61.44,10.54a50.91,50.91,0,1,0,36,14.91,50.83,50.83,0,0,0-36-14.91Z"/></svg>';

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
  // On a match (logged or conflict) also returns { logged } describing the
  // existing ClickUp entry — its ticket (custom_id) and tag names — so the
  // popover can show what's already there while the push button is disabled.
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

    // Pull the existing entry's id + ticket + tag names into a small object —
    // id lets a delete target it, ticket/tags drive the read-only display.
    const describe = (entry, customId) => ({
      id: entry.id,
      ticketId: customId || (entry.task && entry.task.custom_id) || '',
      tags: (entry.tags || []).map(t => t && t.name).filter(Boolean)
    });

    let state = 'clean', title = '', logged = null;
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
          logged: describe(entry, entryCustomId)
        };
      } else if (!sameTask && overlaps && state !== 'logged') {
        state = 'conflict';
        title = 'Time conflict with existing ClickUp entry: ' + (entryCustomId || 'unknown task');
        logged = describe(entry, entryCustomId);
      }
    }
    return { state, title, logged };
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
    // Disable pushing when an entry already exists for this timeframe — either
    // the same ticket (logged ✓, would duplicate) or a different ticket
    // (conflict ⚠, overlapping). Blocking the click is the simplest reliable
    // guard against duplicate/overlapping entries. 'clean' stays enabled.
    btn.disabled = (state === 'logged' || state === 'conflict');
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
  async function pushEvent(evt, btn, recheck) {
    const settings = await getSettings();
    if (!settings.clickupToken || !settings.teamId) {
      alert('Set your ClickUp API token and Team ID in the extension Settings first.');
      return;
    }
    if (!evt.ticketId) { alert('Enter a ticket ID first.'); return; }
    if (!evt.times) { alert('Could not read this event\u2019s time range.'); return; }

    // The button is disabled in the logged/conflict states (see applyButtonState),
    // so reaching here means the timeframe is clear. Push creates a new entry.
    const prevTitle = btn.title;
    btn.classList.add('clickup-pushing');
    btn.disabled = true;
    const result = await sendBg({
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
    btn.classList.remove('clickup-pushing');
    if (result && result.success) {
      recordTicketUse(evt.ticketId, result.taskName || null);
      // Re-check so the now-logged state is reflected (button disabled, ticket
      // shown read-only, delete button available).
      if (recheck) recheck();
      else applyButtonState(btn, 'logged', 'Pushed to ClickUp \u2192 ' + evt.ticketId);
    } else {
      // Restore the clean (enabled) state so the user can retry.
      applyButtonState(btn, 'clean', prevTitle);
      alert('Push failed: ' + ((result && result.error) || 'Unknown error'));
    }
  }

  // ── Delete an existing (blocking) ClickUp entry ────────────────────────────
  // Shown in the logged/conflict states. Confirms first, then deletes via the
  // background, then re-checks so the popover reflects the cleared state.
  async function deleteEntry(evt, delBtn, recheck) {
    const settings = await getSettings();
    if (!settings.clickupToken || !settings.teamId) {
      alert('Set your ClickUp API token and Team ID in the extension Settings first.');
      return;
    }
    if (!evt.matchEntryId) { alert('No matching ClickUp entry to delete.'); return; }

    const ticketLabel = (evt.ticketDisplay || evt.ticketId || 'this task');
    const win = evt.times
      ? ' (' + fmtTime(new Date(evt.times.startISO).getTime()) + ' \u2013 ' +
        fmtTime(new Date(evt.times.endISO).getTime()) + ')'
      : '';
    if (!confirm(
      'Delete the existing ClickUp time entry for ' + ticketLabel + win + '?\n\n' +
      'It can be restored from ClickUp\u2019s Trash within 30 days.'
    )) return;

    delBtn.classList.add('clickup-pushing');
    delBtn.disabled = true;
    const result = await sendBg({
      type: 'DELETE_TIME_ENTRY',
      timerId: evt.matchEntryId,
      clickupToken: settings.clickupToken,
      teamId: settings.teamId
    });
    delBtn.disabled = false;
    delBtn.classList.remove('clickup-pushing');
    if (result && result.success) {
      if (recheck) recheck();
    } else {
      alert('Delete failed: ' + ((result && result.error) || 'Unknown error'));
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

    // Delete button — only shown in the logged/conflict states (an entry exists).
    // Lets you remove the blocking ClickUp entry straight from the popover. Hidden
    // by default; shown/hidden by applyState. The matched entry's id is read from
    // evt.matchEntryId at click time.
    const delBtn = document.createElement('button');
    delBtn.className = 'clickup-del-btn clickup-hidden';
    delBtn.type = 'button';
    delBtn.title = 'Delete the existing ClickUp entry';
    delBtn.innerHTML = DELETE_ICON_SVG;

    // Tag dropdown — lives between the ticket combo and the push button.
    // Populated once tags load; its selected value is remembered per ticket
    // (same `ticketTag` storage map the popup uses).
    const tagHost = document.createElement('div');
    tagHost.className = 'clickup-tag-host';

    // True while the fields are showing an existing ClickUp entry (read-only).
    // Guards the async tag refresh from clobbering that display if it resolves
    // after we've switched into the logged/conflict view.
    let loggedDisplayActive = false;

    // (Re)build the tag <select> for the current resolved ticket, restoring its
    // saved preference. Called on initial ticket and whenever it changes.
    function refreshTagSelect(forTicketId) {
      if (!forTicketId) {
        if (!loggedDisplayActive) tagHost.innerHTML = '';
        evt.tag = '';
        return;
      }
      Promise.all([fetchTags(), getTagPreference(forTicketId)]).then(([tags, savedTag]) => {
        // Bail if the ticket changed again while we were loading, or if a
        // read-only logged display is now in effect.
        if (evt.ticketId !== forTicketId || loggedDisplayActive) return;
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
    const ticketInput = buildCombo(comboHost, (resolvedId) => {
      // resolvedId is null while the user is mid-search (typing a partial term
      // that isn't yet a complete ticket pattern). In that case do NOT touch
      // evt.ticketId or re-run detection: a "clean" result would call
      // clearLoggedDisplay() and overwrite the input with the empty ticket,
      // wiping whatever the user is typing. Only react once a ticket is
      // actually resolved (complete pattern typed, or option clicked).
      if (!resolvedId) return;
      evt.ticketId = resolvedId;
      // Leaving any read-only logged view: re-enable editing before re-checking.
      loggedDisplayActive = false;
      refreshTagSelect(resolvedId);
      // Re-detect against the newly chosen ticket so the enable/disable guard
      // stays accurate (a conflict for the old ticket may not apply to the new
      // one, and vice versa). While checking, neutralize the button so a stale
      // logged/conflict disable doesn't linger or mis-enable.
      applyButtonState(btn, 'clean', 'Checking ClickUp\u2026');
      if (ticketInput) ticketInput.disabled = false;
      detectState(evt).then(({ state, title: t, logged }) =>
        applyState(state, t, logged));
    }, ticketId);
    host.appendChild(comboHost);
    host.appendChild(tagHost);
    host.appendChild(btn);
    host.appendChild(delBtn);

    // Prefill the tag select for any auto-detected ticket.
    if (ticketId) refreshTagSelect(ticketId);

    // When an overlapping ClickUp entry exists (logged/conflict), the push
    // button is disabled and the ticket field becomes a read-only indicator of
    // the existing entry's ticket. The tag select is HIDDEN to make room for a
    // delete button (which removes the blocking entry). On a clean state we
    // restore the editable fields and hide the delete button.
    function applyLoggedDisplay(logged) {
      if (ticketInput) {
        ticketInput.value = logged.ticketId || '';
        ticketInput.disabled = true;
      }
      tagHost.classList.add('clickup-hidden');     // free room for delete button
      evt.matchEntryId = logged.id || null;
      evt.ticketDisplay = logged.ticketId || '';   // for the delete confirm label
      delBtn.classList.toggle('clickup-hidden', !logged.id);
    }

    function clearLoggedDisplay() {
      if (ticketInput) {
        ticketInput.disabled = false;
        // Restore the event's own ticket (the logged view may have shown a
        // different existing entry's ticket).
        ticketInput.value = evt.ticketId || '';
      }
      tagHost.classList.remove('clickup-hidden');
      delBtn.classList.add('clickup-hidden');
      evt.matchEntryId = null;
      // Rebuild the tag select cleanly from the current event ticket.
      refreshTagSelect(evt.ticketId);
    }

    // Single funnel for state results: set the button, then reflect (or clear)
    // the existing-entry display on the fields.
    function applyState(state, t, logged) {
      applyButtonState(btn, state, t);
      if ((state === 'logged' || state === 'conflict') && logged) {
        loggedDisplayActive = true;
        applyLoggedDisplay(logged);
      } else {
        loggedDisplayActive = false;
        clearLoggedDisplay();
      }
    }

    // Re-run detection and refresh the whole UI (button, fields, delete button).
    // Used after a push or delete so the popover reflects ClickUp's new reality
    // without needing to be reopened.
    function recheck() {
      loggedDisplayActive = false;
      applyButtonState(btn, 'clean', 'Checking ClickUp\u2026');
      detectState(evt).then(({ state, title: t, logged }) =>
        applyState(state, t, logged));
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pushEvent(evt, btn, recheck);
    });

    delBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteEntry(evt, delBtn, recheck);
    });

    // Insert into the toolbar's button row (the v2.12.4 placement that was
    // clickable). The host is absolutely positioned via CSS, so its visual
    // location is independent of where in the row it's inserted — but living
    // among the interactive buttons keeps it in a clickable stacking context.
    const row = editBtn.parentElement;
    row.insertBefore(host, row.firstChild);

    // State-aware: refine the button once we've checked ClickUp
    detectState(evt).then(({ state, title: t, logged }) =>
      applyState(state, t, logged));
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
