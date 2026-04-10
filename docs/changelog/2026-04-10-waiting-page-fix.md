# Changelog: 2026-04-10 — Waiting Page Fix

## Problem
When a dispatcher navigated to an unknown domain, the extension showed **blocked.html** immediately, even though the domain was only pending moderation (not actually blocked by a moderator). This was confusing — dispatchers thought the site was blocked when it was just waiting for review.

## Root Cause
`background.js` had two bugs:

1. **`handleNavigation()` cache hit** (line 68): `pending` and `blocked` were treated identically — both called `blockTab()` → showed blocked.html
2. **`handleCheckResult()` pending handler** (line 151): Called `blockTab(tabId, domain, ..., 'pending')` which always redirected to blocked.html regardless of type parameter

`waiting.html` existed but was **never used** — no code path led to it.

## Fix

### background.js changes:
1. **Cache hit**: `pending` → `showWaitingPage()` (not `blockTab()`)
2. **Fresh check result**: `pending` → `showWaitingPage()` (not `blockTab()`)
3. **New function `showWaitingPage()`**: Redirects to waiting.html with domain, url, eventId params. Also tracks in blockedTabs for approve transition.
4. **`approveAllTabsWithDomain()`**: Now also searches for waiting.html tabs (not just blocked.html)

### No changes needed:
- waiting.html / waiting.js — already had correct polling and transition logic
- blocked.html / blocked.js — unchanged
- approved.html / approved.js — unchanged
- Backend — unchanged

## State Mapping (After Fix)

| Backend decision | Page shown |
|-----------------|------------|
| trusted/approved | (pass through) |
| pending | **waiting.html** (was: blocked.html) |
| blocked | blocked.html |
| dangerous | blocked.html |

## What Must NOT Break
- Cached 'blocked' domains must still show blocked.html
- waiting.js polling must still work (GET_DECISION every 1.5s)
- Approve transition: waiting.html → approved.html → original URL
- Block transition: waiting.html → blocked.html
- blockTab() still works for actual blocked/dangerous domains
