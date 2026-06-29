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

Your client ID is in the **Curotec Google Cloud Console**:
[APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=curotec-1738158656515&rapt=AEjHL4Mb8NlWLLJBG9qv-qY4XJqZloIRwwFONHs-8TDcn6tr0Fw7PbN3T63juFSr0n08IA0nTO5-t1mXRMKZWfK10hndslphdWc__DTvJuOAxFrKraUHTJg)

Under **OAuth 2.0 Client IDs**, find the entry for this extension and copy the Client ID.
It will look like `787917123062-xxxx.apps.googleusercontent.com`.

#### Setting up the OAuth Client ID for the first time

When creating or editing the OAuth client, you need to add the extension's Chrome ID
under **Authorized JavaScript origins** and **Authorized redirect URIs**.

Use `bdkpjnahpplacaegbglhoilpcpamnkcg` as the extension ID for the **initial load**.
This is the extension ID used during development. After loading the extension in Chrome
for the first time, check `chrome://extensions` for its actual assigned ID and update
the OAuth client with that value if it differs.

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

### Google Calendar (default)

1. Click the extension icon
2. Select a date and click **Load Events**
3. Events are cross-checked against existing ClickUp entries:
   - `[existing]` — same ticket already logged for that time, unchecked by default
   - `[conflict]` — different ticket but overlapping time, unchecked by default
4. Star (☆) tickets you use frequently to pin them to the top of the dropdown
5. Adjust billable checkboxes as needed
6. Click **Import Selected**

### CSV Upload

Click the **📄 CSV** button next to "Load Events" and select a `.csv` file.

**CSV format:**

```csv
title,start,end,tag
Standup,2026-06-24T09:00:00-03:00,2026-06-24T09:15:00-03:00,CTK-1234
Feature work,2026-06-24T10:00:00,2026-06-24T12:00:00,CTK-5678
```

| Column | Required | Notes |
|---|---|---|
| `title` | Yes | Event title |
| `start` | Yes | ISO 8601 datetime. Explicit TZ offset honored; no offset = local time |
| `end` | Yes | ISO 8601 datetime. Must be after `start` |
| `tag` | No | Ticket ID (e.g. `CTK-1234`). Appended to title for ticket detection |

- **Header row** is optional. Auto-detected (case-insensitive) when the first row contains `title`, `start`, `end`; otherwise columns are parsed positionally (title, start, end, tag).
- **Date picker** is auto-set to the date of the first CSV row.
- **CSV replaces** any previously loaded calendar events.
- **Validation** blocks the entire import if any row is malformed — the error identifies the row number and what's wrong.
- **Render pipeline** is identical to calendar events: skip list, ClickUp duplicate detection, ticket combos, billable toggles, click-to-edit titles.

### Push a single event from Google Calendar

You can push one event straight from the Google Calendar web UI without opening
the extension popup.

1. In `calendar.google.com`, click an event to open its detail popover
2. A **→ ClickUp** button appears to the left of the **Edit event** button
3. The button is **state-aware**, reflecting existing ClickUp entries for that timeframe:
   - **→ ClickUp** (blue) — nothing logged yet; clicking pushes immediately
   - **✓ Logged** (green) — the same ticket is already logged for that time
   - **⚠ Conflict** (red) — a *different* ticket overlaps that time
   In the green/red states, clicking asks for confirmation before pushing anyway.
4. A ticket-ID field is always shown. If a ticket ID is detected in the event
   title it's **prefilled** so you can confirm it's correct; otherwise the field
   is empty. Either way it offers **live ClickUp search** (same as the popup: type
   4+ characters to search your assigned tasks, or pick from your frequent/favorite
   tickets). Then click the ClickUp button to push.

Pushed entries are marked billable by default and are recorded in your frequent-ticket
history, just like popup imports.

> **Note:** Google Calendar's page markup is not a stable, documented API. If a
> Google UI update ever hides the button or misreads an event's time, it can be
> re-tuned in one place — see the `SELECTORS` block and `scrape*` helpers at the
> top of `gcal-content.js`.

