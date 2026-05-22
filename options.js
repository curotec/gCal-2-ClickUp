// options.js

// ── Render favorites list ─────────────────────────────────────────────────────
function renderFavorites() {
  chrome.storage.local.get(['ticketFavorites', 'ticketNames'], (r) => {
    const favs = r.ticketFavorites || [];
    const names = r.ticketNames || {};
    const list = document.getElementById('favoritesList');
    const empty = document.getElementById('favoritesEmpty');
    if (!favs.length) {
      list.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    chrome.storage.local.get(['ticketBillable', 'ticketTag', 'enabledTags'], (br) => {
      const billMap = br.ticketBillable || {};
      const tagMap  = br.ticketTag || {};
      const tags    = br.enabledTags || [];

      list.innerHTML = '';
      favs.forEach(id => {
        const item = document.createElement('div');
        item.className = 'fav-item';
        item.dataset.ticket = id;
        item.innerHTML =
          '<span class="fav-star">\u2605</span>' +
          '<span class="fav-id">' + id + '</span>' +
          (names[id] ? '<span class="fav-name">' + names[id].slice(0, 30) +
            (names[id].length > 30 ? '\u2026' : '') + '</span>' : '') +
          '<label class="fav-billable-label" title="Billable by default">' +
            '<input type="checkbox" class="fav-billable" data-ticket="' + id + '"' +
            (billMap[id] !== false ? ' checked' : '') + ' /> Billable' +
          '</label>' +
          (tags.length ?
            '<select class="fav-tag-select" data-ticket="' + id + '">' +
              '<option value="">No tag</option>' +
              tags.map(t => '<option value="' + t + '"' + (tagMap[id] === t ? ' selected' : '') + '>' + t + '</option>').join('') +
            '</select>' : '') +
          '<button class="fav-remove" data-ticket="' + id + '" title="Remove">\u00d7</button>';

        item.querySelector('.fav-billable').addEventListener('change', (e) => {
          chrome.storage.local.get(['ticketBillable'], (r2) => {
            const map = r2.ticketBillable || {};
            map[id] = e.target.checked;
            chrome.storage.local.set({ ticketBillable: map });
          });
        });

        const tagSel = item.querySelector('.fav-tag-select');
        if (tagSel) {
          tagSel.addEventListener('change', (e) => {
            chrome.storage.local.get(['ticketTag'], (r2) => {
              const map = r2.ticketTag || {};
              if (e.target.value) map[id] = e.target.value;
              else delete map[id];
              chrome.storage.local.set({ ticketTag: map });
            });
          });
        }

        item.querySelector('.fav-remove').addEventListener('click', () => {
          chrome.storage.local.get(['ticketFavorites'], (r2) => {
            const updated = (r2.ticketFavorites || []).filter(fid => fid !== id);
            chrome.storage.local.set({ ticketFavorites: updated }, renderFavorites);
          });
        });

        list.appendChild(item);
      });
    });
  });
}

// ── Add favorite: validate ticket against ClickUp ────────────────────────────
let validatedFavId = null;
let validatedFavName = null;
let validateTimeout = null;

function resetValidation() {
  validatedFavId = null;
  validatedFavName = null;
  document.getElementById('newFavValidIcon').textContent = '';
  document.getElementById('newFavValidIcon').style.color = '';
  document.getElementById('newFavNameRow').classList.add('hidden');
  document.getElementById('newFavNameDisplay').textContent = '';
  document.getElementById('addFavBtn').disabled = true;
  document.getElementById('addFavStatus').textContent = '';
}

async function validateTicket(id) {
  const icon = document.getElementById('newFavValidIcon');
  const nameRow = document.getElementById('newFavNameRow');
  const nameDisplay = document.getElementById('newFavNameDisplay');
  const addBtn = document.getElementById('addFavBtn');

  icon.textContent = '\u23f3'; // hourglass
  icon.style.color = '#a6adc8';
  nameRow.classList.add('hidden');
  addBtn.disabled = true;
  validatedFavId = null;
  validatedFavName = null;

  return new Promise(resolve => {
    chrome.storage.local.get(['clickupToken', 'teamId'], async (r) => {
      if (!r.clickupToken || !r.teamId) {
        icon.textContent = '\u2716';
        icon.style.color = '#f38ba8';
        document.getElementById('addFavStatus').style.color = '#f38ba8';
        document.getElementById('addFavStatus').textContent = 'Set your ClickUp token & team ID in settings first.';
        resolve(false);
        return;
      }
      try {
        const res = await fetch(
          'https://api.clickup.com/api/v2/task/' + encodeURIComponent(id) +
          '?custom_task_ids=true&team_id=' + r.teamId,
          { headers: { Authorization: r.clickupToken } }
        );
        if (!res.ok) throw new Error('not found');
        const data = await res.json();
        if (!data.id) throw new Error('not found');

        validatedFavId = id;
        validatedFavName = data.name || '';
        icon.textContent = '\u2714'; // ✔
        icon.style.color = '#f9e2af'; // yellow
        nameRow.classList.remove('hidden');
        nameDisplay.textContent = validatedFavName;
        addBtn.disabled = false;
        document.getElementById('addFavStatus').textContent = '';
        resolve(true);
      } catch (_) {
        icon.textContent = '\u2716'; // ✖
        icon.style.color = '#f38ba8';
        document.getElementById('addFavStatus').style.color = '#f38ba8';
        document.getElementById('addFavStatus').textContent = 'Ticket not found in ClickUp.';
        resolve(false);
      }
    });
  });
}

// Validate on input with debounce
document.getElementById('newFavId').addEventListener('input', () => {
  resetValidation();
  if (validateTimeout) clearTimeout(validateTimeout);
  const val = document.getElementById('newFavId').value.trim().toUpperCase();
  if (!val) return;
  if (!/^[A-Z]+-\d+$/.test(val)) return;
  validateTimeout = setTimeout(() => validateTicket(val), 600);
});

// Also validate on blur
document.getElementById('newFavId').addEventListener('blur', () => {
  if (validateTimeout) clearTimeout(validateTimeout);
  const val = document.getElementById('newFavId').value.trim().toUpperCase();
  if (val && /^[A-Z]+-\d+$/.test(val) && validatedFavId !== val) {
    validateTicket(val);
  }
});

// Add button
document.getElementById('addFavBtn').addEventListener('click', () => {
  if (!validatedFavId) return;
  const status = document.getElementById('addFavStatus');
  chrome.storage.local.get(['ticketFavorites', 'ticketNames'], (r) => {
    const favs = r.ticketFavorites || [];
    const names = r.ticketNames || {};
    if (favs.includes(validatedFavId)) {
      status.style.color = '#f9e2af';
      status.textContent = 'Already in favorites.';
      setTimeout(() => { status.textContent = ''; }, 3000);
      return;
    }
    favs.push(validatedFavId);
    if (validatedFavName) names[validatedFavId] = validatedFavName;
    chrome.storage.local.set({ ticketFavorites: favs, ticketNames: names }, () => {
      document.getElementById('newFavId').value = '';
      resetValidation();
      status.style.color = '#a6e3a1';
      status.textContent = 'Added!';
      setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 2000);
      renderFavorites();
  loadTagManager(false);
  renderEventRules();
    });
  });
});

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderFavorites();
  loadTagManager(false);
  renderEventRules();

  chrome.storage.local.get(['clickupToken', 'teamId', 'debugMode'], (r) => {
    if (r.clickupToken) document.getElementById('clickupToken').value = r.clickupToken;
    if (r.teamId) document.getElementById('teamId').value = r.teamId;
    document.getElementById('debugMode').checked = !!r.debugMode;
  });

  chrome.storage.sync.get(['skipList'], (r) => {
    document.getElementById('skipList').value = r.skipList || 'Lunch\nBreak\nOOO\nOut of office\nPTO';
  });
});

