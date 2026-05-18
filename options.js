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
    chrome.storage.local.get(['ticketBillable'], (br) => {
      const billMap = br.ticketBillable || {};
      list.innerHTML = favs.map(id =>
        '<div class="fav-item" data-ticket="' + id + '">' +
          '<span class="fav-star">\u2605</span>' +
          '<span class="fav-id">' + id + '</span>' +
          (names[id] ? '<span class="fav-name">' + names[id].slice(0, 40) +
            (names[id].length > 40 ? '\u2026' : '') + '</span>' : '') +
          '<label class="fav-billable-label" title="Billable by default">' +
            '<input type="checkbox" class="fav-billable" data-ticket="' + id + '"' +
            (billMap[id] !== false ? ' checked' : '') + ' />' +
            ' Billable' +
          '</label>' +
          '<button class="fav-remove" data-ticket="' + id + '" title="Remove">\u00d7</button>' +
        '</div>'
      ).join('');

      list.querySelectorAll('.fav-billable').forEach(cb => {
        cb.addEventListener('change', () => {
          chrome.storage.local.get(['ticketBillable'], (r2) => {
            const map = r2.ticketBillable || {};
            map[cb.dataset.ticket] = cb.checked;
            chrome.storage.local.set({ ticketBillable: map });
          });
        });
      });

      list.querySelectorAll('.fav-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          chrome.storage.local.get(['ticketFavorites'], (r2) => {
            const updated = (r2.ticketFavorites || []).filter(id => id !== btn.dataset.ticket);
            chrome.storage.local.set({ ticketFavorites: updated }, renderFavorites);
          });
        });
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
    });
  });
});

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderFavorites();

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
