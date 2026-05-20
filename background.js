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
        sendResponse({ timezone: data.user && data.user.timezone });
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

        const entryRes = await fetch(
          `https://api.clickup.com/api/v2/team/${teamId}/time_entries`,
          {
            method: 'POST',
            headers: { Authorization: clickupToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: title, start, end, duration, tid: taskId, billable: billable !== false })
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
        // Notify all popup windows
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
      // Stop
      clearTimerTimeouts();
      chrome.storage.local.get([TIMER_KEY], (r) => {
        const t = r[TIMER_KEY];
        if (t && t.running) {
          chrome.storage.local.remove([TIMER_KEY]);
          chrome.runtime.sendMessage({ type: 'TIMER_AUTO_STOP' }).catch(() => {});
        }
      });
    }
  }
});

// Pause reminder interval
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
  }
  if (message.type === 'TIMER_PAUSE') {
    clearTimerTimeouts();
    startPauseReminder();
  }
  if (message.type === 'TIMER_RESUME') {
    clearPauseReminder();
    // Reschedule 1-hour warning accounting for already-elapsed time
    const fakeStart = Date.now() - (message.pausedElapsed || 0);
    scheduleTimerWarning(fakeStart);
  }
  if (message.type === 'TIMER_STOP') {
    clearTimerTimeouts();
    clearPauseReminder();
  }
});

// On service worker startup, restore timer state
chrome.storage.local.get([TIMER_KEY], (r) => {
  const t = r[TIMER_KEY];
  if (t && t.running) {
    if (t.paused) {
      startPauseReminder();
    } else {
      scheduleTimerWarning(t.startTs);
    }
  }
});