// Save ClickUp API token
document.getElementById('saveClickupBtn').addEventListener('click', () => {
  const val = document.getElementById('clickupToken').value.trim();
  const s = document.getElementById('saveClickupStatus');
  if (!val) {
    s.style.color = '#f38ba8'; s.textContent = 'Token cannot be empty.';
    setTimeout(() => { s.textContent = ''; s.style.color = ''; }, 3000);
    return;
  }
  if (!val.startsWith('pk_')) {
    s.style.color = '#f38ba8'; s.textContent = 'Token should start with pk_';
    setTimeout(() => { s.textContent = ''; s.style.color = ''; }, 3000);
    return;
  }
  chrome.storage.local.set({ clickupToken: val }, () => {
    s.style.color = ''; s.textContent = 'Saved!';
    setTimeout(() => s.textContent = '', 2000);
  });
});

// Save Team ID
document.getElementById('saveTeamBtn').addEventListener('click', () => {
  const val = document.getElementById('teamId').value.trim();
  const s = document.getElementById('saveTeamStatus');
  if (!val || isNaN(val)) {
    s.style.color = '#f38ba8'; s.textContent = 'Team ID must be a number.';
    setTimeout(() => { s.textContent = ''; s.style.color = ''; }, 3000);
    return;
  }
  chrome.storage.local.set({ teamId: val }, () => {
    s.style.color = ''; s.textContent = 'Saved!';
    setTimeout(() => s.textContent = '', 2000);
  });
});

