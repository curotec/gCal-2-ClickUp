// popup.js

// ── Debug logger ──────────────────────────────────────────────────────────────
let _debugMode = false;
chrome.storage.local.get(['debugMode'], (r) => { _debugMode = !!r.debugMode; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugMode) _debugMode = !!changes.debugMode.newValue;
});
function dbg(...args) {
  if (_debugMode) console.log('[GCal→ClickUp]', ...args);
}

// ── Constants ─────────────────────────────────────────────────────────────────
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TICKET_REGEX   = /\b([A-Z]+-\d+)\b/;
const TIMER_KEY      = 'adHocTimer';

// ── Update checker ───────────────────────────────────────────────────────────
const MANIFEST_URL = 'https://raw.githubusercontent.com/alberto-curotec/gCal-2-ClickUp/main/manifest.json';

async function checkForUpdate() {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) return;
    const remote = await res.json();
    const remoteVersion = remote.version;
    const localVersion = chrome.runtime.getManifest().version;
    if (!remoteVersion || remoteVersion === localVersion) return;

    // Compare versions — only show if remote is newer
    const toNum = v => v.split('.').map(Number);
    const [rA, rB, rC] = toNum(remoteVersion);
    const [lA, lB, lC] = toNum(localVersion);
    const isNewer = rA > lA || (rA === lA && rB > lB) || (rA === lA && rB === lB && rC > lC);
    if (!isNewer) return;

    const banner = document.getElementById('updateBanner');
    if (!banner) return;
    banner.classList.remove('hidden');
    banner.innerHTML =
      '⬆️ <strong>v' + remoteVersion + ' available</strong> ' +
      '&mdash; <a href="https://bitbucket.org/curotec/gcal-2-clickup/src/main/" ' +
      'target="_blank">View on Bitbucket</a>';
  } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanTitle(raw) {
  return raw
    .replace(/\b[A-Z]+-\d+\b/g, '')
    .replace(/^[\s|\-\u2013]+|[\s|\-\u2013]+$/g, '')
    .trim() || raw;
}

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function durationLabel(startStr, endStr) {
  const totalMin = Math.round((new Date(endStr) - new Date(startStr)) / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return (h && m) ? h + 'h ' + m + 'm' : h ? h + 'h' : m + 'm';
}

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return (h ? h + 'h ' : '') + String(m).padStart(2, '0') + 'm';
}

function formatHMS(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(v => String(v).padStart(2, '0')).join(':');
}

function roundUpTo5Min(ms) {
  return Math.ceil(Math.ceil(ms / 60000) / 5) * 5 * 60000;
}

function getElapsed(startTs) { return Date.now() - startTs; }

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.color = isError ? '#f38ba8' : '#a6adc8';
}

function log(msg, type = 'info') {
  const el = document.getElementById('progressLog');
  const line = document.createElement('div');
  line.className = 'log-' + type;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function isSkipped(title, skipList) {
  const t = title.toLowerCase();
  return skipList.some(s => s && t.includes(s));
}

// ── Storage helpers ───────────────────────────────────────────────────────────
async function getFrequentTickets() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ticketFrequency', 'ticketNames', 'ticketFavorites', 'clickupToken', 'teamId'], async (r) => {
      const freq  = r.ticketFrequency || {};
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const cleaned = {};
      for (const [id, timestamps] of Object.entries(freq)) {
        const recent = timestamps.filter(t => t > cutoff);
        if (recent.length) cleaned[id] = recent;
      }
      chrome.storage.local.set({ ticketFrequency: cleaned });

      const names = { ...(r.ticketNames || {}) };
      const sorted = Object.entries(cleaned)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8)
        .map(([id]) => id);

      // Fetch names for tickets missing from storage
      const missing = sorted.filter(id => !names[id]);
      if (missing.length && r.clickupToken && r.teamId) {
        await Promise.all(missing.map(async (id) => {
          try {
            const res = await fetch(
              'https://api.clickup.com/api/v2/task/' + encodeURIComponent(id) +
              '?custom_task_ids=true&team_id=' + r.teamId,
              { headers: { Authorization: r.clickupToken } }
            );
            if (res.ok) { const d = await res.json(); if (d.name) names[id] = d.name; }
          } catch (_) {}
        }));
        chrome.storage.local.set({ ticketNames: names });
      }

      // Prepend favorites (up to 3), deduped from frequent list
      const favIds = r.ticketFavorites || [];
      const favTickets  = favIds.slice(0, 3).map(id => ({ id, name: names[id] || '', favorite: true }));
      const freqTickets = sorted.filter(id => !favIds.includes(id)).map(id => ({ id, name: names[id] || '', favorite: false }));
      resolve([...favTickets, ...freqTickets].slice(0, 11));
    });
  });
}

function recordTicketUse(ticketId, taskName, billable) {
  if (!ticketId) return;
  chrome.storage.local.get(['ticketFrequency', 'ticketNames', 'ticketBillable'], (r) => {
    const freq    = r.ticketFrequency || {};
    const names   = r.ticketNames || {};
    const billMap = r.ticketBillable || {};
    const cutoff  = Date.now() - THIRTY_DAYS_MS;
    freq[ticketId] = [...(freq[ticketId] || []).filter(t => t > cutoff), Date.now()];
    if (taskName) names[ticketId] = taskName;
    if (billable !== undefined) billMap[ticketId] = billable;
    chrome.storage.local.set({ ticketFrequency: freq, ticketNames: names, ticketBillable: billMap });
  });
}

async function getFavorites() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ticketFavorites', 'ticketNames'], (r) => {
      resolve({ ids: r.ticketFavorites || [], names: r.ticketNames || {} });
    });
  });
}

function toggleFavorite(ticketId, ticketName, starEl) {
  chrome.storage.local.get(['ticketFavorites', 'ticketNames'], (r) => {
    const favs  = r.ticketFavorites || [];
    const names = r.ticketNames || {};
    const idx = favs.indexOf(ticketId);
    if (idx === -1) { favs.push(ticketId); starEl.textContent = '\u2605'; starEl.classList.add('starred'); }
    else            { favs.splice(idx, 1); starEl.textContent = '\u2606'; starEl.classList.remove('starred'); }
    if (ticketName) names[ticketId] = ticketName;
    chrome.storage.local.set({ ticketFavorites: favs, ticketNames: names });
  });
}

