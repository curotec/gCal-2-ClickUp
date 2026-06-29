// background.js

// ── Google OAuth ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'GET_AUTH_TOKEN') {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ token });
      }
    });
    return true;
  }

  if (message.type === 'GET_CLICKUP_USER') {
    const { clickupToken } = message;
    (async () => {
      try {
        const res = await fetch('https://api.clickup.com/api/v2/user', {
          headers: { Authorization: clickupToken }
        });
        if (!res.ok) throw new Error(`ClickUp user API error: ${res.status}`);
        const data = await res.json();
        sendResponse({
          timezone: data.user && data.user.timezone,
          userId:   data.user && data.user.id
        });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'REVOKE_TOKEN') {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
          .then(() => chrome.identity.removeCachedAuthToken({ token }))
          .then(() => sendResponse({ ok: true }));
      } else {
        sendResponse({ ok: true });
      }
    });
    return true;
  }

  // ── Fetch existing ClickUp time entries for a given day ────────────────────
  if (message.type === 'GET_CLICKUP_ENTRIES') {
    const { clickupToken, teamId, date } = message;
    (async () => {
      try {
        // Use UTC midnight boundaries to avoid timezone-shifted windows
        // ClickUp timestamps are in UTC ms, so we query the full UTC day
        // but also extend ±12h to catch entries logged in any timezone
        const dayStart = new Date(date + 'T00:00:00Z').getTime() - (12 * 60 * 60 * 1000);
        const dayEnd   = new Date(date + 'T23:59:59Z').getTime() + (12 * 60 * 60 * 1000);
        const url = `https://api.clickup.com/api/v2/team/${teamId}/time_entries?start_date=${dayStart}&end_date=${dayEnd}&include_task_tags=true&include_location_names=true`;
        const res = await fetch(url, { headers: { Authorization: clickupToken } });
        if (!res.ok) throw new Error(`ClickUp API error: ${res.status}`);
        const data = await res.json();

        if (data.data && data.data.length > 0) {
        } else {
        }
        sendResponse({ entries: data.data || [] });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── ClickUp API: look up task by custom ID, then log time ──────────────────
  if (message.type === 'IMPORT_TIME_ENTRY') {
    const { ticketId, startTime, endTime, title, clickupToken, teamId, billable } = message;
    (async () => {
      try {
        // Step 1: resolve custom task ID to internal task ID
        const taskRes = await fetch(
          `https://api.clickup.com/api/v2/task/${encodeURIComponent(ticketId)}?custom_task_ids=true&team_id=${teamId}`,
          { headers: { Authorization: clickupToken } }
        );
        if (!taskRes.ok) {
          const err = await taskRes.json().catch(() => ({}));
          throw new Error(`Task lookup failed (${taskRes.status}): ${err.err || err.error || taskRes.statusText}`);
        }
        const task = await taskRes.json();
        const taskId = task.id;

        // Step 2: create time entry
        const start    = new Date(startTime).getTime();
        const end      = new Date(endTime).getTime();
        const duration = end - start;

        const entryBody = { description: title, start, end, duration, tid: taskId, billable: billable !== false };
        if (message.tag) entryBody.tags = [{ name: message.tag }];
        const entryRes = await fetch(
          `https://api.clickup.com/api/v2/team/${teamId}/time_entries`,
          {
            method: 'POST',
            headers: { Authorization: clickupToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(entryBody)
          }
        );
        if (!entryRes.ok) {
          const err = await entryRes.json().catch(() => ({}));
          throw new Error(`Time entry failed (${entryRes.status}): ${err.err || err.error || entryRes.statusText}`);
        }
        sendResponse({ success: true, taskName: task.name || null });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // ── Resolve task names for a set of (custom) IDs ────────────────────────────
  if (message.type === 'GET_TASK_NAMES') {
    const { clickupToken, teamId, ids } = message;
    (async () => {
      try {
        const names = {};
        await Promise.all((ids || []).map(async (id) => {
          try {
            const res = await fetch(
              `https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}?custom_task_ids=true&team_id=${teamId}`,
              { headers: { Authorization: clickupToken } }
            );
            if (res.ok) { const d = await res.json(); if (d.name) names[id] = d.name; }
          } catch (_) {}
        }));
        sendResponse({ names });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── Live search: tasks assigned to current user, title contains query ───────
  if (message.type === 'SEARCH_CLICKUP_TASKS') {
    const { clickupToken, teamId, userId, query } = message;
    (async () => {
      try {
        const q = (query || '').trim().toLowerCase();
        if (!q || !userId) { sendResponse({ tasks: [] }); return; }

        // Fetch tasks assigned to user. ClickUp paginates at 100/page; one page
        // is plenty since we filter & cap to 5 results client-side.
        const url = `https://api.clickup.com/api/v2/team/${teamId}/task` +
                    `?assignees[]=${encodeURIComponent(userId)}` +
                    `&include_closed=false&subtasks=true&page=0`;
        const res = await fetch(url, { headers: { Authorization: clickupToken } });
        if (!res.ok) throw new Error(`Task search failed: ${res.status}`);
        const data = await res.json();

        // Split query into words; ALL must appear in the task name
        // e.g. "LCI PO" matches "LCI | M2 PO/Packing List Issue..."
        const words = q.split(/\s+/).filter(Boolean);
        const matches = (data.tasks || [])
          .filter(t => {
            if (!t.name) return false;
            const name = t.name.toLowerCase();
            return words.every(w => name.includes(w));
          })
          .slice(0, 10)
          .map(t => ({
            id:   t.custom_id || t.id,
            name: t.name
          }));

        sendResponse({ tasks: matches });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

});

// ── Ad-hoc Timer: 1-hour warning + auto-stop ──────────────────────────────────
const TIMER_KEY = 'adHocTimer';
let warningTimeout = null;
let autoStopTimeout = null;

function clearTimerTimeouts() {
  if (warningTimeout) { clearTimeout(warningTimeout); warningTimeout = null; }
  if (autoStopTimeout) { clearTimeout(autoStopTimeout); autoStopTimeout = null; }
}

function scheduleTimerWarning(startTs) {
  clearTimerTimeouts();
  const elapsed = Date.now() - startTs;
  const oneHour = 60 * 60 * 1000;
  const oneMin = 60 * 1000;
  const timeToWarning = Math.max(0, oneHour - elapsed);
  const timeToAutoStop = Math.max(0, oneHour + oneMin - elapsed);

  warningTimeout = setTimeout(() => {
    chrome.notifications.create('timerWarning', {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'GCal → ClickUp Timer',
      message: 'Timer has been running for 1 hour — still tracking?',
      buttons: [{ title: 'Continue' }, { title: 'Stop' }],
      requireInteraction: true
    });
  }, timeToWarning);

  autoStopTimeout = setTimeout(() => {
    chrome.storage.local.get([TIMER_KEY], (r) => {
      const t = r[TIMER_KEY];
      if (t && t.running) {
        chrome.storage.local.remove([TIMER_KEY]);
        chrome.notifications.clear('timerWarning');
        stopBadge();
        chrome.runtime.sendMessage({ type: 'TIMER_AUTO_STOP' }).catch(() => {});
        chrome.notifications.create('timerStopped', {
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'GCal → ClickUp Timer',
          message: 'Timer auto-stopped after 1 hour. Open the extension to log your time.'
        });
      }
    });
  }, timeToAutoStop);
}

// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (notifId === 'timerWarning') {
    chrome.notifications.clear('timerWarning');
    if (btnIdx === 0) {
      // Continue — reschedule warning for next hour
      chrome.storage.local.get([TIMER_KEY], (r) => {
        if (r[TIMER_KEY] && r[TIMER_KEY].running) {
          clearTimerTimeouts();
          scheduleTimerWarning(r[TIMER_KEY].startTs - 60 * 60 * 1000); // next hour from now
        }
      });
    } else {
      // Stop — save confirm state before removing timer
      clearTimerTimeouts();
      chrome.storage.local.get([TIMER_KEY], (r) => {
        const t = r[TIMER_KEY];
        if (t && t.running) {
          const elapsed = t.paused
            ? (t.pausedElapsed || 0)
            : (t.pausedElapsed || 0) + (Date.now() - t.startTs);
          const rounded = Math.ceil(Math.ceil(elapsed / 60000) / 5) * 5 * 60000;
          chrome.storage.local.set({ adHocTimerConfirm: {
            ticketId: t.ticketId || '',
            durationMs: rounded,
            billable: true,
            rawMs: elapsed,
            description: ''
          }});
          chrome.storage.local.remove([TIMER_KEY]);
          stopBadge();
          chrome.runtime.sendMessage({ type: 'TIMER_AUTO_STOP' }).catch(() => {});
        }
      });
    }
  }
});

// ── Badge display ────────────────────────────────────────────────────────────
let badgeInterval = null;

function updateBadge() {
  chrome.storage.local.get([TIMER_KEY], (r) => {
    const t = r[TIMER_KEY];
    if (!t || !t.running) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    const elapsed = t.paused
      ? (t.pausedElapsed || 0)
      : (t.pausedElapsed || 0) + (Date.now() - t.startTs);
    const mins = Math.floor(elapsed / 60000);
    const label = mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h';
    chrome.action.setBadgeText({ text: label });
    chrome.action.setBadgeBackgroundColor({
      color: t.paused ? '#f9761a' : '#27873f'
    });
  });
}

function startBadge() {
  updateBadge();
  if (badgeInterval) clearInterval(badgeInterval);
  badgeInterval = setInterval(updateBadge, 30000); // update every 30s
}

function stopBadge() {
  if (badgeInterval) { clearInterval(badgeInterval); badgeInterval = null; }
  chrome.action.setBadgeText({ text: '' });
}

// ── Pause reminder interval
let pauseReminderInterval = null;

function clearPauseReminder() {
  if (pauseReminderInterval) { clearInterval(pauseReminderInterval); pauseReminderInterval = null; }
}

function startPauseReminder() {
  clearPauseReminder();
  pauseReminderInterval = setInterval(() => {
    chrome.storage.local.get([TIMER_KEY], (r) => {
      if (r[TIMER_KEY] && r[TIMER_KEY].paused) {
        chrome.notifications.create('timerPaused', {
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'GCal → ClickUp Timer',
          message: 'Your timer is still paused — don’t forget to resume or stop!'
        });
      } else {
        clearPauseReminder();
      }
    });
  }, 5 * 60 * 1000);
}

// Listen for timer messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TIMER_START') {
    clearPauseReminder();
    scheduleTimerWarning(message.startTs);
    startBadge();
  }
  if (message.type === 'TIMER_PAUSE') {
    clearTimerTimeouts();
    startPauseReminder();
    updateBadge(); // turn badge orange immediately
  }
  if (message.type === 'TIMER_RESUME') {
    clearPauseReminder();
    const fakeStart = Date.now() - (message.pausedElapsed || 0);
    scheduleTimerWarning(fakeStart);
    startBadge(); // turn badge green
  }
  if (message.type === 'TIMER_STOP') {
    clearTimerTimeouts();
    clearPauseReminder();
    stopBadge();
  }
});

// On service worker startup, restore timer state and badge
chrome.storage.local.get([TIMER_KEY], (r) => {
  const t = r[TIMER_KEY];
  if (t && t.running) {
    if (t.paused) {
      startPauseReminder();
    } else {
      scheduleTimerWarning(t.startTs);
    }
    startBadge();
  }

});