## File reference

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3). Contains `{{GOOGLE_CLIENT_ID}}` placeholder; permissions; registers the popup, options page, and both content scripts |
| `background.js` | Service worker. Handles Google OAuth and all ClickUp API calls (user lookup, fetch entries, task search, import time entry) plus the ad-hoc timer |
| `popup.html` / `popup.js` / `popup.css` | The toolbar popup: date picker, event list, CSV upload, ticket combos, billable toggles, import |
| `options.html` / `options.js` / `options.css` | Settings page: ClickUp token, Team ID, skip list, debug mode, ticket-history reset, Google sign-out |
| `content.js` | Minimal content script on ClickUp pages (liveness ping) |
| `gcal-content.js` | Content script on `calendar.google.com`: injects the state-aware **→ ClickUp** push button into the event popover |
| `gcal-content.css` | Styling for the injected button + inline ticket combo, matched to Google's native light popover |
| `build.js` | Injects the client ID from `config.json` into the manifest, copies all files to `dist/`, optionally zips |
| `config.json.example` | Placeholder config shape (safe to commit) |
| `.gitignore` | Ignores `config.json` and `dist/` |
| `icons/` | Extension icons (16/32/48/128px) |

## Development

To update the extension, edit source files and re-run `node build.js`,
then reload the extension at `chrome://extensions`.

---

## Changelog

### v2.12.2
- GCal popover now always shows the ticket-ID field, even when a ticket is
  detected from the title — it's prefilled with the detected ID so you can
  verify it's the right ticket (and edit it via live search if not)

### v2.12.1
- GCal push button now shows the ClickUp icon instead of the "→ ClickUp" text
  label; the Logged/Conflict states are indicated by a small colored ✓/⚠ glyph
  beside the icon
  - Icon is inlined as a base64 data URL, so the content script needs no
    `web_accessible_resources` entry
- Narrowed the inline ticket-ID field in the GCal popover (160px → 70px)

### v2.12.0
- **Push from Google Calendar:** added a state-aware **→ ClickUp** button to the
  event detail popover on `calendar.google.com`, left of **Edit event**
  - States reflect existing ClickUp entries for that timeframe: **→ ClickUp** (clean),
    **✓ Logged** (same ticket already logged), **⚠ Conflict** (different ticket overlaps)
  - In the Logged/Conflict states, pushing asks for confirmation first
  - If the event title has no ticket ID, an inline field offers full live ClickUp
    search (same behavior as the popup)
  - Reuses existing background handlers (`IMPORT_TIME_ENTRY`, `GET_CLICKUP_ENTRIES`,
    `SEARCH_CLICKUP_TASKS`); button is styled to match Google's native light popover
  - New files: `gcal-content.js`, `gcal-content.css`; new `calendar.google.com`
    host permission + content-script registration
- Event list (`#events`) max-height raised 320px → 386px to use the taller popup
- Added a **File reference** table to this README

### v2.11.0
- Paste fix: when the ticket field already holds a complete ticket ID (e.g. a pasted `CTK-1234`), the suggestion dropdown stays closed so it no longer covers the value
- Popup is now a minimum of 600px tall (was content-driven, ~513px)
- Dropdown favorites no longer show a leading ★ glyph — the amber color is the only cue (the per-row ☆/★ favorite toggle button is unchanged)
- Dropdown widened to 340px with tighter, more compact option rows (11px font), so more suggestions are visible at once

### v2.10.0
- CSV upload: click **📄 CSV** to import events from a `.csv` file
  - Columns: `title`, `start`, `end`, `tag` (tag optional, used for ticket ID)
  - Header row auto-detected; positional fallback if absent
  - ISO 8601 datetimes; explicit TZ offset honored, bare = local time
  - Date picker auto-set from first row
  - Full validation: blocks import on any malformed row with row-level error messages
  - Feeds into the same render pipeline (skip list, ClickUp dedup, combos, billable, click-to-edit)

