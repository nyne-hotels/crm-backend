# CRM Module 4 – Guest Knowledge: Notes, Preferences, Dates and Tags

Oct 21, 2026 · @Tehan

Build order: 4 of 8. Staff record what they learn about each guest, so the next team to look after them knows it too.

## Overview

This module fills the guest profile with the personal knowledge that makes service feel personal: likes and dislikes, staff notes, birthdays and anniversaries, and labels such as VIP. It also gives the hotels a list of occasions coming up, so they can plan a cake or an offer.

**Who uses it**

- **Management:** record likes, dislikes and notes during the stay, read them before a booking and add dates guests mention.
- **Management and marketing:** use the upcoming occasions list and the VIP tag. Marketing sees everything but cannot change it.
- **Admin:** manages the list of tags.

**Depends on:** Module 2 (guest profile). Notes linked to a stay need Module 3.

**Already loaded:** 94 likes and dislikes and 131 notes from the old guest logs.

## Workflow

**Recording a like or dislike** (the restaurant notices the guest only drinks Jacob's Creek red)

1. Open the guest's profile, Preferences panel, **Add**.
2. Pick Like or Dislike, a category (food and drink, dietary or health, room, activity, occasion, background), type the detail, and optionally link it to the current stay.
3. Save. It shows as a chip on the profile for every hotel.

**Writing a note** (the guest asked for late checkout)

1. On the profile or on a stay, click **Add note** and type it.
2. Save. The note appears at the top of the guest's notes with the author's name and time.

**Adding a birthday or anniversary**

1. Special dates panel, **Add date**.
2. Pick the occasion (birthday, wedding anniversary, partner's birthday, child's birthday, other), enter the day and month, and the year if known. Add a name for a partner or child.

**Tagging a guest**

1. Tags panel, **Add tag**, pick from the list (VIP / industry, Friends & family, and any tags the admin adds).
2. The tag shows in the profile header and can be used as a filter in the guest list.

**Planning for occasions**

1. Open **Guests → Upcoming occasions** each week.
2. See everyone with a birthday or anniversary in the next 60 days, with whether they can be emailed and whether they have a stay booked.

## Screens and what users can do

All of these are panels on the guest profile, except the last two.

**Preferences panel**

- Two groups of chips: Likes (green) and Dislikes (red), each with its category icon. Hover shows who added it, when, and the stay.
- Add, edit, delete.

**Notes panel**

- Newest first: the note, author, date, and a chip for the stay or lead it belongs to.
- A box at the top to write a new note; optional "Link to stay" picker.
- Edit and delete on notes you wrote (admins can edit any).
- The same notes also appear on the stay detail when linked to a stay.

**Special dates panel**

- One line per date: occasion, name if any, day and month, year if known, and "in 12 days" when it is within 60 days.
- Add, edit, delete.

**Tags**

- Shown as chips in the profile header. Click to add from the list; click a chip's × to remove.

**Guests → Upcoming occasions**

- A list for the next 60 days, soonest first: date, days away, occasion, guest, years married or age turning (when the year is known), email consent, next booked stay if any.
- Filters: occasion type, hotel of their next or last stay, can be emailed.

**Settings → Tags** (admin only)

- The tag list: add, rename, retire. Shows how many guests have each tag.

## Rules

**What goes where**

| Staff want to record | Goes in | Example |
| --- | --- | --- |
| Something the guest likes or dislikes | Preferences | Gluten free; loves the Walauwa Suite |
| Any other remark | Notes | Asked for late checkout |
| A birthday or anniversary | Special dates | Wedding anniversary, 3 November 2015 |
| A label for grouping | Tags | VIP / industry |

**Notes**

- A note always belongs to a guest (or, from Module 7, a company). A note added on a stay is linked to that stay and to its guest automatically.
- Only the author or an admin can edit or delete a note. The note shows "edited" once changed.
- Deleted notes are hidden, not erased.

**Preferences**

- Kind is Like or Dislike only. Category is optional but encouraged.

**Special dates**

- Day and month are required; year is optional.
- Impossible dates (31 April) are refused with a clear message. 29 February is allowed and falls on 1 March in other years.
- A guest can have several dates, including more than one of the same kind (two children's birthdays).

**Tags**

- Picked from the admin's list only, never typed freely.
- A guest can have a tag only once. Retiring a tag hides it from the picker but keeps it on guests who already have it.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Preferences panel: show likes and dislikes as chips; add, edit, delete; optional category and stay link.
- [ ] Notes panel: newest first with author and date; add, edit and delete with the author-or-admin rule.
- [ ] Notes on the stay detail (Module 3), linked to both the stay and the guest.
- [ ] Special dates panel: add, edit, delete; date checks; "in N days" label.
- [ ] Tags in the profile header: add from the list, remove.
- [ ] Tag filter in the guest list (Module 2).
- [ ] Settings → Tags for admins: add, rename, retire, guest counts.
- [ ] Upcoming occasions page with filters.
- [ ] Role checks: Management and Admin add preferences and notes; Marketing sees but cannot change.

## Done when

- A management user adds "Like: Jacob's Creek red" for Dawn Elliott and a management user at another hotel sees it on her profile.
- A note added on a stay shows on both the stay and the guest's notes, with the author's name.
- Entering 31 April as a birthday is refused; entering 3 November with no year is accepted.
- A wedding anniversary 14 days away appears on Upcoming occasions with "11 years" when the year is 2015.
- The 131 imported notes show on the right guests.

## Later

- A weekly email to each hotel manager listing next week's occasions for guests with a booking.
- Automatic categorising of the old imported notes.