async function getToken() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, (resp) => {
      if (resp.error) reject(new Error(resp.error)); else resolve(resp.token);
    });
  });
}

async function fetchEvents(date, token) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin',      new Date(date + 'T00:00:00').toISOString());
  url.searchParams.set('timeMax',      new Date(date + 'T23:59:59').toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy',      'startTime');
  url.searchParams.set('maxResults',   '50');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Calendar API error: ' + res.status);
  return ((await res.json()).items || []).filter(e => e.start && e.start.dateTime);
}

async function getSkipList() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['skipList'], (r) => {
      resolve((r.skipList || '').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean));
    });
  });
}

// ── Ticket validation ────────────────────────────────────────────────────────
async function validateTicket(ticketId) {
  return new Promise(resolve => {
    chrome.storage.local.get(['clickupToken', 'teamId'], async (r) => {
      if (!r.clickupToken || !r.teamId) { resolve({ valid: false, name: null }); return; }
      try {
        const res = await fetch(
          'https://api.clickup.com/api/v2/task/' + encodeURIComponent(ticketId) +
          '?custom_task_ids=true&team_id=' + r.teamId,
          { headers: { Authorization: r.clickupToken } }
        );
        if (!res.ok) { resolve({ valid: false, name: null }); return; }
        const data = await res.json();
        resolve({ valid: !!data.id, name: data.name || null });
      } catch (_) { resolve({ valid: false, name: null }); }
    });
  });
}

function applyTicketValidation(li, input, validIcon, isValid, taskName) {
  const checkbox = li.querySelector('.evt-check');
  const isProtected = li.classList.contains('status-warning') || li.classList.contains('status-danger');
  const idx = input.dataset.index;
  const tagWrap = li.querySelector('.tag-select-wrap[data-index="' + idx + '"]');

  // Get or create the ticket name label, placed after .ticket-input-row
  let nameLabel = li.querySelector('.ticket-name-label');
  if (!nameLabel) {
    nameLabel = document.createElement('div');
    nameLabel.className = 'ticket-name-label';
    const ticketRow = li.querySelector('.ticket-input-row');
    if (ticketRow) {
      ticketRow.insertAdjacentElement('afterend', nameLabel);
    }
  }

  if (isValid) {
    validIcon.textContent = '\u2714';
    validIcon.style.color = '#f9e2af';
    validIcon.title = taskName || '';
    li.classList.remove('ticket-invalid');
    if (checkbox && !isProtected) { checkbox.disabled = false; checkbox.checked = true; }
    input.style.borderColor = '';
    if (nameLabel) nameLabel.textContent = taskName || '';
    // Show tag dropdown
    if (tagWrap) {
      const ticketId = input.value.trim().toUpperCase();
      Promise.all([fetchTags(), getTagPreference(ticketId)]).then(([tags, savedTag]) => {
        tagWrap.innerHTML = '';
        if (tags.length) {
          tagWrap.appendChild(buildTagSelect('tag-' + idx, savedTag, tags));
          tagWrap.classList.remove('hidden');
          tagWrap.querySelector('select').addEventListener('change', (e) => {
            saveTagPreference(ticketId, e.target.value);
          });
        }
      });
    }
  } else {
    validIcon.textContent = '\u2716';
    validIcon.style.color = '#f38ba8';
    validIcon.title = 'Ticket not found in ClickUp';
    li.classList.add('ticket-invalid');
    if (checkbox) { checkbox.disabled = true; checkbox.checked = false; }
    input.style.borderColor = '#f38ba8';
    if (tagWrap) { tagWrap.innerHTML = ''; tagWrap.classList.add('hidden'); }
    if (nameLabel) nameLabel.textContent = '';
  }
}

// ── Billable preference ──────────────────────────────────────────────────────
async function getBillablePreference(ticketId) {
  if (!ticketId) return true;
  return new Promise(resolve => {
    chrome.storage.local.get(['ticketBillable'], (r) => {
      const map = r.ticketBillable || {};
      resolve(ticketId in map ? map[ticketId] : true);
    });
  });
}