### v2.9.10
- Ticket search now splits the query into words and requires all of them to
  appear in the task name — `"LCI PO"` matches `"LCI | M2 PO/Packing List..."`
  (previously required a contiguous substring match and missed this case)
- Search result cap raised from 5 to 10

### v2.9.9
- Live ClickUp ticket search in the dropdown:
  - Empty input or 1-3 chars → frequent tickets (unchanged)
  - 4+ chars → searches your assigned ClickUp tasks by title (max 5 results, 400ms debounce)
  - Input starting with CTK- bypasses search
  - Results cached per session to avoid duplicate API calls

### v2.9.8
- Fixed ticket dropdown becoming transparent on validation: opacity is now applied only to title/meta/checkbox elements, never to ancestors of the dropdown, so no stacking context is created where the dropdown lives

### v2.9.7
- Default date is now yesterday instead of today
- Click-to-edit event title: click any event title to modify the description sent to ClickUp (Enter to confirm, Escape to revert)

### v2.9.6
- Skip list is now pre-populated on fresh install (Lunch, Break, OOO, Out of office, PTO)

### v2.9.5
- Fixed skip list intermittently not applying: migrated skipList storage from chrome.storage.sync to chrome.storage.local so all read paths are consistent

### v2.9.4
- Session persistence: loaded events are saved to storage and restored when the popup reopens
- Added Cancel button to discard the session and return to the date picker

### v2.9.3
- Added margin-top to .timer-controls for visual separation from ticket name label

### v2.9.2
- Fixed timer icon alignment: moved ticket name label outside the combo div so it no longer inflates the row height
- Added `ticket-name-label:empty { display:none }` to prevent empty labels from taking up space

### v2.9.1
- Update checker now points to GitHub repo (alberto-curotec/gCal-2-ClickUp)
- Fixed vertical alignment of checkmark and star icons in the timer ticket row

### v2.9.0
- Removed leading dot from selected count label
- Matched font size of selected count and time sum to event count

### v2.8.9
- Fixed ticket name label: `applyTicketValidation` now creates the label element AND sets its text — previous versions had a broken reference to an undefined `nameLabel` variable

### v2.8.8
- Fixed ticket name label not appearing in calendar event rows — switched to
  insertAdjacentElement for reliable placement after the ticket input row

### v2.8.7
- Ticket name label font size increased to 12px
- Fixed ticket name label placement in calendar event rows — now appears
  below the ticket input row rather than inside the narrow combo container

### v2.8.6
- Ticket name now shown below the ticket input after validation in:
  - Calendar event rows
  - Timetracker ticket input
  - Timetracker confirmation panel
  - Clears when ticket ID changes or is invalid

### v2.8.5
- Fixed Recurrent Events Rules not pre-filling ticket IDs in popup — the
  getMatchingRule call was missing from renderEvents after a previous refactor
- Renamed "Event Rules" section to "Recurrent Events Rules"

### v2.8.4
- Fixed ticket names not showing in Event Rules dropdown for new rule rows
- Fixed popup horizontal scroll caused by wide dropdown (reduced to 270px)
- Fixed popup vertical scroll caused by dropdown pushing layout instead of
  overlaying (z-index and overflow fixes)

### v2.8.3
- Fixed ticket suggestions dropdown in Event Rules — was rendering as a plain
  list instead of a positioned overlay; fixed CSS scoping and z-index

### v2.8.2
- Event Rules ticket input now shows favorite and frequent ticket suggestions
  dropdown on focus, same as the popup ticket inputs

### v2.8.1
- Fixed "Load upcoming events" button not responding — added proper error
  handling for chrome.runtime.lastError and undefined response cases

### v2.8.0
- Added Event Rules in ⚙️ Settings:
  - Load upcoming calendar events (next 2 weeks) as rule suggestions
  - Click a suggestion to create a rule, or add manually with title + time
  - Each rule has ticket ID (validated), billable toggle, tag dropdown
  - Matching: title contains (case-insensitive) + optional time (HH:MM)
  - Priority: title+time match > title only > time only
  - On event load, matching events auto-fill ticket, billable and tag