// Save Skip List
document.getElementById('saveSkipBtn').addEventListener('click', () => {
  const val = document.getElementById('skipList').value;
  chrome.storage.sync.set({ skipList: val }, () => {
    const s = document.getElementById('saveSkipStatus');
    s.textContent = 'Saved!';
    setTimeout(() => s.textContent = '', 2000);
  });
});

// Debug mode toggle
document.getElementById('debugMode').addEventListener('change', (e) => {
  chrome.storage.local.set({ debugMode: e.target.checked }, () => {
    const s = document.getElementById('debugStatus');
    s.textContent = e.target.checked ? 'Debug on' : 'Debug off';
    setTimeout(() => s.textContent = '', 2000);
  });
});

// ── Event Rules ──────────────────────────────────────────────────────────────
function renderEventRules() {
  chrome.storage.local.get(['eventRules', 'enabledTags', 'ticketNames'], (r) => {
    const rules  = r.eventRules || [];
    const tags   = r.enabledTags || [];
    const names  = r.ticketNames || {};
    const list   = document.getElementById('eventRulesList');
    const empty  = document.getElementById('eventRulesEmpty');
    if (!rules.length) { list.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    list.innerHTML = '';

    rules.forEach((rule, idx) => {
      const row = document.createElement('div');
      row.className = 'rule-item';
      row.innerHTML =
        '<div class="rule-main">' +
          '<span class="rule-title" title="' + rule.title + '">' + rule.title.slice(0, 30) + (rule.title.length > 30 ? '…' : '') + '</span>' +
          (rule.time ? '<span class="rule-time">' + rule.time + '</span>' : '') +
        '</div>' +
        '<div class="rule-controls">' +
          '<input type="text" class="rule-ticket" data-idx="' + idx + '" value="' + (rule.ticketId || '') + '" placeholder="CTK-1234" />' +
          '<span class="rule-valid-icon" data-idx="' + idx + '"></span>' +
          '<label class="fav-billable-label">' +
            '<input type="checkbox" class="rule-billable" data-idx="' + idx + '"' + (rule.billable !== false ? ' checked' : '') + ' /> Billable' +
          '</label>' +
          (tags.length ?
            '<select class="rule-tag" data-idx="' + idx + '">' +
              '<option value="">No tag</option>' +
              tags.map(t => '<option value="' + t + '"' + (rule.tag === t ? ' selected' : '') + '>' + t + '</option>').join('') +
            '</select>' : '') +
          '<button class="rule-remove" data-idx="' + idx + '" title="Remove">×</button>' +
        '</div>';

      // Validate ticket on blur
      const ticketInput = row.querySelector('.rule-ticket');
      const validIcon   = row.querySelector('.rule-valid-icon');
      let debounce = null;

      function validateRuleTicket(id) {
        if (!id) { validIcon.textContent = ''; return; }
        validIcon.textContent = '⏳'; validIcon.style.color = '#a6adc8';
        chrome.storage.local.get(['clickupToken', 'teamId'], async (r2) => {
          if (!r2.clickupToken || !r2.teamId) return;
          try {
            const res = await fetch(
              'https://api.clickup.com/api/v2/task/' + encodeURIComponent(id) + '?custom_task_ids=true&team_id=' + r2.teamId,
              { headers: { Authorization: r2.clickupToken } }
            );
            if (res.ok) {
              const data = await res.json();
              validIcon.textContent = '✔'; validIcon.style.color = '#f9e2af';
              validIcon.title = data.name || '';
              saveRuleField(idx, 'ticketId', id);
              if (data.name) {
                const nm = r2.ticketNames || {};
                nm[id] = data.name;
                chrome.storage.local.set({ ticketNames: nm });
              }
            } else { validIcon.textContent = '✖'; validIcon.style.color = '#f38ba8'; }
          } catch (_) { validIcon.textContent = '✖'; validIcon.style.color = '#f38ba8'; }
        });
      }

      ticketInput.addEventListener('input', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => validateRuleTicket(ticketInput.value.trim().toUpperCase()), 600);
      });
      if (rule.ticketId) validateRuleTicket(rule.ticketId);

      row.querySelector('.rule-billable').addEventListener('change', (e) => saveRuleField(idx, 'billable', e.target.checked));
      const tagSel = row.querySelector('.rule-tag');
      if (tagSel) tagSel.addEventListener('change', (e) => saveRuleField(idx, 'tag', e.target.value));
      row.querySelector('.rule-remove').addEventListener('click', () => {
        chrome.storage.local.get(['eventRules'], (r2) => {
          const updated = (r2.eventRules || []).filter((_, i) => i !== idx);
          chrome.storage.local.set({ eventRules: updated }, renderEventRules);
        });
      });

      list.appendChild(row);
    });
  });
}