function saveBillablePreference(ticketId, billable) {
  if (!ticketId) return;
  chrome.storage.local.get(['ticketBillable'], (r) => {
    const map = r.ticketBillable || {};
    map[ticketId] = billable;
    chrome.storage.local.set({ ticketBillable: map });
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────────
let _cachedTags = null;

async function fetchTags() {
  if (_cachedTags) return _cachedTags;
  return new Promise(resolve => {
    chrome.storage.local.get(['enabledTags', 'cachedTags', 'cachedTagsTs', 'clickupToken', 'teamId'], async (r) => {
      // Use enabledTags if set (user-filtered list)
      if (r.enabledTags && r.enabledTags.length) {
        _cachedTags = r.enabledTags;
        resolve(_cachedTags);
        return;
      }
      // Fall back to full cached list
      if (r.cachedTags && r.cachedTagsTs && (Date.now() - r.cachedTagsTs) < 600000) {
        _cachedTags = r.cachedTags;
        resolve(_cachedTags);
        return;
      }
      if (!r.clickupToken || !r.teamId) { resolve([]); return; }
      try {
        const res = await fetch(
          'https://api.clickup.com/api/v2/team/' + r.teamId + '/time_entries/tags',
          { headers: { Authorization: r.clickupToken } }
        );
        if (!res.ok) { resolve([]); return; }
        const data = await res.json();
        const tags = (data.data || []).map(t => t.name).filter(Boolean).sort();
        _cachedTags = tags;
        chrome.storage.local.set({ cachedTags: tags, cachedTagsTs: Date.now() });
        resolve(tags);
      } catch (_) { resolve([]); }
    });
  });
}

function getTagPreference(ticketId) {
  return new Promise(resolve => {
    chrome.storage.local.get(['ticketTag', 'ticketFavorites'], (r) => {
      const map  = r.ticketTag || {};
      // Favorites take priority — tag was explicitly set there
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

function buildTagSelect(id, selectedTag, tags) {
  const sel = document.createElement('select');
  sel.className = 'tag-select';
  sel.id = id || '';
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

// ── Event Rules matching ─────────────────────────────────────────────────────
async function getMatchingRule(title, startDateTime) {
  return new Promise(resolve => {
    chrome.storage.local.get(['eventRules'], (r) => {
      const rules = r.eventRules || [];
      if (!rules.length) { resolve(null); return; }
      const evTime = new Date(startDateTime);
      const evHHMM = evTime.getHours() + ':' + String(evTime.getMinutes()).padStart(2, '0');
      const titleLower = title.toLowerCase();

      // Priority 1: title contains + time matches
      let match = rules.find(rule =>
        rule.ticketId &&
        titleLower.includes(rule.title.toLowerCase()) &&
        rule.time && rule.time === evHHMM
      );
      // Priority 2: title contains only
      if (!match) match = rules.find(rule =>
        rule.ticketId &&
        titleLower.includes(rule.title.toLowerCase()) &&
        !rule.time
      );
      // Priority 3: time only
      if (!match) match = rules.find(rule =>
        rule.ticketId &&
        !rule.title &&
        rule.time === evHHMM
      );
      resolve(match || null);
    });
  });
}

// ── Dropdown builder (shared by event list and timer) ─────────────────────────
function buildDropdown(dropdown, items, onSelect) {
  while (dropdown.firstChild) dropdown.removeChild(dropdown.firstChild);
  items.forEach(t => {
    const li = document.createElement('li');
    li.className = 'ticket-option' + (t.favorite ? ' ticket-option-fav' : '');
    li.textContent = (t.favorite ? '\u2605 ' : '') + t.id +
      (t.name ? ' \u2013 ' + t.name.slice(0, 35) + (t.name.length > 35 ? '\u2026' : '') : '');
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dbg('dropdown item selected:', t.id);
      onSelect(t.id);
    });
    dropdown.appendChild(li);
  });
  dropdown.classList.add('open');
  dbg('dropdown opened,', items.length, 'items');
}

function wireCombo(input, dropdown, onSelect) {
  return getFrequentTickets().then(frequent => {
    function showDrop(filter) {
      const items = filter
        ? frequent.filter(t => t.id.toUpperCase().includes(filter.toUpperCase()) ||
            t.name.toUpperCase().includes(filter.toUpperCase()))
        : frequent;
      if (!items.length) { dropdown.classList.remove('open'); return; }
      buildDropdown(dropdown, items, (id) => {
        input.value = id;
        dropdown.classList.remove('open');
        if (onSelect) onSelect(id);
      });
    }
    input.addEventListener('focus', () => { dbg('input focus'); showDrop(input.value); });
    input.addEventListener('input', () => { dbg('input change:', input.value); showDrop(input.value); if (onSelect) onSelect(input.value); });
    input.addEventListener('blur',  () => { dbg('input blur:', input.value); setTimeout(() => dropdown.classList.remove('open'), 150); });
  });
}

// ── Event list ────────────────────────────────────────────────────────────────
let eventsCache = [];

function renderEvents(events, skipList, clickupEntries) {
  clickupEntries = clickupEntries || [];
  eventsCache = events;
  const ul = document.getElementById('events');
  ul.innerHTML = '';

  events.forEach((evt, i) => {
    const rawTitle = evt.summary || '(No title)';
    const title    = cleanTitle(rawTitle);
    const start    = evt.start.dateTime;
    const end      = evt.end.dateTime;
    const evtStart = new Date(start).getTime();
    const evtEnd   = new Date(end).getTime();
    // Detect ticket ID from original title (before cleaning)
    const ticketMatch = (rawTitle + ' ' + (evt.description || '')).match(TICKET_REGEX);
    const ticketId    = ticketMatch ? ticketMatch[1] : null;
    const skipped     = isSkipped(title, skipList);

    let status = 'clean', statusTitle = '';
    for (const entry of clickupEntries) {
      const entryStart    = parseInt(entry.start);
      const entryEnd      = entry.end && parseInt(entry.end) > 0 ? parseInt(entry.end) : entryStart + (parseInt(entry.duration) || 0);
      const entryCustomId = entry.task && entry.task.custom_id ? entry.task.custom_id.toUpperCase() : null;
      const sameTask      = ticketId && entryCustomId && ticketId.toUpperCase() === entryCustomId;
      const overlaps      = evtStart < entryEnd && evtEnd > entryStart;
      if (sameTask && overlaps)               { status = 'warning'; statusTitle = 'Already logged in ClickUp for ' + (entryCustomId || 'this task'); break; }
      else if (!sameTask && overlaps && status !== 'warning') { status = 'danger';  statusTitle = 'Time conflict with existing ClickUp entry: ' + (entryCustomId || 'unknown task'); }
    }

    const li = document.createElement('li');
    li.className = 'event-item' +
      (skipped         ? ' skipped'        : '') +
      (status === 'warning' ? ' status-warning' : '') +
      (status === 'danger'  ? ' status-danger'  : '');
    li.dataset.index = i;

    const statusBadge = status === 'warning'
      ? '<span class="status-badge warning" title="' + statusTitle + '">[existing]</span>'
      : status === 'danger'
      ? '<span class="status-badge danger"  title="' + statusTitle + '">[conflict]</span>'
      : '';

    li.innerHTML =
      '<input type="checkbox" class="evt-check" data-index="' + i + '" ' +
        ((!skipped && status === 'clean') ? 'checked="checked"' : '') + ' ' +
        ((skipped || status === 'warning' || status === 'danger') ? 'disabled="disabled"' : '') + ' />' +
      '<div class="event-info">' +
        '<span class="event-title" title="' + title.replace(/"/g, '&quot;') + '">' +
          '<span class="event-title-text">' + title + '</span>' + statusBadge +
        '</span>' +
        '<div class="event-meta">' + formatTime(start) + ' \u2013 ' + formatTime(end) +
          ' \u00a0\u00b7\u00a0 ' + durationLabel(start, end) + '</div>' +
        (!skipped ?
          '<div class="ticket-meta-row">' +
            '<label class="billable-label"><input type="checkbox" class="billable-check" data-index="' + i + '" checked /> Billable</label>' +
            '<button class="star-btn" data-ticket="' + (ticketId || '') + '" title="Favorite this ticket">\u2606</button>' +
          '</div>' : '') +
        (!skipped ?
          '<div class="ticket-input-row">' +
            '<div class="ticket-combo ticket-combo-narrow" data-index="' + i + '">' +
              '<input type="text" class="ticket-manual" data-index="' + i +
              '" placeholder="Ticket ID (e.g. CTK-1234)" autocomplete="off"' +
              (ticketId ? ' value="' + ticketId + '"' : '') + ' />' +
              '<ul class="ticket-dropdown" data-index="' + i + '"></ul>' +
            '</div>' +
            '<span class="ticket-valid-icon" data-index="' + i + '"></span>' +
            '<div class="tag-select-wrap hidden" data-index="' + i + '"></div>' +
          '</div>' : '') +
      '</div>';
    ul.appendChild(li);

    // Imperatively enforce disabled state for warning/danger — belt and suspenders
    if (!skipped && (status === 'warning' || status === 'danger')) {
      const cb = li.querySelector('.evt-check');
      if (cb) { cb.checked = false; cb.disabled = true; }
    }
  });

  document.getElementById('eventCount').textContent = events.length + ' events found';
  document.getElementById('eventList').classList.remove('hidden');
  updateTimeSum();

  // Wire individual checkboxes to update time sum
  document.querySelectorAll('.evt-check').forEach(cb => {
    cb.addEventListener('change', updateTimeSum);
  });

  // Wire star buttons
  getFavorites().then(({ ids: favIds, names }) => {
    document.querySelectorAll('.star-btn').forEach(btn => {
      const initialId = btn.dataset.ticket;
      if (initialId && favIds.includes(initialId)) { btn.textContent = '\u2605'; btn.classList.add('starred'); }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.event-info');
        const inp = row && row.querySelector('.ticket-manual');
        const id  = (inp ? inp.value.trim().toUpperCase() : btn.dataset.ticket) || '';
        if (!id) return;
        btn.dataset.ticket = id;
        toggleFavorite(id, names[id] || '', btn);
      });
    });
  });

  // Wire ticket combo dropdowns + validation
  const prefilled = [];
  document.querySelectorAll('.ticket-manual').forEach(input => {
    const idx       = input.dataset.index;
    const dropdown  = document.querySelector('.ticket-dropdown[data-index="' + idx + '"]');
    const validIcon = document.querySelector('.ticket-valid-icon[data-index="' + idx + '"]');
    const li        = input.closest('.event-item');
    if (!dropdown || !validIcon || !li) return;

    let debounceTimer = null;

    function runValidation(id) {
      if (!id) {
        validIcon.textContent = '';
        input.style.borderColor = '';
        const isProtected = li.classList.contains('status-warning') || li.classList.contains('status-danger');
        const cb = li.querySelector('.evt-check');
        if (cb && !isProtected) { cb.disabled = false; }
        li.classList.remove('ticket-invalid');
        return;
      }
      validIcon.textContent = '⏳';
      validIcon.style.color = '#a6adc8';
      validateTicket(id).then(({ valid, name }) => {
        applyTicketValidation(li, input, validIcon, valid, name);
      });
    }

    wireCombo(input, dropdown, (id) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      runValidation(id.trim().toUpperCase());
    });

    // On-demand validation when typing manually
    input.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const id = input.value.trim().toUpperCase();
      const nl = li ? li.querySelector('.ticket-name-label') : null;
      if (nl) nl.textContent = '';
      if (!id || !/^[A-Z]+-\d+$/.test(id)) { runValidation(''); return; }
      debounceTimer = setTimeout(() => runValidation(id), 600);
    });

    // Pre-fill billable preference when ticket is selected from dropdown
    wireCombo(input, dropdown, (id) => {
      if (!id) return;
      const billableCheck = li.querySelector('.billable-check');
      if (billableCheck) {
        getBillablePreference(id.trim().toUpperCase()).then(pref => {
          billableCheck.checked = pref;
        });
      }
      runValidation(id.trim().toUpperCase());
    });

    // Queue pre-filled tickets for on-load validation + billable pre-fill
    const preId = input.value.trim().toUpperCase();
    if (preId) {
      prefilled.push({ input, validIcon, li, id: preId });
      // Pre-fill billable for pre-detected ticket
      const billableCheck = li.querySelector('.billable-check');
      if (billableCheck) {
        getBillablePreference(preId).then(pref => { billableCheck.checked = pref; });
      }
    }
  });

  // Validate pre-filled tickets on load with stagger to avoid rate limiting
  prefilled.forEach(({ input, validIcon, li, id }, i) => {
    setTimeout(() => {
      validIcon.textContent = '⏳';
      validIcon.style.color = '#a6adc8';
      validateTicket(id).then(({ valid, name }) => {
        applyTicketValidation(li, input, validIcon, valid, name);
      });
    }, i * 300);
  });

  // Apply recurrent event rules after validation stagger completes
  setTimeout(() => {
    events.forEach((evt, i) => {
      const rawTitle  = evt.summary || '';
      const hasTicket = (rawTitle + ' ' + (evt.description || '')).match(TICKET_REGEX);
      if (hasTicket) return;
      const input = document.querySelector('.ticket-manual[data-index="' + i + '"]');
      const li    = input && input.closest('.event-item');
      if (!input || !li || input.value) return;
      getMatchingRule(rawTitle, evt.start.dateTime).then(rule => {
        if (!rule) return;
        input.value = rule.ticketId;
        const billableCheck = li.querySelector('.billable-check');
        if (billableCheck) billableCheck.checked = rule.billable !== false;
        const validIcon = li.querySelector('.ticket-valid-icon');
        if (validIcon) {
          validIcon.textContent = '⏳'; validIcon.style.color = '#a6adc8';
          validateTicket(rule.ticketId).then(({ valid, name }) => {
            applyTicketValidation(li, input, validIcon, valid, name);
            if (valid && rule.tag) {
              setTimeout(() => {
                const tagWrap = li.querySelector('.tag-select-wrap');
                if (tagWrap) { const sel = tagWrap.querySelector('select'); if (sel) sel.value = rule.tag; }
              }, 200);
            }
          });
        }
      });
    });
  }, prefilled.length * 300 + 500);
}

// ── Time sum ─────────────────────────────────────────────────────────────────
function updateTimeSum() {
  let totalMs = 0;
  let selectedCount = 0;
  document.querySelectorAll('.evt-check:checked:not([disabled])').forEach(cb => {
    const i   = parseInt(cb.dataset.index);
    const evt = eventsCache[i];
    if (!evt) return;
    totalMs += new Date(evt.end.dateTime) - new Date(evt.start.dateTime);
    selectedCount++;
  });
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const timeLabel = totalMs > 0 ? (h ? h + 'h ' : '') + m + 'm' : '0m';
  const timeSumEl = document.getElementById('timeSum');
  if (timeSumEl) timeSumEl.textContent = timeLabel;
  const selCountEl = document.getElementById('selectedCount');
  if (selCountEl) selCountEl.textContent = selectedCount ? selectedCount + ' selected' : '';
}

// ── Select All ────────────────────────────────────────────────────────────────
document.getElementById('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.evt-check:not([disabled])').forEach(cb => { cb.checked = e.target.checked; });
  updateTimeSum();
});

// ── Load Events ───────────────────────────────────────────────────────────────
document.getElementById('loadBtn').addEventListener('click', async () => {
  const date = document.getElementById('datePicker').value;
  if (!date) { setStatus('Please select a date.', true); return; }
  setStatus('Authenticating with Google...');
  document.getElementById('eventList').classList.add('hidden');
  document.getElementById('importProgress').classList.add('hidden');
  document.getElementById('timerSection').classList.remove('hidden');
  try {
    const token = await getToken();
    setStatus('Fetching calendar events...');
    const [events, skipList, settings] = await Promise.all([
      fetchEvents(date, token),
      getSkipList(),
      new Promise(resolve => chrome.storage.local.get(['clickupToken', 'teamId'], resolve))
    ]);
    if (!events.length) { setStatus('No events found for this date.'); return; }

    let clickupEntries = [];
    if (settings.clickupToken && settings.teamId) {
      setStatus('Checking existing ClickUp entries...');
      const [userResp, existing] = await Promise.all([
        new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_CLICKUP_USER',    clickupToken: settings.clickupToken }, resolve)),
        new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_CLICKUP_ENTRIES', clickupToken: settings.clickupToken, teamId: settings.teamId, date }, resolve))
      ]);
      if (userResp && userResp.timezone) {
        const tzEl = document.getElementById('clickupTimezone');
        if (tzEl) tzEl.textContent = 'ClickUp timezone: ' + userResp.timezone;
      }
      if (existing && existing.entries) clickupEntries = existing.entries;
    }
    setStatus('');
    document.getElementById('timerSection').classList.add('hidden');
    renderEvents(events, skipList, clickupEntries);
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  }
});

// ── Import ────────────────────────────────────────────────────────────────────
document.getElementById('importBtn').addEventListener('click', async () => {
  const checks = [...document.querySelectorAll('.evt-check:checked:not([disabled])')];
  if (!checks.length) { setStatus('No events selected.', true); return; }

  const selected = checks.map(cb => {
    const i            = parseInt(cb.dataset.index);
    const evt          = eventsCache[i];
    const manualInput  = document.querySelector('.ticket-manual[data-index="' + i + '"]');
    const billableCheck = document.querySelector('.billable-check[data-index="' + i + '"]');
    const validIcon    = document.querySelector('.ticket-valid-icon[data-index="' + i + '"]');
    const titleAndDesc = (evt.summary || '') + ' ' + (evt.description || '');
    const autoTicket   = (titleAndDesc.match(TICKET_REGEX) || [])[1] || null;
    const manualTicket = manualInput ? manualInput.value.trim().toUpperCase() : null;
    // Skip rows where ticket failed validation
    const isInvalid    = validIcon && validIcon.textContent === '✖';
    return Object.assign({}, evt, {
      ticketId: isInvalid ? null : (autoTicket || manualTicket || null),
      billable: billableCheck ? billableCheck.checked : true
    });
  });

  const noTicket = selected.filter(e => !e.ticketId);
  if (noTicket.length) {
    const titles = noTicket.map(e => '"' + (e.summary || '(No title)') + '"').slice(0, 3).join(', ');
    if (!confirm(noTicket.length + ' event(s) have no ticket ID: ' + titles + '.\n\nThey will be skipped. Continue with the rest?')) return;
  }

  const toImport = selected.filter(e => e.ticketId);
  if (!toImport.length) { setStatus('No importable events (all missing ticket ID).', true); return; }

  document.getElementById('eventList').classList.add('hidden');
  document.getElementById('importProgress').classList.remove('hidden');
  document.getElementById('progressLog').innerHTML = '';
  log('Starting import of ' + toImport.length + ' event(s)...', 'info');

  const settings = await new Promise(resolve => chrome.storage.local.get(['clickupToken', 'teamId'], resolve));
  if (!settings.clickupToken) { log('No ClickUp API token set. Please add it in \u2699\ufe0f Settings.', 'err'); return; }
  if (!settings.teamId)       { log('No ClickUp Team ID set. Please add it in \u2699\ufe0f Settings.', 'err'); return; }

  for (const evt of toImport) {
    const title = cleanTitle(evt.summary || '(No title)');
    log('Importing: "' + title + '" [' + evt.ticketId + ']', 'info');
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'IMPORT_TIME_ENTRY',
        ticketId:  evt.ticketId,
        startTime: evt.start.dateTime,
        endTime:   evt.end.dateTime,
        title,
        billable:      evt.billable,
        tag:           evt.tag || '',
        clickupToken:  settings.clickupToken,
        teamId:        settings.teamId
      });
      if (result && result.success) {
        log('Done: "' + title + '" \u2192 ' + evt.ticketId, 'ok');
        recordTicketUse(evt.ticketId, result.taskName || null, evt.billable);
      } else {
        log('Failed: "' + title + '" \u2014 ' + ((result && result.error) || 'Unknown error'), 'err');
      }
    } catch (err) {
      log('Error: "' + title + '" \u2014 ' + err.message, 'err');
    }
    await new Promise(r => setTimeout(r, 400));
  }
  log('Import complete!', 'ok');
  document.getElementById('timerSection').classList.remove('hidden');
});

