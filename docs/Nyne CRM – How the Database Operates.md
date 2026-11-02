# Nyne CRM – How the Database Operates

Oct 21, 2026 · @Tehan

## Purpose

This document describes what the CRM database does, step by step, whenever something happens at the hotels: a booking arrives, a guest enquires, a feedback form comes back, a duplicate is found. It is written for the developers building the NestJS + Drizzle service and for the operations leads who will check that the rules match how the hotels work.

The database has 21 tables. **Contacts** sit at the centre, one row per person. Around them are their emails and phones, consents, special dates, tags, notes and preferences. **Stays** record each visit to one of the 8 hotels, with **feedback** and **employee mentions** hanging off a stay. **Leads** and **interactions** track sales activity. Reference tables (properties, countries, occasions, companies, employees, staff users) hold the pick-lists, and **contact\_merges** and **data\_issues** keep the data clean.

The tables were created from `schema.sql`. Each section below says which rules the database enforces on its own and which ones the NestJS service must carry out.

## Ground rules that apply to every table

Five rules hold everywhere, so the flows below do not repeat them.

1. **Every change is stamped.** Each table has `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at` and `deleted_by`. The exceptions are `contact_tags` and `contact_merges`, which are never edited and only have `created_at` and `created_by`. A trigger fills these columns; the service never writes them.
2. **The database knows who is acting.** At the start of every request the service runs `set_config('app.staff_id', '<staff id>', true)` inside the request's transaction. The audit trigger reads it. A blank `*_by` means the system did it, for example a scheduled import.
3. **Nothing is hard-deleted by users.** Deleting a record sets `deleted_at`. The row stays for history, every view hides it, and restoring it clears `deleted_at` and `deleted_by`. The only real deletes are inside `merge_contacts`, and those are logged.
4. **Pick-lists, not free text.** Countries, occasions, departments, statuses, channels and sources are fixed lists (lookup tables or CHECK constraints). The app shows them as drop-downs. A value outside the list is rejected.
5. **Uniqueness ignores deleted rows.** Rules such as "one email per person", "one consent row per channel", "one feedback per stay" and "one booking reference per hotel" only count rows that are not deleted. A deleted email or tag can be added again without a clash.

## Recording a stay from the booking system

Each booking is handled in one transaction: find the stay by hotel and booking reference, find or create the guest, write the stay, then let the database move the guest's lifecycle stage. If any step fails, nothing is saved.

&#91;embedded content: recording a booking · 3 checks, 6 steps\]

Only a booking reference the CRM has never seen creates a stay; the guest is found by email first, then phone, and created only when both miss.

**What arrives from the booking system:** booking reference, hotel, arrival and departure dates, guest name, email, phone, country, adults and children, room type, room revenue and currency, and the channel or agent. The occasion is filled in if the booking form asks for it.

1. **Is this booking already in the CRM?** Look for a stay with the same `property_id` and `booking_reference` that is not deleted. If one exists, this is an update, not a new stay (next section). The database also blocks a second stay with the same hotel and reference, so a re-run import cannot double-count.
2. **Find the guest, in this order.**
   1. An email on an active contact that matches the booking's email (case-insensitive), ignoring addresses marked `is_shared`.
   2. Otherwise, a phone in the same international format, again ignoring shared numbers.
   3. Otherwise, create a new contact. Never match on name alone. A name-only match becomes a new contact and shows up in `possible_duplicates` for staff to review.
