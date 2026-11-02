# CRM Module 8 – Guest Feedback and Employee Recognition

Oct 21, 2026 · @Tehan

Build order: 8 of 8. Every post-stay feedback form is stored against the stay, poor ratings are followed up, and employees guests name are recognised or coached.

## Overview

The hotels send a feedback form after each stay asking for a 1–5 rating and comments. This module stores each response on the stay, flags ratings of 1 or 2 for a manager to follow up, records praise or criticism of named employees, and shows each hotel's and each employee's results.

**Who uses it**

- **Management:** enter or import responses, tag the employees guests mention.
- **Hotel managers (management role):** follow up low ratings, review employee feedback.
- **Admin and each hotel's manager:** keep the employee list up to date.

**Depends on:** Module 3 (stays). Follow-up calls use the interaction log from Module 7; until then, follow-ups are recorded as notes (Module 4).

**Starting point:** no feedback and no employees loaded yet. Each hotel needs to send its staff list (name, department, job title).

## Workflow

**A feedback form comes back**

1. Staff open **Feedback → Add response**, or upload a file of responses exported from the form tool.
2. Each response is matched to its stay by booking reference (or staff pick the stay by guest and dates).
3. The rating and review are saved on the stay. Ratings of 1 or 2 appear in the inbox flagged **Needs follow-up**.

**Recording what the guest said about employees**

1. On the feedback detail, staff read the review and click **Add mention** for each employee named.
2. They pick the employee from that hotel's list, choose Praise or Criticism, and copy the guest's words.
3. If they can't tell who the guest meant ("the waiter with glasses"), they type the name as written and link the employee later.

**Following up a low rating**

1. The hotel's manager opens the flagged response, calls or messages the guest, and logs the conversation.
2. They mark the feedback **Followed up**, with a short outcome. It leaves the follow-up list.

**Reviewing results** (weekly or monthly)

1. Managers open **Feedback → Hotel ratings** to compare average ratings and response counts.
2. They open **Employees** to see who was praised or criticised, for recognition or coaching.

**Keeping the employee list current**

1. A new hire is added with name, hotel, department and job title.
2. A leaver is marked inactive. They disappear from the picker, but past mentions stay.

## Screens and what users can do

**Feedback inbox**

- Newest first: date received, hotel, guest, stay dates, rating as stars, the first line of the review, a red "Needs follow-up" chip for unresolved 1–2 ratings, and the number of employees mentioned.
- Tabs: All, Needs follow-up, Followed up. Filters: hotel, rating, date range.
- Buttons: Add response, Upload responses.

**Add response / upload responses**

- Add: pick the stay (search by guest or booking reference), enter rating, review and date received.
- Upload: a file of responses; preview shows which stay each one matched and which could not be matched.

**Feedback detail**

- The rating, the full review, the stay and guest (links), and the follow-up status.
- Employee mentions: one line each with the employee (or the name as written, marked "not linked"), Praise or Criticism, and the guest's words. Add, edit, link to employee, delete.
- Follow-up: "Mark followed up" with an outcome note; the logged call or message shows here.

**Feedback panel on the guest profile and on the stay**

- The rating and review for each stay that has one.

**Employees**

- List by hotel and department: name, job title, active or inactive, praise and criticism counts for the last 90 days.
- Add employee, edit, deactivate. Admin and management only.

**Employee page**

- Name, hotel, department, job title; praise and criticism counts overall and for the last 90 days; every comment, newest first, with the guest and the stay rating.

**Feedback → Hotel ratings**

- One row per hotel: responses, average rating, average for the last 90 days, number of low ratings, last response date.

## Rules

**Feedback**

- One response per stay. A second response for the same stay is refused with a link to the first.
- Rating is a whole number from 1 to 5. A response needs a rating, a review, or both; an empty form is refused.
- A response can only be added to a stay that is checked out (or has no status, for older stays).

**Follow-up**

- Ratings of 1 or 2 need follow-up. They stay on the Needs follow-up tab until someone marks them Followed up with an outcome note.
- Marking followed up records who did it and when.

**Employee mentions**

- Each mention is Praise or Criticism, with the guest's words.
- It is linked to an employee, or holds the name as the guest wrote it until staff can link it. One of the two is required.
- The same employee can be mentioned only once per response.
- The employee picker shows active employees of the stay's hotel first, then the rest of the group.

**Employees**

- Name, hotel (or group-wide), department (front office, housekeeping, food and beverage, kitchen, spa, transport, activities, maintenance, management, other) and job title.
- Leavers are made inactive, never deleted, so their history stays.
- An employee who also uses the CRM can be linked to their staff login.

**Who sees employee feedback:** Management and Admin only. Criticism of a named person is not shown to other staff.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Add follow-up fields to feedback (followed up, by whom, when, outcome).
- [ ] Employees screen: list, add, edit, deactivate; load each hotel's staff list.
- [ ] Add response form with stay search; the one-per-stay and rating rules.
- [ ] Upload responses from a file with stay matching and preview.
- [ ] Feedback inbox with tabs, filters and the Needs follow-up chip.
- [ ] Feedback detail with employee mentions: add, link later, edit, delete.
- [ ] Mark followed up with outcome; show the logged call or message (Module 7) or note (Module 4).
- [ ] Feedback panel on the guest profile and the stay detail.
- [ ] Employee page with counts and comments.
- [ ] Hotel ratings page.
- [ ] Role checks: employee feedback visible to Management and Admin only.

## Done when

- A 2-star response for Ahmed Daoud's Mayur Lodge stay appears under Needs follow-up, and leaves it once marked followed up.
- A second response for the same stay is refused.
- Praise for "Kamal" linked to Kamal Perera (Rock Villa driver) shows on his employee page.
- A mention of "the waiter with glasses" is saved as not linked, then linked to an employee later.
- Hotel ratings shows Rock Villa's average and response count matching the responses entered.

## Later

- The feedback form sending responses straight into the CRM, with no upload.
- Recording when each form was sent, to measure response rates.
- A monthly employee recognition summary emailed to each hotel manager.