function saveRuleField(idx, field, value) {
  chrome.storage.local.get(['eventRules'], (r) => {
    const rules = r.eventRules || [];
    if (rules[idx]) { rules[idx][field] = value; chrome.storage.local.set({ eventRules: rules }); }
  });
}

// Load upcoming events from Google Calendar
document.getElementById('loadUpcomingBtn').addEventListener('click', () => {
  const status = document.getElementById('upcomingStatus');
  const wrap   = document.getElementById('upcomingSuggestions');
  status.style.color = '#a6adc8'; status.textContent = 'Loading...';
  wrap.classList.add('hidden'); wrap.innerHTML = '';

  chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, async (resp) => {
    if (chrome.runtime.lastError) {
      status.style.color = '#f38ba8';
      status.textContent = 'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    if (!resp || resp.error) {
      status.style.color = '#f38ba8';
      status.textContent = 'Auth error: ' + (resp && resp.error ? resp.error : 'No response');
      return;
    }
    const token = resp.token;
    const now   = new Date();
    const end   = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const url   = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', now.toISOString());
    url.searchParams.set('timeMax', end.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '100');
    try {
      const res  = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      const events = (data.items || []).filter(e => e.start && e.start.dateTime);

      // Deduplicate by title+time
      const seen = new Set();
      const unique = [];
      events.forEach(e => {
        const t = new Date(e.start.dateTime);
        const key = e.summary + '|' + t.getHours() + ':' + String(t.getMinutes()).padStart(2,'0');
        if (!seen.has(key)) { seen.add(key); unique.push({ title: e.summary, time: t.getHours() + ':' + String(t.getMinutes()).padStart(2,'0') }); }
      });

      if (!unique.length) { status.textContent = 'No upcoming events found.'; return; }
      status.textContent = '';
      wrap.classList.remove('hidden');
      wrap.innerHTML = '<p class="hint" style="margin-bottom:8px;">Click an event to create a rule:</p>';
      unique.forEach(ev => {
        const btn = document.createElement('button');
        btn.className = 'upcoming-event-btn';
        btn.textContent = ev.title + (ev.time ? ' · ' + ev.time : '');
        btn.addEventListener('click', () => {
          chrome.storage.local.get(['eventRules'], (r) => {
            const rules = r.eventRules || [];
            // Don't add duplicate
            if (rules.some(rule => rule.title === ev.title && rule.time === ev.time)) {
              status.style.color = '#f9e2af'; status.textContent = 'Rule already exists for this event.';
              setTimeout(() => { status.textContent = ''; }, 3000); return;
            }
            rules.push({ title: ev.title, time: ev.time, ticketId: '', billable: true, tag: '' });
            chrome.storage.local.set({ eventRules: rules }, () => {
              renderEventRules();
              status.style.color = '#a6e3a1'; status.textContent = 'Rule added!';
              setTimeout(() => { status.textContent = ''; }, 2000);
            });
          });
        });
        wrap.appendChild(btn);
      });
    } catch (err) { status.style.color = '#f38ba8'; status.textContent = 'Error: ' + err.message; }
  });
});