3. **New guest only:** create the contact (`contact_type` guest, first word of the name as `first_name`, the rest as `last_name`, `country_code` from the booking or the phone's dial code, `market` local for LK and foreign otherwise). Add the email and phone as primary contact methods with status `unverified`. Add one consent row each for email and WhatsApp with status `unknown`.
4. **Existing guest:** if the booking brings an email or phone the CRM does not have, add it as a non-primary contact method. Do not overwrite the name, country or primary details.
5. **Consent from the booking:** the latest explicit choice wins, and silence changes nothing. If the booking form has a marketing tick box and the guest ticked it, set that channel to `opted_in` with `source` booking form, `given_at` the booking time and the box's wording in `evidence`. This applies even if they had opted out before, because ticking the box again is a new choice. If they were already opted in, refresh `given_at` and `evidence`. An unticked box, or a form without one, never changes the status: an opt-out stays an opt-out and an opt-in stays an opt-in. If the contact is marked `do_not_contact`, still record the opt-in but leave the contact on do-not-contact and flag it for staff to confirm with the guest; `marketing_email_list` keeps blocking them until staff clear it.
6. **Write the stay** with the booking reference, dates, room type, guests, revenue, channel, the agent or OTA in `booking_company_id` (matched by company name) and the occasion from the pick-list.
7. **The database moves the guest forward.** A trigger counts the guest's stays: one makes them `stayed`, two or more `repeat_guest`, and a `lead` contact becomes a `guest`. It never moves anyone backwards and never touches agent contacts or influencers.
8. **Close any open lead.** If the guest has a lead in status new, contacted or quoted for this hotel (or with no hotel set), set it to `booked` and link it to the new stay with `stay_id`. This is done by the service.
9. **Special requests**, if the booking carries them, are saved as a note linked to the stay, on first import only, so a re-import does not repeat them.

## Changing or cancelling a stay, and stays entered by hand

A changed booking updates the existing stay row; a cancelled booking is soft-deleted. The second is a stop-gap until stays get a status (see Open decisions).

- **Dates, room, guests or revenue change:** the import finds the stay by hotel and booking reference and updates those fields. `nights` recalculates itself. The audit columns record who changed it and when. The guest is not re-matched.
- **Booking moved to another hotel:** treat it as a cancellation at the old hotel and a new stay at the new one, because the reference is unique per hotel.
- **Cancelled booking:** set `deleted_at` on the stay. It disappears from views and guest counts, but stays in the table for history. The guest's lifecycle stage is **not** moved back automatically; the service should recalculate it (`stayed` or `repeat_guest` from the remaining stays, or back to `booked`/`lead` if none remain).
- **Stay entered by hand** (walk-in, owner's guest, or a booking system outage): same flow as an import, with `booking_reference` left blank. The import can attach the reference later; until then the merge rule treats it as "same hotel and same arrival date".

## After the stay: feedback and employee mentions

A returned feedback form becomes one `feedback` row on the stay, plus one `employee_mentions` row for each employee the guest names. Ratings of 1 or 2 are flagged for a manager to follow up.

1. **Find the stay.** The form should carry the booking reference or a stay link, so the feedback lands on the right visit. The guest and hotel come from the stay.
2. **Save the feedback** with `rating` (1 to 5), `review` (the guest's words) and `submitted_at`. A form with neither a rating nor a review is rejected, and a second form for the same stay is rejected too.
3. **Record employee mentions.** For each employee the guest praises or criticises, add a row with `sentiment` positive or negative and the guest's comment. If staff know who was meant, set `employee_id`. If not ("the waiter with glasses"), save `name_as_written` and link the employee later. The same employee can only be counted once per feedback.
4. **Low ratings.** `feedback_overview` marks ratings of 1 and 2 as `needs_follow_up`. The manager who calls the guest logs it as an interaction (call, WhatsApp or email), and any internal remark goes in a note on the stay.
5. **Reporting.** `property_ratings` gives each hotel's response count and average rating, overall and for the last 90 days. `employee_feedback_summary` gives each employee's praise and criticism counts.

## Leads: from first message to booked or lost

Every enquiry is its own `leads` row, moving new → contacted → quoted → booked, or to lost with a reason. One person can have several leads over time, and a repeat guest can have an open lead.

1. **An enquiry arrives** (website form, WhatsApp, Instagram, phone, email, agent, walk-in or OTA message). Find the person with the same email, then phone, rule as for stays. If there is no match, create a contact with `contact_type` lead and `lifecycle_stage` lead, plus `unknown` consent rows.
2. **Create the lead** with `source`, hotel, requested dates, adults and children, occasion, `owner_id` (the staff member following it up) and `follow_up_at`. Status starts at `new`.
3. **Work the lead.** Each call, WhatsApp or email is logged in `interactions` with `lead_id`, so the conversation history sits on the lead. Move the status to `contacted`, then `quoted` with `quoted_value` and currency. Internal remarks go in notes linked to the lead.
4. **It books.** When the booking arrives through the booking system, step 8 of the stay flow sets the lead to `booked` and links `stay_id`. Staff can also link it by hand.
5. **It is lost.** Set status `lost` and pick a `lost_reason` (price, dates unavailable, went elsewhere, no response, plans changed, other). The person stays in the CRM for future marketing, if they have consented.

## Contact details and consent

A person can have several emails and phones but only one primary of each. Marketing goes only to people who opted in, at their primary personal email. An opt-out always wins.

**Emails and phones (`contact_methods`)**

- Adding a detail: save it with `is_primary` false unless it is the first of its kind. The same value cannot be added twice to one person.
- Changing the primary: in one transaction, clear `is_primary` on the old one and set it on the new one. The database rejects two primaries of the same kind.
- Shared addresses (an agent's office, a family email): set `is_shared`. They are never used for marketing and never used to match people.
- Status: `valid` once checked, `unverified` until then, `bounced` when an email comes back, `invalid` when staff confirm it is wrong. Bounced and invalid emails drop off the marketing list.
- `is_whatsapp` is blank until someone confirms the number is on WhatsApp.

**Consent (`consents`)**

- One row per person per channel (email, WhatsApp), status `opted_in`, `opted_out`, `not_opted_in` or `unknown`.
- Every change records `source` (where permission was given), `evidence` (the wording shown) and `given_at` (when).
- `unknown` and `not_opted_in` both mean no marketing.
- **Do not contact:** setting a contact's `status` to `do_not_contact` makes a trigger switch all their consents to `opted_out`.
- **The marketing list** is the `marketing_email_list` view: active, not deleted, email opted in, primary email that is personal, not bounced and not invalid. Exports for campaigns should come from this view only.

## Where each kind of information goes

Staff pick the table by what they are recording, not by where they are in the app.

| Staff want to record | Table | Linked to | Example |
| --- | --- | --- | --- |
| Something a guest likes or dislikes | `preferences` | the guest, optionally the stay | Gluten free; loves the Walauwa Suite |
| Any other remark by staff | `notes` | a guest or company, optionally a stay or lead | Asked for late checkout; commission renegotiated |
| A conversation with a guest or agent | `interactions` | a guest or company, optionally a lead | WhatsApp: sent December rates |
| A birthday or anniversary | `special_dates` | the guest | Wedding anniversary, 3 Nov 2015 |
| A label for grouping | `tags` + `contact_tags` | the guest | VIP / industry; Friends & family |
| The reason for a trip | `occasion_id` on the stay or lead | the stay or lead | Honeymoon |

- A note given only a stay or lead automatically gets the guest filled in, so it shows on their profile.
- `interactions.staff_id` is who spoke to the guest; `created_by` is who logged it. They can differ.
- `upcoming_special_dates` lists occasions in the next 60 days, with years married or age turning when the year is known.

## Duplicates and merging

The database never merges people on its own. Staff review `possible_duplicates` (pairs sharing a name, a personal email or a phone; 201 pairs after the initial load) and decide. Two guests can share a name or a family phone.

When staff confirm a pair, the service calls `merge_contacts(keep_id, remove_id, 'optional note')`. In one all-or-nothing step it:

1. Saves a snapshot of the record being removed (details, emails, phones, consents, tags) in `contact_merges`, with who merged it and when.
2. Moves stays, notes, preferences, special dates, leads, interactions and data issues to the kept record. A stay both records share (same hotel and booking reference, or same hotel and arrival date when a reference is missing) is kept once; the copy's feedback and notes move to the surviving stay.
3. Moves emails and phones, drops exact duplicates and keeps the kept record's primaries.
4. Combines consent per channel, strictest first: opted out, then opted in, then not opted in, then unknown. An opt-out is never lost.
5. Combines tags, fills blank fields on the kept record without overwriting filled ones, recalculates the lifecycle stage from the combined stays, and carries over do-not-contact.
6. Deletes the duplicate.

There is no automatic undo yet. A wrong merge can be rebuilt by hand from the snapshot and the list of moved rows in `contact_merges`.

## Deleting and restoring

A "delete" button in the app sets `deleted_at`; "restore" sets it back to empty. The trigger fills and clears `deleted_by`.

- **Deleting a contact** hides them from every view but leaves their stays, notes and other rows untouched, so a restore brings everything back.
- **Deleting a child row** (a phone, a note, a stay) hides just that row. Because uniqueness ignores deleted rows, the same email or tag can be added again later.
- **Do not contact is not delete.** A guest who asks not to be contacted stays visible, with all marketing blocked. Delete is for junk, test and mistaken records.
- **Erasure requests** under data-protection law need more than a soft delete, because the details are still stored. A separate "anonymise" step is listed under Open decisions.

## Reference data

These tables feed the drop-downs. Admins maintain them; everyday users only pick from them.

| Table | Holds | Who changes it | Notes |
| --- | --- | --- | --- |
| `properties` | The 8 hotels (P01–P08) | Admin | Stafford Bungalow has no guests yet |
| `countries` | 249 ISO countries with dial codes | Rarely, admin | Contacts and companies store the 2-letter code |
| `occasions` | 12 trip reasons, with `sort_order` | Admin | Used by stays and leads |
| `companies` | Travel agents, DMCs, OTAs, corporates | Management | Linked to stays as the booking agent |
| `employees` | Everyone working at the hotels | Each hotel's manager | Set `is_active` false when someone leaves; their feedback stays |
| `staff_users` | People who log into the CRM, with a role | Admin | An employee who uses the CRM is linked through `staff_user_id` |

Retiring an option (a closed hotel, an occasion no longer used) is a soft delete or `is_active` false, never a hard delete, so old stays and leads keep their value.

## Ready-made views

The app's lists and reports should read from these views, which already hide deleted rows.

| View | Answers |
| --- | --- |
| `contact_overview` | One line per person: stage, primary email and phone, hotels, number of stays, last stay, email consent, tags |
| `marketing_email_list` | Who may receive marketing email right now (900 after the initial load) |
| `possible_duplicates` | Which pairs of contacts staff should review for merging |
| `upcoming_special_dates` | Whose birthday or anniversary falls in the next 60 days |
| `feedback_overview` | Every feedback response, newest first, with low ratings flagged |
| `property_ratings` | Each hotel's response count and average rating, overall and last 90 days |
| `employee_feedback` | Every guest comment about an employee, newest first |
| `employee_feedback_summary` | Each employee's praise and criticism counts, overall and last 90 days |
| `property_guest_counts` | Guests, stay rows and dated stays per hotel |

## Building it in NestJS + Drizzle

Drizzle Kit creates tables, indexes, foreign keys and check constraints, but not triggers or functions. If the tables were created from the Drizzle schema files alone, the automatic rules in this document do not exist yet and must be added in a custom migration.

**1. Check what the database already has**

```sql
select event_object_table, trigger_name from information_schema.triggers where trigger_schema = 'public';
select routine_name from information_schema.routines where routine_schema = 'public';
select table_name from information_schema.views where table_schema = 'public';
```

Expected: an audit trigger on all 19 normal tables and the 2 insert-only ones, plus `t_stays_lifecycle`, `t_contacts_dnc` and `t_notes_fill_contact`; the functions `current_staff_id`, `set_audit_columns`, `set_created_columns`, `bump_lifecycle_on_stay`, `do_not_contact_blocks_marketing`, `notes_fill_contact`, `same_stay` and `merge_contacts`; and the 9 views.

**2. Add what is missing** with `drizzle-kit generate --custom --name=crm_rules`, then paste the functions, triggers and views from `schema.sql` into that migration. Views can alternatively be declared with `pgView` so Drizzle can type them.

**3. Tell the database who is acting.** Wrap each request's writes in a transaction and set the staff id first. The third argument `true` keeps it local to that transaction, so it cannot leak to another request on the same pooled connection.

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`select set_config('app.staff_id', ${String(user.staffId)}, true)`);
  // ... the request's inserts and updates
});
```

A NestJS interceptor or a small `withStaff(user, fn)` helper keeps this in one place. Never write the `created_*`, `updated_*` or `deleted_by` columns from the app.

**4. Things Drizzle will not do for you**

- **Soft delete:** there is no global filter. Add `isNull(table.deletedAt)` in every repository query, or read from the views.
- **Upserting a booking:** the unique rule is partial, so the conflict target needs its condition: `onConflictDoUpdate({ target: [stays.propertyId, stays.bookingReference], targetWhere: sql\`booking\_reference is not null and deleted\_at is null\`, set: { ... } })\`.
- **Generated column:** `nights` is calculated by the database; never include it in inserts or updates.
- **Merging:** call the function, `tx.execute(sql\`select merge\_contacts(${keepId}, ${removeId}, ${note})\`)\`.

**5. Who does what**

| The database does it on its own | The NestJS service must do it |
| --- | --- |
| Stamp created, updated and deleted columns | Match a booking or enquiry to an existing guest (email, then phone) |
| Move a guest to stayed or repeat guest on a new stay | Split names, set country and market for a new guest |
| Switch all consents to opted out on do-not-contact | Record consent from a booking or check-in form |
| Fill a note's guest from its stay or lead | Close an open lead when its booking arrives |
| Reject duplicates, bad dates, bad ratings and values outside the pick-lists | Recalculate the lifecycle stage after a cancellation |
| Merge two contacts in one step | Switch a primary email or phone in one transaction |
| Calculate nights | Save booking special requests as a note on first import only |

## Open decisions

These change how the flows above behave and should be settled before the booking import is built.

- [ ] **Stay status.** Stays have no status today, so a future booking counts as "stayed" the moment it is imported, and a cancellation can only be a soft delete. Adding `status` (booked, checked in, checked out, cancelled, no-show) and counting only checked-out stays in the lifecycle trigger would fix both. It is also needed for pre-arrival preparations.
- [ ] **Booking remarks.** Does the booking system send special requests? If yes, store them in a `booking_remarks` field on the stay, which re-imports can overwrite, instead of a note.
- [ ] **Consent source as a pick-list.** `consents.source` is still free text; a fixed list (wix, website form, booking form, check-in form, WhatsApp, in person, other) would stop spelling variants.
- [ ] **Feedback form tracking.** To measure response rates, the CRM needs to record when a form was sent, not only when it came back.
- [ ] **Undo a merge.** An `unmerge_contacts` function would rebuild a wrongly merged guest from the merge log in one step.
- [ ] **Erasure requests.** An "anonymise" step that blanks a person's name and contact details while keeping stay counts, for data-protection requests.
- [ ] **Pre-arrival preparations.** Tasks per upcoming stay (transfer, room setup, celebration), each with an owner, due time and status.
