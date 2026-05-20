// content.js — runs on ClickUp pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'PING') {
    sendResponse({ ok: true });
  }

  // Extract ticket ID from the DOM — handles inbox and other views
  // where the ticket ID is not present in the URL
  if (message.type === 'GET_TICKET_FROM_DOM') {
    // Primary: task view label button (works on task pages and inbox panels)
    const btn = document.querySelector('[data-test="task-view-task-label__taskid-button"]');
    if (btn) {
      const span = btn.querySelector('[data-test="task-view-task-label__taskid-button"]') || btn;
      const text = span.textContent.trim();
      const match = text.match(/\b([A-Z]+-\d+)\b/);
      if (match) { sendResponse({ ticketId: match[1] }); return; }
    }
    // Fallback: any element containing a ticket ID pattern in the page
    const allText = document.body.innerText;
    const match = allText.match(/\b([A-Z]+-\d+)\b/);
    sendResponse({ ticketId: match ? match[1] : null });
  }
});
