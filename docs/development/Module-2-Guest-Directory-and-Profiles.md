# CRM Module 2 – Guest Directory and Profiles

Oct 21, 2026 · @Tehan

Build order: 2 of 8, part of the first release. Staff can find any of the 6,333 guests already loaded and see who they are on one page.

## Overview

This is the heart of the CRM: a searchable list of every guest, lead, agent contact and influencer, and a profile page per person. Later modules add sections to the same profile page (stays, notes, consent, leads, feedback), so the page is built with room for them.

**Who uses it:** every role. Admin and Management can add and edit; Marketing can view only (see the roles table in Module 1).

**Depends on:** Module 1 (sign-in, roles, country picker).

**In this module:** guest list with search and filters, guest profile, add and edit guest, emails and phones, delete a guest.

**Not in this module:** stays (Module 3), notes and preferences (Module 4), consent and do-not-contact (Module 5), merging duplicates (Module 6).

## Workflow

**Finding a guest**

1. Staff open **Guests** and type part of a name, an email or a phone number into the search box.
2. Results update as they type. They can narrow the list with filters (type, stage, market, country, hotel stayed at).
3. They click a row to open the guest's profile.

**Adding a guest** (for example someone who called but has no booking yet)

1. Staff click **Add guest** and fill in the name, type, country and at least one email or phone.
2. If that email or phone already belongs to another guest, the form warns them and offers to open that guest instead.
3. On save, the profile opens.

**Keeping details up to date**

1. On the profile, staff edit the name, country or VIP reason.
2. They add a second email or phone, mark one as primary, mark an agent's or family address as shared, or tick that a number is on WhatsApp.
3. They mark an email as bounced or a number as wrong when they find out.

**Removing a junk record** (a test booking, a room block such as "Blocked for the Stretchline Ltd's meeting")

1. Staff choose **Delete guest** on the profile and confirm.
2. The guest disappears from lists and searches. An admin can restore them later.

## Screens and what users can do

**Guests (list)**

- Search box at the top: matches first name, last name, any email or any phone, as the user types.
- Filters: type (guest, lead, agent contact, influencer), stage (lead, enquired, booked, stayed, repeat guest, hotel unknown), market (local, foreign), country, hotel stayed at.
- Columns: name, stage (coloured chip), primary email, primary phone, country, hotels stayed at, number of stays, last stay.
- Sort by name or last stay; 50 rows per page with the total count shown ("6,333 guests").
- "Add guest" button, top right.

**Guest profile**

- **Header:** full name, stage chip, type, country with flag, market, VIP tag if set, company and job title for agent contacts. Edit and Delete buttons on the right.
- **Contact details panel:** every email and phone. Each shows a star for primary, a "Shared" badge, a status badge (valid, unverified, bounced, wrong number), a WhatsApp icon if known. Buttons: Add email, Add phone; per row: Make primary, Edit, Delete.
- **Placeholders** for the panels later modules fill: Stays, Notes and preferences, Consent, Leads, Feedback. Each shows "Coming soon" until its module is built.
- **Footer:** "Created 6 Oct 2026 by System · Last updated 21 Oct 2026 by Nisha Silva".

**Add / edit guest form**

- First name (required), last name, type (drop-down), country (searchable picker), market (filled from the country, can be changed), job title, VIP reason.
- When adding: one email or phone is required, entered on the same form.

**Add / edit email or phone**

- Type the address or number; tick Primary, Shared, On WhatsApp (phones only); pick a status.
- Phone numbers are entered with a country code picker and saved in the international form, for example +94 77 123 4567.

## Rules

- **Duplicate warning, not a block.** When an email or phone being added already belongs to another active guest, show "This email belongs to Ahmed Daoud" with an "Open Ahmed Daoud" button. The user can still save, because shared family numbers exist. Matching ignores case and spaces.
- **Shared addresses never warn and never match.** An address marked Shared (agent office, family email) is skipped by the duplicate warning and, in later modules, by booking matching.
- **One primary of each kind.** The first email and the first phone become primary automatically. Making another one primary removes the star from the old one in the same save.
- **Removing the primary** promotes the next newest email or phone of that kind, if there is one.
- **The same address can't be added twice** to one guest.
- **Market follows the country:** Sri Lanka sets Local, any other country sets Foreign, no country sets Unknown. Staff can override it, for example for an expat who lives in Colombo.
- **Names:** first name is required for new guests. Existing imported guests with only one name keep it in first name.
- **Stage is not edited here.** It moves on its own as stays and leads are recorded (Modules 3 and 7).
- **Delete hides, it does not erase.** A deleted guest disappears from lists and searches. Their stays and notes stay attached for when they are restored.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Guest list screen reading from the contact overview, with paging and the total count.
- [ ] Search across names, emails and phones, fast enough to update as the user types.
- [ ] Filters: type, stage, market, country, hotel stayed at; sort by name and last stay.
- [ ] Guest profile page: header, contact details panel, footer with created and last updated.
- [ ] Empty placeholder panels for Stays, Notes and preferences, Consent, Leads, Feedback.
- [ ] Add guest form, including the first email or phone.
- [ ] Edit guest form; market filled from country, overridable.
- [ ] Add, edit and delete an email or phone; make primary; shared, WhatsApp and status options.
- [ ] Phone entry with country code picker, saved in international format.
- [ ] Duplicate warning when an email or phone belongs to another guest, with a link to them.
- [ ] Delete guest with a confirmation step.
- [ ] Role checks: Marketing sees the profile without edit buttons.

## Done when

- Typing "daoud" shows Ahmed Daoud within a second, and typing "+966 54" finds him by phone.
- Filtering by hotel Rock Villa and stage Repeat guest gives a short, correct list.
- Adding a second phone to Avee Raam and making it primary moves the star; only one phone is primary.
- Adding a new guest with Ahmed Daoud's email shows the warning with a link to his profile.
- A deleted guest no longer appears in search.

## Later

- Export the current list to a spreadsheet (management and admin).
- Saved filters such as "UK repeat guests".
- An activity timeline on the profile, once Modules 3 to 8 add their panels.