// ── Init date picker ──────────────────────────────────────────────────────────
(function init() {
  const today = new Date();
  document.getElementById('datePicker').value =
    today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');
})();

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── Ad-hoc Timer ──────────────────────────────────────────────────────────────
let timerInterval = null;

function updateTimerDisplay() {
  chrome.storage.local.get([TIMER_KEY], (r) => {
    const t = r[TIMER_KEY];
    if (!t || !t.running) return;
    if (t.paused) return; // frozen while paused
    const elapsed = (t.pausedElapsed || 0) + getElapsed(t.startTs);
    document.getElementById('timerDisplay').textContent = formatHMS(elapsed);
  });
}

function startTimerUI() {
  const btn      = document.getElementById('timerBtn');
  const pauseBtn = document.getElementById('timerPauseBtn');
  btn.textContent = '\u23f9 Stop';
  btn.classList.replace('timer-start', 'timer-stop');
  pauseBtn.textContent = '\u23f8 Pause';
  pauseBtn.classList.remove('hidden', 'timer-resume');
  pauseBtn.classList.add('timer-pause');
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function pauseTimerUI(frozenDisplay) {
  const pauseBtn = document.getElementById('timerPauseBtn');
  pauseBtn.textContent = '\u25b6 Resume';
  pauseBtn.classList.remove('timer-pause');
  pauseBtn.classList.add('timer-resume');
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (frozenDisplay) document.getElementById('timerDisplay').textContent = frozenDisplay;
}

function stopTimerUI() {
  const btn      = document.getElementById('timerBtn');
  const pauseBtn = document.getElementById('timerPauseBtn');
  btn.textContent = '\u25b6 Start';
  btn.classList.replace('timer-stop', 'timer-start');
  pauseBtn.classList.add('hidden');
  pauseBtn.classList.remove('timer-pause', 'timer-resume');
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  document.getElementById('timerDisplay').textContent = '00:00:00';
}

function persistConfirmState() {
  const desc = document.getElementById('timerDescription').value;
  document.getElementById('timerLog').disabled = !desc.trim();
  chrome.storage.local.get(['adHocTimerConfirm'], (r) => {
    const existing = r.adHocTimerConfirm || {};
    chrome.storage.local.set({ adHocTimerConfirm: {
      ticketId:    document.getElementById('timerConfirmTicket').value.trim().toUpperCase(),
      durationMs:  parseInt(document.getElementById('durDisplay').dataset.ms),
      billable:    document.getElementById('timerBillable').checked,
      description: desc,
      rawMs:       existing.rawMs || 0
    }});
  });
}

function validateTimerTicket() {
  const input     = document.getElementById('timerConfirmTicket');
  const validIcon = document.getElementById('timerConfirmValidIcon');
  const logBtn    = document.getElementById('timerLog');
  const id        = input.value.trim().toUpperCase();
  const desc      = document.getElementById('timerDescription').value.trim();

  if (!id) {
    if (validIcon) { validIcon.textContent = ''; }
    logBtn.disabled = true;
    return;
  }
  if (validIcon) { validIcon.textContent = '⏳'; validIcon.style.color = '#a6adc8'; }
  logBtn.disabled = true;

  validateTicket(id).then(({ valid, name }) => {
    if (valid) {
      if (validIcon) { validIcon.textContent = '✔'; validIcon.style.color = '#f9e2af'; validIcon.title = name || ''; }
      input.style.borderColor = '';
      logBtn.disabled = !desc;
    } else {
      if (validIcon) { validIcon.textContent = '✖'; validIcon.style.color = '#f38ba8'; validIcon.title = 'Ticket not found'; }
      input.style.borderColor = '#f38ba8';
      logBtn.disabled = true;
    }
  });
}

function renderTimerConfirm(ticketId, durationMs, billable, rawMs, description) {
  document.getElementById('timerSection').classList.add('hidden');
  document.getElementById('timerConfirm').classList.remove('hidden');
  document.getElementById('timerConfirmTicket').value = ticketId;
  document.getElementById('durDisplay').dataset.ms    = durationMs;
  document.getElementById('durDisplay').textContent   = formatDuration(durationMs);
  document.getElementById('timerBillable').checked    = billable;
  document.getElementById('timerDescription').value   = description || '';
  const rawEl = document.getElementById('timerRawDisplay');
  if (rawEl && rawMs) rawEl.textContent = formatHMS(rawMs);
  document.getElementById('timerLog').disabled = true;
  wireCombo(document.getElementById('timerConfirmTicket'), document.getElementById('timerConfirmDropdown'));
  if (ticketId) validateTimerTicket();
  // Load tag dropdown
  Promise.all([fetchTags(), getTagPreference(ticketId)]).then(([tags, savedTag]) => {
    const wrap = document.getElementById('timerTagWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (tags.length) {
      wrap.appendChild(buildTagSelect('timerTagSelect', savedTag, tags));
    }
  });
}

function showTimerConfirm(ticketId, elapsedMs) {
  const rounded = roundUpTo5Min(elapsedMs);
  getBillablePreference(ticketId || '').then(billable => {
    chrome.storage.local.set({ adHocTimerConfirm: { ticketId: ticketId || '', durationMs: rounded, billable, rawMs: elapsedMs, description: '' } });
    renderTimerConfirm(ticketId || '', rounded, billable, elapsedMs, '');
  });
}

function hideTimerConfirm() {
  chrome.storage.local.remove(['adHocTimerConfirm']);
  document.getElementById('timerConfirm').classList.add('hidden');
  document.getElementById('timerSection').classList.remove('hidden');
}

async function detectTicketFromTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs.length) { resolve(null); return; }
      const tab = tabs[0];
      const url = tab.url || '';

      // 1. Try URL pattern first (task pages)
      const urlMatch = url.match(/\/t\/(?:\d+\/)?([A-Z]+-\d+)/i);
      if (urlMatch) { resolve(urlMatch[1].toUpperCase()); return; }

      // 2. Not a ClickUp page at all
      if (!url.includes('clickup.com')) { resolve(null); return; }

      // 3. Ask content script to read from DOM (inbox and other views)
      chrome.tabs.sendMessage(tab.id, { type: 'GET_TICKET_FROM_DOM' }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp && resp.ticketId ? resp.ticketId.toUpperCase() : null);
      });
    });
  });
}