- Fixed ticket suggestions dropdown width (min 300px, no longer clipped
  to the narrow ticket input width)

### v2.7.4
- Ticket suggestions dropdown now shows all options without a scrollbar

### v2.7.3
- Tag Manager checklist height doubled (260px → 520px) to show more tags
- Ticket suggestions dropdown now shows up to 8 frequent tickets (was 5),
  plus up to 3 favorites, for a total of 11 suggestions

### v2.7.2
- Tag Manager moved above Favorite Tickets in settings
- Tag Manager checklist now supports drag-and-drop reordering — order is
  preserved in enabledTags and restored on next open
- Favorite tickets now have an optional tag dropdown in settings — pre-fills
  the tag dropdown in the popup when that ticket is selected

### v2.7.1
- Added Tag Manager in ⚙️ Settings:
  - Fetches all workspace tags from ClickUp on first open
  - Checklist lets you select which tags appear in the dropdown
  - Refresh button to reload tags from ClickUp
  - Select all / Select none shortcuts
  - Tag dropdowns in popup only show enabled tags

### v2.7.0
- Added optional tag selector to time entries:
  - Tags fetched from ClickUp workspace time entry tags API (cached 10 min)
  - Tag dropdown appears to the right of the ticket input after validation
  - Ticket input narrowed to half-width to make room for the tag dropdown
  - Tag preference saved per ticket and pre-fills on next use
  - Tag also available in timetracker confirmation panel
  - Tag sent to ClickUp when logging time entries
- Added selected event count next to event count (e.g. "11 events found · 3 selected")

### v2.6.3
- Fixed auto-stop losing tracked time — confirm panel state is now saved to
  storage before the timer is cleared, so time is never lost on auto-stop
- Notification Stop button also saves confirm state correctly
- Starting a new timer is blocked while a confirmation panel is pending
- Notification message updated to clarify time is saved

### v2.6.2
- Added elapsed time badge on the extension icon:
  - Green badge shows elapsed minutes/hours when timer is running (e.g. 14m, 1h)
  - Orange badge when timer is paused
  - Badge clears when timer is stopped or auto-stopped
  - Updates every 30 seconds, restores correctly after browser restart

### v2.6.1
- Fixed pause button not appearing when timer starts

### v2.6.0
- Added Pause/Resume to the timetracker:
  - ⏸ Pause button (orange) appears next to ⏹ Stop when timer is running
  - ▶ Resume button (green) replaces Pause when timer is paused
  - Elapsed time is preserved correctly across pause/resume cycles
  - Paused state persists across popup close/reopen
  - Chrome notification fires every 5 minutes while paused as a reminder

### v2.5.3
- Added automatic update checker — popup shows a banner when a newer version
  is available on Bitbucket, with a direct link to the repository

### v2.5.2
- Improved setup documentation:
  - OAuth Client ID section now links directly to the Curotec Google Cloud
    Console credentials page
  - Added instructions for using bdkpjnahpplacaegbglhoilpcpamnkcg as the
    initial extension ID when setting up OAuth
- ClickUp Team ID now pre-filled with the Curotec workspace ID (9017610002)
  so new users don't need to look it up

### v2.5.1
- Timetracker now detects ticket ID from the ClickUp DOM when the URL doesn't
  contain it (e.g. inbox view) — reads from the task label button using the
  data-test="task-view-task-label__taskid-button" selector, with a fallback
  to scanning the page text

### v2.5.0
- Added billable preference per ticket:
  - Favorites: each favorite row in settings now has a Billable toggle
    (checked by default), saved immediately on change
  - Frequent tickets: billable status is saved every time a time entry
    is imported, so the last-used status is remembered
  - Priority: favorite setting > last-used > default (billable)
  - Pre-fills automatically in event row billable checkboxes on load
    and when a ticket is selected from the dropdown
  - Pre-fills in timetracker confirmation panel when timer stops or
    ticket ID is changed