// Add rule manually
document.getElementById('addRuleBtn').addEventListener('click', () => {
  const title = document.getElementById('newRuleTitle').value.trim();
  const time  = document.getElementById('newRuleTime').value.trim();
  if (!title) {
    document.getElementById('upcomingStatus').style.color = '#f38ba8';
    document.getElementById('upcomingStatus').textContent = 'Title is required.';
    setTimeout(() => { document.getElementById('upcomingStatus').textContent = ''; }, 3000); return;
  }
  chrome.storage.local.get(['eventRules'], (r) => {
    const rules = r.eventRules || [];
    rules.push({ title, time: time || '', ticketId: '', billable: true, tag: '' });
    chrome.storage.local.set({ eventRules: rules }, () => {
      document.getElementById('newRuleTitle').value = '';
      document.getElementById('newRuleTime').value = '';
      renderEventRules();
    });
  });
});

// ── Tag Manager ──────────────────────────────────────────────────────────────
let _dragSrc = null;

function saveEnabledTags() {
  const enabled = [...document.querySelectorAll('.tag-check-item')]
    .filter(el => el.querySelector('.tag-check').checked)
    .map(el => el.querySelector('.tag-check').dataset.tag);
  chrome.storage.local.set({ enabledTags: enabled }, () => {
    const s = document.getElementById('tagManagerStatus');
    s.style.color = '#a6e3a1';
    s.textContent = 'Saved!';
    setTimeout(() => { s.textContent = ''; }, 2000);
  });
}

function saveTagOrder() {
  // Save full ordered list (checked and unchecked) then re-derive enabledTags
  const allOrdered = [...document.querySelectorAll('.tag-check-item')]
    .map(el => el.querySelector('.tag-check').dataset.tag);
  const enabled = [...document.querySelectorAll('.tag-check-item')]
    .filter(el => el.querySelector('.tag-check').checked)
    .map(el => el.querySelector('.tag-check').dataset.tag);
  chrome.storage.local.set({ cachedTagsOrdered: allOrdered, enabledTags: enabled });
}

