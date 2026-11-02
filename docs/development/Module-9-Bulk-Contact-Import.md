# CRM Module 9 – Bulk Contact Import

Oct 28, 2026 · @Tehan

Build order: 9, after the first eight. Admins can bring a spreadsheet of new contacts into the CRM, deciding for each person the CRM already has whether to leave them, add them again or update them.

## Overview

The CRM is now the guest list. Staff add and edit people in the CRM, not in Excel. This module covers the times a list arrives from somewhere else: an event sign-up sheet, a new agent list, a Wix export, a list from a hotel. The admin uploads it, the CRM checks every row against what it already holds, and nothing is saved until the admin has seen what will happen and confirmed it.

**Who uses it**

- **Admin only.** The menu item, the page and the API are all closed to Management and Marketing.

**Depends on:** Module 1 (roles, hotels), Module 2 (guests, emails and phones), Module 4 (notes, preferences, tags), Module 5 (consent), Module 6 (duplicates), Module 7 (companies). It reuses the column matching and preview from the booking import (Module 3).

**In this module:** the contact template, upload, column matching, row checks, the matches review with Ignore / Add / Update, saving, the result file, the import history and the change log.

**Not in this module:**

- Keeping Excel and the CRM in step. This is a one-way import, not a sync.
- Deleting anyone. A person missing from the file is left alone.
- Dated stays, leads, conversations and feedback. Stays come from the booking import (Module 3), leads and conversations are added in the CRM.

## Workflow

**Importing a list** (admin)

1. Open **Settings → Import contacts**. Read the instructions and warnings on the page.
2. Download the template, or use the list as it is if its columns are close to the template.
3. Upload the file. The first time, match each column in the file to a CRM field; the CRM remembers the matching for next time.
4. The CRM checks every row and sorts them into four groups, without saving anything:
   - **New:** no one in the CRM has this email or phone. Will be added.
   - **Already in the CRM:** the email or phone belongs to an existing contact. The admin chooses what to do (next section).
   - **Errors:** the row breaks a rule. Shown with the reason; it will not be imported.
   - **Repeated in this file:** a later row with the same email or phone as an earlier row. Shown as an error so the admin can merge the rows in the file.
5. For each row in **Already in the CRM**, the admin picks **Ignore**, **Add** or **Update**, one by one or with "Apply to all".
6. The confirm step lists what will happen in numbers ("212 new, 38 updated, 5 added again, 14 ignored, 9 errors") and every warning that applies. The admin ticks "I have read the warnings" and clicks **Import**.
7. Everything is saved in one go. If anything fails, nothing is saved.
8. The result page shows the counts, the new contacts and companies created, and the do-not-contact guests who opted in. The admin downloads the result file: every row of the upload with what happened to it, and the error rows with their reasons.

**Checking an import later**

1. Open **Settings → Import contacts → History**.
2. Each import shows who uploaded it, when, the file name and the counts. Open one to see every change it made: which contact, which field, the old value and the new value, consent changes included.
3. On a guest's profile, the footer and the consent panel show "Updated by contact import #12 (Tehan, 28 Oct 2026)" where the import changed them.

## The choices for a contact already in the CRM

The review shows the CRM's record and the file's row side by side, with the differences highlighted, and a link to open the contact.

- **Ignore:** nothing changes. This is the default, so no existing contact changes unless the admin chooses it.
- **Add:** create a new contact anyway, for example a family member who uses the same email. The two will appear together in Possible duplicates (Module 6).
- **Update:** the file's values are written to the existing contact. **The file has priority**, consent included. See Rules.

## Screens and what users can do

**Settings → Import contacts** (admin only)

The top of the page always shows this panel, before the upload box:

> **How to use this page**
>
> 1. Download the template and keep its column headings. Other headings work too: you will be asked to match them to CRM fields.
> 2. One row per person. Every row needs a name, and an email or a phone number. For an agency's office contact, the company name counts as the name.
> 3. Write phone numbers with the country code (+44 7911 123456). Sri Lankan numbers starting with 0 are read as +94.
> 4. Countries, hotels, types and tags must be written as the CRM lists them (the template's second tab lists them all).
> 5. In "Email marketing" and "WhatsApp marketing", write Yes or No. Leave the cell empty if you don't know.
> 6. Nothing is saved until you click Import on the last step. You can stop at any point.

> **Warnings**
>
> - **The file wins when you choose Update.** Every filled cell replaces what the CRM has: names, type, country, company, and the primary email and phone. Empty cells change nothing.
> - **Consent follows the file.** "No" opts the person out. "Yes" opts them back in, even if they unsubscribed in the CRM or with the email tool. Only upload "Yes" for people who have agreed to marketing, and be ready to show where they agreed.
> - **Updates cannot be undone in one step.** Every change is logged with its old value, so it can be put back by hand, but there is no Undo button.
> - **Your name is recorded on every change this import makes.**
> - **Rows that only match by name are new contacts.** Check Possible duplicates afterwards.
> - **This page does not delete anyone and does not record dated stays.** Use the booking import for stays.

On the confirm step, the warnings that apply to this file are repeated with the numbers. For example:

- "38 existing contacts will be changed. Their old values are kept in the change log."
- "11 contacts who had opted out of email will be opted back in."
- "3 guests on do-not-contact will be recorded as opted in but stay blocked."
- "4 new companies will be created: …"

The Import button stays disabled until the admin ticks "I have read the warnings".

**Step 1, Upload:** drop an .xlsx or .csv file, up to 10,000 rows. The first sheet is read, or the admin picks the sheet.

**Step 2, Match columns:** each column in the file paired with a CRM field, or "Don't import". It is filled in automatically from the headings, saved for next time, and can be changed.

**Step 3, Review:** the four groups as tabs with counts. Each row shows its row number in the file, the name, email, phone, what will happen and, for errors, the reason. In "Already in the CRM": the side-by-side comparison, the Ignore / Add / Update choice per row, and "Apply to all". Search and filter by outcome.

**Step 4, Confirm:** the counts, the warnings that apply, the tick box and the Import button.

**Step 5, Result:** the counts, the new contacts (linked), the new companies, the do-not-contact opt-ins, and "Download result file".

**History:** a table of imports with date, who, file name, rows, new, updated, added again, ignored and errors. Opening one shows the change log, which can be filtered by contact and field and downloaded.

## The template

One sheet, one row per person. A second tab lists the allowed values (types, countries, hotels, tags).

| Column | Required | Notes |
| --- | --- | --- |
| First name | Yes¹ | Or a single **Name** column, split as in the booking import |
| Last name | | |
| Type | | Guest, Prospect, Agent contact or Influencer. Blank: Prospect for a new contact |
| Email | One of these² | Becomes the primary email |
| Other emails | | Separated by ; |
| Phone | One of these² | With country code; becomes the primary phone |
| Other phones | | Separated by ; |
| Shared email | | Agent office or family address, never used for matching or marketing |
| Shared phone | | As above |
| Country | | As the CRM lists it, or the 2-letter code (GB) |
| Market | | Local, Foreign or Unknown. Blank: worked out from the country |
| Company | | Matched to Companies by name |
| Job title | | |
| VIP reason | | Also adds the VIP / industry tag |
| Tags | | Separated by ;, existing tags only |
| Hotels stayed at | | Separated by ;, as the CRM lists them |
| Email marketing | | Yes, No or blank |
| WhatsApp marketing | | Yes, No or blank |
| Likes | | |
| Dislikes | | |
| Notes | | |

¹ For an agent contact with a Company, the company name is enough.
² A name alone is not enough: there would be nothing to recognise the person by.

## Rules

**Every row needs a name, and an email or a phone.** An agent contact with a company may use the company name as its name. Rows without these are errors.

**Checks on each row** (any failure makes the row an error, with the reason):

- Emails are valid addresses. Phones are possible numbers with a country code, or Sri Lankan numbers starting with 0. A number Excel rounded (ending in 00000) is rejected.
- Country, type, market, hotels and tags are values the CRM lists.
- Yes / No columns hold Yes, No or nothing.
- The same email or phone does not appear on an earlier row of the same file.

**Finding the existing contact**, as for bookings:

1. Same email as a contact in the CRM, ignoring case and spaces.
2. Otherwise, same phone number, compared by its digits.
3. Shared addresses and numbers are never used, in the file or in the CRM.
4. Never on name alone. A row that matches no email or phone is new, even if the name is the same.
5. If the email matches one contact and the phone another, the row goes to "Already in the CRM" showing both. The admin picks which one to update, or Add or Ignore.

**A new contact** is created as a contact added in the app would be: the first email and phone primary, status unverified, consent unknown unless the file says Yes or No, created by the admin who imported it.

**Update: the file has priority.**

- Every filled cell replaces the CRM's value: first and last name, type, country, market, company, job title, VIP reason.
- Empty cells never clear anything.
- The file's email and phone become the primary ones. The CRM's previous ones stay on the contact as extras, so no detail is lost. Other emails and phones are added if new.
- Changing the type moves the stage as the guest form does (an Agent contact becoming a Guest takes their stage from their stays).
- Consent follows the file. Yes sets the channel to opted in, No to opted out, empty leaves it. This applies even if the CRM has the opposite choice. The source is recorded as "Contact import", with the date of the import and the evidence "Contact import #12, file name, row 41, by Tehan".
- Do-not-contact is not changed by an import. A Yes for a do-not-contact guest is recorded but they stay blocked, and they are listed in the result for staff to confirm, as with the booking tick box (Module 5).
- Tags in the file are added; tags the contact already has are kept.
- Likes, dislikes and notes are added as new entries, unless the contact already has the same text.
- Hotels stayed at add a checked-out stay without dates at a hotel the contact has no stay at yet. They never change existing stays.
- Stays, leads, conversations, feedback, special dates and merge history are never touched.

**Add** creates a new contact from the row, as for a new contact, even though the email or phone belongs to someone else.

**Companies.** A company name is matched to Companies ignoring case. A name the CRM doesn't have creates a new company (type travel agent, status prospect), listed on the confirm step and in the result.

**Logging.**

- Every import is recorded: who, when, the file name, the column matching used, the counts and the result file.
- Every change an Update makes is recorded in the change log: the contact, the field, the old value, the new value, the import and the row. That covers each consent change, each primary email or phone that moved, and each field replaced. New and added-again contacts are listed with the row they came from.
- All rows the import writes carry the admin's name (created by / updated by), as every other change in the CRM does.
- The log is never edited or deleted, and the import history is visible to admins only.

**All or nothing.** The import saves everything or nothing. Two admins cannot import at the same time; the second one is told to wait.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Database: a contact imports table (one row per upload: who, when, file, mapping, counts, details) and a contact import changes table (one row per changed field: import, row, contact, field, old value, new value). Add "Contact import" to the consent sources.
- [ ] Template download (.xlsx) with the allowed values tab, built from the live pick-lists.
- [ ] Settings → Import contacts page, admin only, with the instructions and warnings panels.
- [ ] Step 1 upload and step 2 column matching, reusing the booking import's matching, remembered as "contacts".
- [ ] Row checks and matching rules, as a rules module with unit tests (no database), so the preview and the save run the same plan.
- [ ] Step 3 review: the four groups, the side-by-side comparison, Ignore / Add / Update per row and "Apply to all".
- [ ] Step 4 confirm with the counted warnings and the tick box.
- [ ] Saving in one transaction: new contacts, updates with the change log, consent with source and evidence, companies, tags, notes, preferences, stays without dates.
- [ ] Step 5 result and the result file download.
- [ ] Import history and the change log view and download.
- [ ] "Updated by contact import #…" in the profile footer and the consent panel.
- [ ] Role checks on the API as well as the menu: admin only.

## Done when

- Uploading the template with 5 new people adds 5 contacts, each with consent as the file says, created by the admin.
- A row with Ahmed Daoud's email shows under "Already in the CRM" next to his record. Ignore leaves him unchanged; Update changes his name and phone to the file's, keeps his old phone as an extra, and the change log shows both old values.
- A row with "Email marketing: Yes" for a guest who opted out in the CRM opts them back in when updated. The confirm step warned about it, and the consent panel shows "Contact import #…" with the admin's name.
- A row with only a name is an error, "Needs an email or a phone".
- Uploading the same file twice: the second time, every row shows under "Already in the CRM", and choosing Ignore for all changes nothing.
- A Management or Marketing user cannot see the page, and the API refuses them.

## Later

- Undo an import: put every changed field back from the change log in one step.
- Scheduled imports from Wix, so website sign-ups arrive without a file.