async function initTimer() {
  const input     = document.getElementById('timerTicketInput');
  const dropdown  = document.getElementById('timerDropdown');
  const starBtn   = document.getElementById('timerStarBtn');
  const validIcon = document.getElementById('timerInputValidIcon');

  function syncStar() {
    const id = input.value.trim().toUpperCase();
    dbg('syncStar, id:', id);
    if (!id) { starBtn.textContent = '\u2606'; starBtn.classList.remove('starred'); return; }
    chrome.storage.local.get(['ticketFavorites'], (r) => {
      const isFav = (r.ticketFavorites || []).includes(id);
      dbg('syncStar isFav:', isFav);
      starBtn.textContent = isFav ? '\u2605' : '\u2606';
      isFav ? starBtn.classList.add('starred') : starBtn.classList.remove('starred');
    });
  }

  let timerInputDebounce = null;
  // Task name label for timer input — lives AFTER the timer-ticket-row, not inside the combo
  const timerTicketRow = document.querySelector('.timer-ticket-row');
  let timerNameLabel = document.getElementById('timerNameLabel');
  if (!timerNameLabel) {
    timerNameLabel = document.createElement('div');
    timerNameLabel.className = 'ticket-name-label';
    timerNameLabel.id = 'timerNameLabel';
    timerTicketRow.insertAdjacentElement('afterend', timerNameLabel);
  }

  function runInputValidation(id) {
    if (!id) {
      validIcon.textContent = '';
      input.style.borderColor = '';
      timerNameLabel.textContent = '';
      return;
    }
    validIcon.textContent = '\u23f3';
    validIcon.style.color = '#a6adc8';
    validateTicket(id).then(({ valid, name }) => {
      if (valid) {
        validIcon.textContent = '\u2714';
        validIcon.style.color = '#f9e2af';
        validIcon.title = name || '';
        input.style.borderColor = '';
        timerNameLabel.textContent = name || '';
      } else {
        validIcon.textContent = '\u2716';
        validIcon.style.color = '#f38ba8';
        validIcon.title = 'Ticket not found in ClickUp';
        input.style.borderColor = '#f38ba8';
        timerNameLabel.textContent = '';
      }
    });
  }

  // Restore running timer or auto-detect from tab
  await new Promise(resolve => {
    chrome.storage.local.get([TIMER_KEY], (r) => {
      const t = r[TIMER_KEY];
      if (t && t.running) {
        if (t.ticketId) input.value = t.ticketId;
        if (t.paused) {
          // Restore paused state
          const pauseBtn = document.getElementById('timerPauseBtn');
          const stopBtn  = document.getElementById('timerBtn');
          stopBtn.textContent = '⏹ Stop';
          stopBtn.classList.replace('timer-start', 'timer-stop');
          pauseBtn.classList.remove('hidden');
          pauseTimerUI(formatHMS(t.pausedElapsed || 0));
        } else {
          startTimerUI();
          updateTimerDisplay();
        }
      }
      resolve();
    });
  });
  if (!input.value) { const detected = await detectTicketFromTab(); if (detected) input.value = detected; }

  // Validate pre-filled/restored ticket
  if (input.value) runInputValidation(input.value.trim().toUpperCase());

  // Wire combo — syncStar + validate on selection
  wireCombo(input, dropdown, (id) => {
    dbg('wireCombo onSelect, id:', id);
    syncStar();
    runInputValidation(id.trim().toUpperCase());
  }).then(() => syncStar());

  // Validate on typing (debounced)
  input.addEventListener('input', () => {
    syncStar();
    if (timerInputDebounce) clearTimeout(timerInputDebounce);
    const id = input.value.trim().toUpperCase();
    if (!id || !/^[A-Z]+-\d+$/.test(id)) { runInputValidation(''); return; }
    timerInputDebounce = setTimeout(() => runInputValidation(id), 600);
  });

  // Star button
  starBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = input.value.trim().toUpperCase();
    if (!id) return;
    chrome.storage.local.get(['ticketNames'], (r) => {
      toggleFavorite(id, (r.ticketNames || {})[id] || '', starBtn);
      setTimeout(syncStar, 100);
    });
  });
}

