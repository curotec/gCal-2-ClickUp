# GCal 2 ClickUp Time Importer

Import Google Calendar events as billable time entries into ClickUp timesheets.

## Setup

### 1. Configure your Google OAuth Client ID

Copy the example config and fill in your real client ID:

```bash
cp config.json.example config.json
```

Edit `config.json`:
```json
{
  "google_client_id": "787917123062-xxxx.apps.googleusercontent.com"
}
```

Your client ID is in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
under **APIs & Services → Credentials**.

> `config.json` is gitignored and will never be committed.
> `manifest.json` only contains a `{{GOOGLE_CLIENT_ID}}` placeholder.

### 2. Build the extension

```bash
node build.js
```

This injects your client ID into `manifest.json` and copies all files to `dist/`.
If you have `archiver` installed (`npm install archiver`), it also produces
`dist/gcal-clickup-importer.zip`.

### 3. Install in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` folder
   — or drag in the zip file if you built one

### 4. Configure the extension

Open ⚙️ Settings inside the extension and fill in:
- **ClickUp API Token** — from ClickUp → Settings → Apps → API Token (starts with `pk_`)
- **ClickUp Team ID** — the number in your ClickUp URL, e.g. `9017610002`

## Usage

1. Click the extension icon
2. Select a date and click **Load Events**
3. Events are cross-checked against existing ClickUp entries:
   - `[existing]` — same ticket already logged for that time, unchecked by default
   - `[conflict]` — different ticket but overlapping time, unchecked by default
4. Star (☆) tickets you use frequently to pin them to the top of the dropdown
5. Adjust billable checkboxes as needed
6. Click **Import Selected**

## Development

To update the extension, edit source files and re-run `node build.js`,
then reload the extension at `chrome://extensions`.

---

## Changelog

### v2.1.7
- Rewrote dropdown item rendering to use createElement and attach mousedown
  handlers directly to each item instead of innerHTML + event delegation

### v2.1.6
- Fixed dropdown click not firing — switched to mousedown+mouseup pair with
  preventDefault to capture selection before blur closes the dropdown

### v2.1.5
- Replaced event-based dropdown selection with polling + click approach to
  reliably detect value changes regardless of blur/mousedown race conditions

### v2.1.4
- Fixed star sync — blur was calling syncStar with empty value before mousedown
  completed; onSelect now only fires on explicit input changes and dropdown selection

### v2.1.3
- Switched dropdown click handler to document-level event delegation to fix
  star sync on first selection

### v2.1.2
- Restored debug logs for dropdown and star sync, gated behind the Debug Mode
  setting in options — enable it to see [GCal→ClickUp] logs in the console

### v2.1.1
- Fixed star not highlighting on dropdown selection — root cause was that
  innerHTML re-renders on each keystroke were destroying the mousedown listener;
  switched to event delegation on the parent container which survives re-renders

### v2.1.0
- Fixed star not highlighting on dropdown selection — root cause was that
  innerHTML re-renders on each keystroke were destroying the mousedown listener;
  switched to event delegation on the parent container which survives re-renders

### v2.0.9
- Fixed star highlight on dropdown selection using preventDefault on mousedown
  to stop the input blur from firing before the value is set

### v2.0.8
- Fixed star not highlighting on first dropdown selection — blur event was firing
  before input.value was set, causing syncStar to read an empty value; onSelect
  now fires synchronously in mousedown before blur can clear the input

### v2.0.7
- Fixed star not highlighting on first dropdown selection — syncStar now reads
  directly from chrome.storage.local instead of the async getFrequentTickets(),
  eliminating the race condition on first open

### v2.0.6
- Fixed timer star not highlighting after selecting a favorite from the dropdown
- Star now correctly turns yellow on dropdown selection, typing, and paste

### v2.0.5
- Timer star icon now reliably highlights yellow when the selected ticket is
  in the favorites list — fixed timing issue where star was checked before
  the dropdown wiring completed, and added sync when selecting from dropdown

### v2.0.4
- Timer confirmation panel now persists across popup close/reopen — ticket ID,
  duration and billable state are saved to storage and restored when you reopen
  the popup, so tracked time is never lost until you explicitly Log or Discard

