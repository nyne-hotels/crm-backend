# CRM Module 6 – Duplicates and Merging

Oct 21, 2026 · @Tehan

Build order: 6 of 8. Staff clean up guests who appear twice, so each person has one profile with their full history.

## Overview

The same person can end up with two profiles, for example one from the website with a Gmail address and one from a booking with a work email. This module lists likely duplicates for staff to review and merges a confirmed pair into one profile, without losing anything.

**Who uses it:** Management and Admin. Admin also sees the merge history.

**Depends on:** Module 2 (guest profile). Merging is most useful once Modules 3 to 5 have added stays, notes and consent, but can be built any time after Module 2.

**Starting point:** 201 possible duplicate pairs from the initial load. Some are the same person (Avee Raam, with a Gmail and a Taj Hotels address); others are different people who share a name or a family phone.

## Workflow

**Working through the duplicates queue**

1. Open **Guests → Possible duplicates**. Each pair shows why it was flagged: same name, same email or same phone.
2. Open a pair. The two profiles appear side by side with their details, stays, notes and consent.
3. Decide:
   1. **Same person:** choose which profile to keep (usually the one with more history), check the preview of what will move, and click **Merge**.
   2. **Different people:** click **Not a duplicate**. The pair leaves the queue and does not come back.
   3. **Not sure:** click **Skip** and come back later.

**Merging from a profile** (staff spot a duplicate while working)

1. On the profile, ⋯ menu, **Merge with another guest**.
2. Search for the other guest, then continue on the same side-by-side screen.

**Checking a past merge** (admin)

1. Open **Settings → Merge history**.
2. Each merge shows who did it, when, which profile was kept and a read-only copy of the profile that was removed.

## Screens and what users can do

**Guests → Possible duplicates**

- One row per pair: both names, the reason badges (Same name, Same email, Same phone), and each guest's stays count and last stay.
- Pairs matching on email or phone are listed first, as they are the most likely real duplicates.
- Filter by reason; count at the top ("201 pairs to review").
- Row buttons: Review, Not a duplicate.

**Merge screen (side by side)**

- Two columns, one per profile, with a "Keep this one" choice at the top of each. The kept profile is highlighted.
- Each column lists: name, type, stage, country, emails and phones, consent per channel, tags, stays, notes, preferences, special dates, leads.
- A preview box under the columns explains the outcome in plain words, for example: "Avee Raam will have 2 emails, 2 phones, 1 stay (both profiles had the same Rock Villa stay), consent unknown."
- Buttons: Merge (asks to confirm), Not a duplicate, Cancel.
- After merging, the kept profile opens with a note at the top: "Merged with a duplicate on 21 Oct 2026 by Nisha Silva."

**Settings → Merge history** (admin only)

- Date, merged by, kept guest (link), removed guest's name.
- Open a row to see a read-only copy of the removed profile and what moved.

## Rules

- **Never automatic.** The CRM only suggests pairs. A person always decides, because two guests can share a name or a family phone.
- **What the merge does**, all in one step (if anything fails, nothing changes):
  - Stays, notes, preferences, special dates, leads, interactions and feedback move to the kept profile.
  - A stay both profiles had (same hotel and booking reference, or same hotel and arrival date) is kept once.
  - Emails and phones move across; exact duplicates are dropped; the kept profile's primary email and phone stay primary.
  - Consent per channel takes the strictest status: opted out, then opted in, then not opted in, then unknown. An opt-out is never lost.
  - Tags are combined.
  - Empty fields on the kept profile are filled from the other one; filled fields are never overwritten.
  - Stage is recalculated from the combined stays. Do not contact carries over if either profile had it.
  - The other profile is removed, and a full copy of it is kept in the merge history.
- **No undo button in this version.** A wrong merge can be rebuilt from the merge history by an admin.
- **Not a duplicate is remembered** for that pair, so it never returns to the queue.
- **Who can merge:** Management and Admin.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Add a place to remember "Not a duplicate" decisions for a pair, and hide those pairs from the queue.
- [ ] Possible duplicates page: list, reason badges, email and phone matches first, filter, count.
- [ ] Side-by-side merge screen with the "Keep this one" choice.
- [ ] Plain-words preview of what the merge will do, before confirming.
- [ ] Merge button calling the database's merge, then opening the kept profile with the merged note.
- [ ] "Merge with another guest" from the profile menu, with guest search.
- [ ] Settings → Merge history with a read-only view of the removed profile.
- [ ] Role checks: only Management and Admin see merge actions (not Marketing); only Admin sees the history.

## Done when

- Merging Avee Raam's two profiles leaves one profile with both emails, both phones, one Rock Villa stay and stage "stayed" (not repeat guest).
- Merging a profile that opted out with one that opted in leaves the guest opted out.
- Marking a pair "Not a duplicate" removes it from the queue for good, and the count drops by one.
- The merge appears in Merge history with the staff member's name.

## Later

- An Undo button that rebuilds the removed profile from the merge history.
- Duplicate checking while a booking import is previewed (Module 3).
