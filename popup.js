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
        .slice(0, 5)
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
      resolve([...favTickets, ...freqTickets].slice(0, 8));
    });
  });
}

function recordTicketUse(ticketId, taskName) {
  if (!ticketId) return;
  chrome.storage.local.get(['ticketFrequency', 'ticketNames'], (r) => {
    const freq  = r.ticketFrequency || {};
    const names = r.ticketNames || {};
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    freq[ticketId] = [...(freq[ticketId] || []).filter(t => t > cutoff), Date.now()];
    if (taskName) names[ticketId] = taskName;
    chrome.storage.local.set({ ticketFrequency: freq, ticketNames: names });
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
        (!skipped && status === 'clean' ? 'checked' : '') + ' ' + (skipped ? 'disabled' : '') + ' />' +
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
          '<div class="ticket-input-row"><div class="ticket-combo" data-index="' + i + '">' +
            '<input type="text" class="ticket-manual" data-index="' + i +
            '" placeholder="Ticket ID (e.g. CTK-1234)" autocomplete="off"' +
            (ticketId ? ' value="' + ticketId + '"' : '') + ' />' +
            '<ul class="ticket-dropdown" data-index="' + i + '"></ul>' +
          '</div></div>' : '') +
      '</div>';
    ul.appendChild(li);
  });

  document.getElementById('eventCount').textContent = events.length + ' events found';
  document.getElementById('eventList').classList.remove('hidden');

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

  // Wire ticket combo dropdowns
  document.querySelectorAll('.ticket-manual').forEach(input => {
    const idx      = input.dataset.index;
    const dropdown = document.querySelector('.ticket-dropdown[data-index="' + idx + '"]');
    if (!dropdown) return;
    wireCombo(input, dropdown);
  });
}

// ── Select All ────────────────────────────────────────────────────────────────
document.getElementById('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.evt-check:not([disabled])').forEach(cb => { cb.checked = e.target.checked; });
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
    const titleAndDesc = (evt.summary || '') + ' ' + (evt.description || '');
    const autoTicket   = (titleAndDesc.match(TICKET_REGEX) || [])[1] || null;
    const manualTicket = manualInput ? manualInput.value.trim().toUpperCase() : null;
    return Object.assign({}, evt, {
      ticketId: autoTicket || manualTicket || null,
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
        clickupToken:  settings.clickupToken,
        teamId:        settings.teamId
      });
      if (result && result.success) {
        log('Done: "' + title + '" \u2192 ' + evt.ticketId, 'ok');
        recordTicketUse(evt.ticketId, result.taskName || null);
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
    document.getElementById('timerDisplay').textContent = formatHMS(getElapsed(t.startTs));
  });
}

function startTimerUI() {
  const btn = document.getElementById('timerBtn');
  btn.textContent = '\u23f9 Stop';
  btn.classList.replace('timer-start', 'timer-stop');
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimerUI() {
  const btn = document.getElementById('timerBtn');
  btn.textContent = '\u25b6 Start';
  btn.classList.replace('timer-stop', 'timer-start');
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

function renderTimerConfirm(ticketId, durationMs, billable, rawMs, description) {
  document.getElementById('timerSection').classList.add('hidden');
  document.getElementById('timerConfirm').classList.remove('hidden');
  document.getElementById('timerConfirmTicket').value = ticketId;
  document.getElementById('durDisplay').dataset.ms    = durationMs;
  document.getElementById('durDisplay').textContent   = formatDuration(durationMs);
  document.getElementById('timerBillable').checked    = billable;
  document.getElementById('timerDescription').value   = description || '';
  // Show raw tracked time in top right
  const rawEl = document.getElementById('timerRawDisplay');
  if (rawEl && rawMs) rawEl.textContent = formatHMS(rawMs);
  // Log button starts disabled until description is filled
  document.getElementById('timerLog').disabled = !(description && description.trim());
  wireCombo(document.getElementById('timerConfirmTicket'), document.getElementById('timerConfirmDropdown'));
}

function showTimerConfirm(ticketId, elapsedMs) {
  const rounded = roundUpTo5Min(elapsedMs);
  chrome.storage.local.set({ adHocTimerConfirm: { ticketId: ticketId || '', durationMs: rounded, billable: true, rawMs: elapsedMs, description: '' } });
  renderTimerConfirm(ticketId || '', rounded, true, elapsedMs, '');
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
      const match = (tabs[0].url || '').match(/\/t\/(?:\d+\/)?([A-Z]+-\d+)/i);
      resolve(match ? match[1].toUpperCase() : null);
    });
  });
}

