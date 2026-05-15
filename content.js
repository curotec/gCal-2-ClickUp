// content.js — minimal, only needed to confirm the script is alive
// All time entry logic is now handled via the ClickUp API in background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ ok: true });
  }
});
