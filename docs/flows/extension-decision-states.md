# Flow: Extension Decision States

## State Mapping

| Backend decision | Extension action | Page shown |
|-----------------|-----------------|------------|
| `trusted` / `approved` | Cache as 'trusted', pass through | (original site) |
| `pending` | Cache as 'pending', show waiting | **waiting.html** |
| `blocked` | Cache as 'blocked', block tab | **blocked.html** |
| `dangerous` (GSB) | Cache as 'blocked', block tab | **blocked.html** (type=dangerous) |

## Key Rule
**`pending` NEVER shows blocked.html.** Pending domains show waiting.html until moderator decides.

## Waiting Page Flow
1. `handleCheckResult()` receives `decision='pending'` from backend
2. Calls `showWaitingPage()` (NOT `blockTab()`)
3. waiting.html loads with `domain`, `url`, `eventId` params
4. waiting.js starts:
   - Timer counting seconds
   - Polling via `GET_DECISION` message every 1.5s
   - Also listens for `MODERATOR_DECISION` direct message
5. On approved: shows green animation, redirects to original URL in 2s
6. On blocked: redirects to blocked.html

## Cache Hit Behavior
- `cached.decision === 'pending'` → `showWaitingPage()` (waiting.html)
- `cached.decision === 'blocked'` → `blockTab()` (blocked.html)
- `cached.decision === 'trusted'` → pass through (no redirect)

## Transition: Pending → Approved
1. Background polling (2s) detects `status.decision === 'approved'`
2. Updates cache to 'trusted'
3. Calls `approveAllTabsWithDomain()` which finds waiting.html/blocked.html tabs
4. Redirects to approved.html → original URL

## Transition: Pending → Blocked
1. Background polling (2s) detects `status.decision === 'blocked'`
2. Updates cache to 'blocked'
3. waiting.js own polling detects block → redirects to blocked.html

## Key Files
- `background.js` — `handleCheckResult()`, `showWaitingPage()`, `blockTab()`, polling
- `pages/waiting.html` + `pages/js/waiting.js` — waiting UI + polling
- `pages/blocked.html` + `pages/js/blocked.js` — blocked UI
- `pages/approved.html` + `pages/js/approved.js` — approved UI + redirect