### v2.4.3
- Removed temporary forced debug logging — debug mode back to settings toggle

### v2.4.2
- Fixed applyTicketValidation not applying isProtected check — previous edits
  were not persisting to file; verified and reapplied correctly

### v2.4.1
- Forced debug logging always on temporarily to diagnose [existing] checkbox issue
- Fixed applyTicketValidation re-enabling protected checkboxes on valid tickets

### v2.4.0
- Fixed [existing] rows being re-enabled after ticket validation — runValidation
  empty-id path was unconditionally re-enabling all checkboxes including
  protected rows

### v2.3.9
- Fixed [existing] events getting re-checked after ticket validation —
  applyTicketValidation now skips re-enabling checkboxes on rows that have
  a status-warning or status-danger class

### v2.3.8
- Fixed [existing] checkbox not being disabled — HTML attribute alone was
  unreliable; now also sets disabled imperatively via JS after the element
  is added to the DOM

### v2.3.7
- Added debug logging to status detection loop for diagnosing [existing]
  checkbox issue

### v2.3.6
- Fixed [existing] events not being disabled — checkbox attribute was not
  being applied correctly in HTML string; now uses explicit checked="checked"
  and disabled="disabled" forms

### v2.3.5
- Fixed bug where [existing] and [conflict] events were still checked and
  enabled — they are now unchecked and disabled to prevent duplicate entries
- Added total selected time sum displayed next to the event count (green,
  updates dynamically as checkboxes are toggled)

### v2.3.4
- Added ticket ID validation to the timetracker ticket input:
  - Pre-filled/auto-detected tickets validated on load
  - Typing validates after 600ms debounce
  - Dropdown selections validate immediately
  - Same ⏳/✔/✖ icons as calendar rows and confirm panel

### v2.3.3
- Added ticket ID validation against ClickUp API for both calendar events and
  the timetracker confirmation panel:
  - Calendar events: pre-filled ticket IDs validated on load (300ms stagger),
    manually entered IDs validated on demand (600ms debounce)
  - ⏳ shown while checking, ✔ yellow if valid, ✖ red if not found
  - Invalid rows are grayed out, checkbox unchecked and disabled
  - Row restores to normal when a valid ticket ID is entered
  - Timetracker: ticket validated on blur/debounce, Log Time stays disabled
    until both ticket is valid and description is filled

### v2.3.2
- Timetracker confirmation panel improvements:
  - Added mandatory Description field (3 lines) — Log Time stays disabled until filled
  - Description is sent as the ClickUp time entry description (not the ticket ID)
  - Removed +/- duration buttons — rounded duration shown as plain text
  - Raw tracked time shown in top right corner of the panel for reference

### v2.3.1
- Timer section hides when calendar events are loaded and reappears after
  import completes or when Load Events is clicked again

### v2.3.0
- Full housekeeping rewrite of popup.js:
  - Removed duplicate cleanTitle() function
  - Fixed ticket ID detection to use rawTitle (pre-clean) not cleaned title
  - Removed dead filter in getFrequentTickets
  - Unified dropdown builder into single buildDropdown() used by both event
    list and timer combos
  - Removed all leftover debug code and dead blocks from previous attempts
  - Consistent wireCombo() with onSelect callback throughout

### v2.2.1
- Fixed star not highlighting on first dropdown selection — complete rewrite
  of wireTimerCombo confirmed in place with working DOM node handlers

### v2.2.0
- Complete rewrite of wireTimerCombo — uses DOM nodes with direct per-item
  mousedown handlers, synchronous dbg() logging

### v2.1.9
- Fixed dbg() helper to cache debug mode synchronously so logs work inside
  event handlers (previously async storage read caused logs to be missed)

### v2.1.8
- Added global mousedown tracker and dropdown open log for debugging

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