async function initTimer() {
  const input    = document.getElementById('timerTicketInput');
  const dropdown = document.getElementById('timerDropdown');
  const starBtn  = document.getElementById('timerStarBtn');

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

  // Restore running timer or auto-detect from tab
  await new Promise(resolve => {
    chrome.storage.local.get([TIMER_KEY], (r) => {
      const t = r[TIMER_KEY];
      if (t && t.running) { if (t.ticketId) input.value = t.ticketId; startTimerUI(); updateTimerDisplay(); }
      resolve();
    });
  });
  if (!input.value) { const detected = await detectTicketFromTab(); if (detected) input.value = detected; }

  // Wire combo — syncStar called on every selection and input change
  wireCombo(input, dropdown, (id) => { dbg('wireCombo onSelect, id:', id); syncStar(); }).then(() => syncStar());

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

  input.addEventListener('input', syncStar);
}

// ── Timer controls ────────────────────────────────────────────────────────────
document.getElementById('timerBtn').addEventListener('click', () => {
  chrome.storage.local.get([TIMER_KEY], (r) => {
    const t = r[TIMER_KEY];
    if (t && t.running) {
      chrome.storage.local.remove([TIMER_KEY]);
      stopTimerUI();
      showTimerConfirm(t.ticketId, getElapsed(t.startTs));
    } else {
      const ticketId = document.getElementById('timerTicketInput').value.trim().toUpperCase();
      const timerData = { running: true, startTs: Date.now(), ticketId: ticketId || null };
      chrome.storage.local.set({ [TIMER_KEY]: timerData });
      startTimerUI();
      chrome.runtime.sendMessage({ type: 'TIMER_START', startTs: timerData.startTs });
    }
  });
});

document.getElementById('timerBillable').addEventListener('change', persistConfirmState);
document.getElementById('timerConfirmTicket').addEventListener('input', persistConfirmState);
document.getElementById('timerDescription').addEventListener('input', persistConfirmState);

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
  const result = await new Promise(resolve => chrome.runtime.sendMessage({
    type: 'IMPORT_TIME_ENTRY', ticketId,
    startTime: new Date(startTime).toISOString(),
    endTime:   new Date(endTime).toISOString(),
    title: description, billable,
    clickupToken: settings.clickupToken, teamId: settings.teamId
  }, resolve));

  if (result && result.success) {
    recordTicketUse(ticketId, result.taskName || null);
    statusEl.style.color = '#a6e3a1'; statusEl.textContent = 'Logged!';
    setTimeout(() => { hideTimerConfirm(); statusEl.textContent = ''; }, 1500);
  } else {
    statusEl.style.color = '#f38ba8';
    statusEl.textContent = 'Failed: ' + ((result && result.error) || 'Unknown error');
  }
});

document.getElementById('timerDiscard').addEventListener('click', hideTimerConfirm);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TIMER_AUTO_STOP') {
    chrome.storage.local.get([TIMER_KEY], (r) => {
      const t = r[TIMER_KEY];
      if (t && t.running) {
        chrome.storage.local.remove([TIMER_KEY]);
        stopTimerUI();
        showTimerConfirm(t.ticketId, getElapsed(t.startTs));
      }
    });
  }
});

// Restore confirm panel if pending, then init timer
chrome.storage.local.get(['adHocTimerConfirm'], (r) => {
  if (r.adHocTimerConfirm) {
    const { ticketId, durationMs, billable, rawMs, description } = r.adHocTimerConfirm;
    renderTimerConfirm(ticketId, durationMs, billable, rawMs || 0, description || '');
  }
});
initTimer();