// ── Timer controls ────────────────────────────────────────────────────────────
document.getElementById('timerBtn').addEventListener('click', () => {
  // Block starting a new timer if confirm panel is pending
  if (!document.getElementById('timerConfirm').classList.contains('hidden')) return;

  chrome.storage.local.get([TIMER_KEY], (r) => {
    const t = r[TIMER_KEY];
    if (t && t.running) {
      // Calculate total elapsed including any previously paused time
      const elapsed = t.paused
        ? (t.pausedElapsed || 0)
        : (t.pausedElapsed || 0) + getElapsed(t.startTs);
      chrome.storage.local.remove([TIMER_KEY]);
      stopTimerUI();
      showTimerConfirm(t.ticketId, elapsed);
      chrome.runtime.sendMessage({ type: 'TIMER_STOP' });
    } else {
      const ticketId = document.getElementById('timerTicketInput').value.trim().toUpperCase();
      const timerData = { running: true, startTs: Date.now(), ticketId: ticketId || null, pausedElapsed: 0, paused: false };
      chrome.storage.local.set({ [TIMER_KEY]: timerData });
      startTimerUI();
      chrome.runtime.sendMessage({ type: 'TIMER_START', startTs: timerData.startTs });
    }
  });
});

document.getElementById('timerBillable').addEventListener('change', persistConfirmState);
document.getElementById('timerDescription').addEventListener('input', () => {
  persistConfirmState();
  // Re-check log button — only enable if ticket is valid AND description filled
  const validIcon = document.getElementById('timerConfirmValidIcon');
  const desc = document.getElementById('timerDescription').value.trim();
  const ticketValid = validIcon && validIcon.textContent === '✔';
  document.getElementById('timerLog').disabled = !(ticketValid && desc);
});