### v2.0.3
- Favorite ticket ID input is now shorter (12 char width) with maxlength enforced

### v2.0.2
- Add favorite from settings now validates the ticket against ClickUp API:
  - Yellow ✔ and task name shown when ticket exists
  - Red ✖ and error message when ticket not found
  - Add button stays disabled until validation passes
  - Validation triggers automatically 600ms after typing stops, or on blur
  - Task name is fetched from ClickUp and stored automatically (read-only)

### v2.0.1
- Timer star icon now correctly highlights on load when the auto-detected or
  restored ticket ID is already a favorite

### v2.0.0
- Added **Ad-hoc Timer** below the date picker:
  - Auto-detects ticket ID from the active ClickUp tab URL
  - Editable ticket input with favorites + frequent ticket dropdown and star button
  - ▶ Start / ⏹ Stop button with live HH:MM:SS counter
  - Timer persists across popup close/reopen via chrome.storage.local
  - At 1 hour: Chrome notification fires with Continue / Stop buttons
  - No response within 1 minute: timer auto-stops
  - On stop: confirmation panel with editable ticket ID, duration (rounded up
    to nearest 5 min, adjustable in 5 min steps), billable checkbox (default on),
    and Log Time / Discard buttons

### v1.7.1
- Updated extension icon with revised version

### v1.7.0
- Added extension icon (ClickUp + Google Calendar combo) in all required sizes:
  16×16, 32×32, 48×48, 128×128
- Icon appears in the Chrome toolbar, extensions page, and Chrome Web Store listing

### v1.6.0
- Every event now shows an editable ticket ID input, pre-filled when a ticket ID
  is detected from the event title
- Ticket ID badge removed from title display (it now lives solely in the input)
- Star button reads the current input value at click time, so you can favorite
  a ticket after editing it

### v1.5.0
- Favorite tickets can now be fully managed from ⚙️ Settings:
  - **Add** a ticket by ID and optional title directly on the settings page
  - **Edit** a ticket's title inline with a ✓ save button
  - **Remove** any favorite with the ✕ button
- Previously favorites could only be added via the popup star and removed from settings

### v1.4.0
- Ticket ID is now stripped from the event title both in the popup display and
  when sent to ClickUp as the time entry description (e.g. "Fix bug CTK-123"
  becomes "Fix bug")

### v1.3.0
- Added **Favorite Tickets** — star (☆) any ticket with a detected ID to pin it
  to the top of the dropdown; stars turn yellow when active
- Favorites list in ⚙️ Settings shows ticket ID + name with a remove (✕) button
- Dropdown now shows favorites first (up to 3), then frequent tickets, deduped

### v1.2.0
- Ticket ID suggestions dropdown now shows task name alongside ID
  (e.g. `CTK-1640 – Gen Admin`)
- Task names fetched from ClickUp API on first use and cached locally
- Added **Reset ticket history** button in ⚙️ Settings to clear frequency data
  and start fresh

### v1.1.0
- Ticket ID input replaced with a **combo dropdown** showing the 5 most-used
  tickets from the last 30 days (rolling window, auto-pruned)
- Ticket use frequency stored in `chrome.storage.local` and updated on
  every successful import

### v1.0.0 — Initial release
- Import Google Calendar events as ClickUp time entries via the ClickUp REST API
  (no DOM scraping)
- Cross-check calendar events against existing ClickUp entries for the selected day:
  `[existing]` badge for already-logged entries, `[conflict]` badge for time overlaps
- Both badges uncheck the event by default to prevent duplicates
- **Billable** checkbox per event (checked by default)
- ClickUp user timezone detected and displayed below the event list
- **Skip List** in settings — keywords that auto-deselect matching events
- **Debug Mode** toggle in settings — writes detailed logs to the browser console
- OAuth Client ID stored in `config.json` (gitignored) and injected at build time
  via `build.js`, keeping `manifest.json` safe to commit
- ClickUp API Token and Team ID stored in `chrome.storage.local` via ⚙️ Settings