function renderTagChecklist(allTags, enabledTags) {
  const list = document.getElementById('tagChecklist');
  if (!allTags.length) {
    list.innerHTML = '<p class="hint">No tags found. Click Refresh to load from ClickUp.</p>';
    return;
  }

  // Apply saved order if available
  chrome.storage.local.get(['cachedTagsOrdered'], (r) => {
    const ordered = r.cachedTagsOrdered || [];
    const sortedTags = [
      ...ordered.filter(t => allTags.includes(t)),
      ...allTags.filter(t => !ordered.includes(t))
    ];

    list.innerHTML = '';
    sortedTags.forEach(tag => {
      const item = document.createElement('div');
      item.className = 'tag-check-item';
      item.draggable = true;
      item.dataset.tag = tag;
      item.innerHTML =
        '<span class="drag-handle" title="Drag to reorder">&#8942;&#8942;</span>' +
        '<input type="checkbox" class="tag-check" data-tag="' + tag + '"' +
        (enabledTags.includes(tag) ? ' checked' : '') + ' />' +
        '<span class="tag-label">' + tag + '</span>';

      // Drag events
      item.addEventListener('dragstart', (e) => {
        _dragSrc = item;
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        document.querySelectorAll('.tag-check-item').forEach(el => el.classList.remove('drag-over'));
        saveTagOrder();
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (_dragSrc && _dragSrc !== item) {
          document.querySelectorAll('.tag-check-item').forEach(el => el.classList.remove('drag-over'));
          item.classList.add('drag-over');
        }
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        if (_dragSrc && _dragSrc !== item) {
          const items = [...list.querySelectorAll('.tag-check-item')];
          const srcIdx = items.indexOf(_dragSrc);
          const dstIdx = items.indexOf(item);
          if (srcIdx < dstIdx) list.insertBefore(_dragSrc, item.nextSibling);
          else list.insertBefore(_dragSrc, item);
        }
      });

      item.querySelector('.tag-check').addEventListener('change', saveEnabledTags);
      list.appendChild(item);
    });
  });
}

async function loadTagManager(forceRefresh) {
  const s = document.getElementById('tagManagerStatus');
  chrome.storage.local.get(['cachedTags', 'cachedTagsTs', 'enabledTags', 'clickupToken', 'teamId'], async (r) => {
    const enabledTags = r.enabledTags || [];
    const isStale = !r.cachedTagsTs || (Date.now() - r.cachedTagsTs) > 600000;

    if (!forceRefresh && r.cachedTags && !isStale) {
      renderTagChecklist(r.cachedTags, enabledTags);
      return;
    }

    if (!r.clickupToken || !r.teamId) {
      document.getElementById('tagChecklist').innerHTML =
        '<p class="hint">Set your ClickUp token and team ID first.</p>';
      return;
    }

    s.style.color = '#a6adc8';
    s.textContent = 'Loading...';
    try {
      const res = await fetch(
        'https://api.clickup.com/api/v2/team/' + r.teamId + '/time_entries/tags',
        { headers: { Authorization: r.clickupToken } }
      );
      if (!res.ok) throw new Error('API error ' + res.status);
      const data = await res.json();
      const tags = (data.data || []).map(t => t.name).filter(Boolean).sort();
      chrome.storage.local.set({ cachedTags: tags, cachedTagsTs: Date.now() });
      // Default: all tags enabled if first load
      const finalEnabled = r.enabledTags !== undefined ? r.enabledTags : tags;
      if (r.enabledTags === undefined) chrome.storage.local.set({ enabledTags: finalEnabled });
      s.textContent = '';
      renderTagChecklist(tags, finalEnabled);
    } catch (err) {
      s.style.color = '#f38ba8';
      s.textContent = 'Error: ' + err.message;
    }
  });
}

document.getElementById('refreshTagsBtn').addEventListener('click', () => loadTagManager(true));

document.getElementById('selectAllTagsBtn').addEventListener('click', () => {
  document.querySelectorAll('.tag-check').forEach(cb => { cb.checked = true; });
  saveEnabledTags();
});

document.getElementById('selectNoneTagsBtn').addEventListener('click', () => {
  document.querySelectorAll('.tag-check').forEach(cb => { cb.checked = false; });
  saveEnabledTags();
});

// Reset ticket history
document.getElementById('resetTicketsBtn').addEventListener('click', () => {
  chrome.storage.local.remove(['ticketFrequency', 'ticketNames'], () => {
    const s = document.getElementById('resetTicketsStatus');
    s.style.color = '#a6e3a1';
    s.textContent = 'Reset! Suggestions will rebuild from your next imports.';
    setTimeout(() => { s.textContent = ''; }, 4000);
  });
});

// Sign out of Google
document.getElementById('signOutBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'REVOKE_TOKEN' }, () => {
    alert('Signed out. You will be prompted to sign in again next time.');
  });
});