let timerTicketDebounce = null;
document.getElementById('timerConfirmTicket').addEventListener('input', () => {
  persistConfirmState();
  if (timerTicketDebounce) clearTimeout(timerTicketDebounce);
  const id = document.getElementById('timerConfirmTicket').value.trim().toUpperCase();
  if (!id || !/^[A-Z]+-\d+$/.test(id)) {
    const vi = document.getElementById('timerConfirmValidIcon');
    if (vi) { vi.textContent = ''; }
    document.getElementById('timerLog').disabled = true;
    return;
  }
  // Pre-fill billable from preference when ticket ID changes
  getBillablePreference(id).then(pref => {
    document.getElementById('timerBillable').checked = pref;
  });
  timerTicketDebounce = setTimeout(validateTimerTicket, 600);
});

document.getElementById('timerLog').addEventListener('click', async () => {
  const ticketId   = document.getElementById('timerConfirmTicket').value.trim().toUpperCase();
  const durationMs = parseInt(document.getElementById('durDisplay').dataset.ms);
  const billable   = document.getElementById('timerBillable').checked;
  const statusEl   = document.getElementById('timerConfirmStatus');

  if (!ticketId) { statusEl.style.color = '#f38ba8'; statusEl.textContent = 'Please enter a ticket ID.'; return; }

  const settings = await new Promise(resolve => chrome.storage.local.get(['clickupToken', 'teamId'], resolve));
  if (!settings.clickupToken || !settings.teamId) {
    statusEl.style.color = '#f38ba8'; statusEl.textContent = 'ClickUp token/team not set in Settings.'; return;
  }

  statusEl.style.color = '#a6adc8'; statusEl.textContent = 'Logging...';
  const endTime   = Date.now();
  const startTime = endTime - durationMs;

  const description = document.getElementById('timerDescription').value.trim();
  const tagSelect   = document.getElementById('timerTagSelect');
  const tag         = tagSelect ? tagSelect.value : '';
  if (tag && ticketId) saveTagPreference(ticketId, tag);
  const result = await new Promise(resolve => chrome.runtime.sendMessage({
    type: 'IMPORT_TIME_ENTRY', ticketId,
    startTime: new Date(startTime).toISOString(),
    endTime:   new Date(endTime).toISOString(),
    title: description, billable, tag,
    clickupToken: settings.clickupToken, teamId: settings.teamId
  }, resolve));

  if (result && result.success) {
    recordTicketUse(ticketId, result.taskName || null, billable);
    statusEl.style.color = '#a6e3a1'; statusEl.textContent = 'Logged!';
    setTimeout(() => { hideTimerConfirm(); statusEl.textContent = ''; }, 1500);
  } else {
    statusEl.style.color = '#f38ba8';
    statusEl.textContent = 'Failed: ' + ((result && result.error) || 'Unknown error');
  }
});

document.getElementById('timerDiscard').addEventListener('click', hideTimerConfirm);

// ── Pause / Resume ────────────────────────────────────────────────────────────
document.getElementById('timerPauseBtn').addEventListener('click', () => {
  chrome.storage.local.get([TIMER_KEY], (r) => {
    const t = r[TIMER_KEY];
    if (!t || !t.running) return;

    if (!t.paused) {
      // Pause — freeze elapsed, record pausedElapsed
      const elapsed = (t.pausedElapsed || 0) + getElapsed(t.startTs);
      const updated = { ...t, paused: true, pausedElapsed: elapsed, startTs: t.startTs };
      chrome.storage.local.set({ [TIMER_KEY]: updated });
      pauseTimerUI(formatHMS(elapsed));
      chrome.runtime.sendMessage({ type: 'TIMER_PAUSE' });
    } else {
      // Resume — restart startTs from now
      const updated = { ...t, paused: false, startTs: Date.now() };
      chrome.storage.local.set({ [TIMER_KEY]: updated });
      startTimerUI();
      chrome.runtime.sendMessage({ type: 'TIMER_RESUME', startTs: updated.startTs, pausedElapsed: updated.pausedElapsed });
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TIMER_AUTO_STOP') {
    // Confirm state already saved by background.js — just restore UI
    stopTimerUI();
    chrome.storage.local.get(['adHocTimerConfirm'], (r) => {
      if (r.adHocTimerConfirm) {
        const { ticketId, durationMs, billable, rawMs, description } = r.adHocTimerConfirm;
        renderTimerConfirm(ticketId, durationMs, billable, rawMs, description);
      }
    });
  }
});

// Check for updates on popup open
checkForUpdate();

// Restore confirm panel if pending, then init timer
chrome.storage.local.get(['adHocTimerConfirm'], (r) => {
  if (r.adHocTimerConfirm) {
    const { ticketId, durationMs, billable, rawMs, description } = r.adHocTimerConfirm;
    renderTimerConfirm(ticketId, durationMs, billable, rawMs || 0, description || '');
  }
});
initTimer();
