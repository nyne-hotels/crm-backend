# CRM Module 3 – Stays and Booking Import

Oct 21, 2026 · @Tehan

Build order: 3 of 8, completing the first release. Every visit to the 8 hotels is recorded against the guest, by hand or from the booking system.

## Decision needed before building

Stays have no status yet, so a booking for next March would mark the guest as "stayed" the day it is imported, and a cancellation can only be hidden. This module is written assuming a status is added first: **Booked → Checked in → Checked out**, or **Cancelled** or **No-show**. Only checked-out stays count towards stayed and repeat guest. If the status is not added, drop the status parts below and accept that future bookings count as stays.

Two more questions for the booking system: how bookings come out of it (a file export or a live connection), and whether each booking carries special requests and a marketing tick box. This doc plans for a file upload first, with a live connection later.

## Overview

This module records stays: who came, to which hotel, when, in which room, how they booked and why they came. With it, the guest profile shows each guest's full history and the CRM knows who is a repeat guest.

**Who uses it**

- **Management:** imports the booking file, fixes import errors, adds walk-ins, edits and cancels stays, and checks guests in and out.
- **Everyone:** sees stays on the guest profile and in the stays list.

**Depends on:** Module 1 (sign-in, hotels, occasions) and Module 2 (guest profile, adding guests).

**In this module:** stays list, stay detail, adding a stay by hand, booking file import with guest matching, check-in and check-out, cancelling, the Stays panel on the guest profile.

## Workflow

**Importing bookings** (management, daily or weekly)

1. Export the bookings from the booking system as a spreadsheet file.
2. In the CRM, open **Stays → Import bookings**, upload the file and match its columns to the CRM's fields the first time (the CRM remembers the matching).
3. The CRM checks every row and shows a preview before saving anything. Each row is marked: new stay for an existing guest, new stay and new guest, update to a stay already in the CRM, or error.
4. Staff fix or skip error rows, then click **Import**.
5. A summary shows how many stays were added, updated and skipped, and lists the new guests created so they can be checked.

The matching steps are drawn in Nyne CRM – How the Database Operates (Recording a stay).

**Adding a stay by hand** (walk-in, owner's guest, booking system down)

1. From the guest's profile or the stays list, click **Add stay**.
2. Pick the guest (or create one), the hotel, dates, room type, guests, channel and occasion. The booking reference is optional.
3. Save. The stay appears on the guest's profile.

**During and after the stay**

1. Staff mark the stay **Checked in** on arrival and **Checked out** on departure.
2. On check-out the guest's stage moves to stayed, or repeat guest if they have stayed before.

**Changes and cancellations**

1. A changed booking arrives in the next import and updates the existing stay.
2. A cancelled booking is marked **Cancelled** (by the import or by hand, with a reason). It stays on the profile, struck through, and no longer counts.

## Screens and what users can do

**Stays (list)**

- Quick filters across the top: Arriving today, In house, Departing today, Arriving this week.
- Filters: hotel, status, arrival date range, channel, occasion, agent.
- Columns: guest name, hotel, status chip, arrival, departure, nights, room type, adults and children, channel, agent, booking reference.
- "Add stay" and "Import bookings" buttons, top right.

**Stay detail** (opens as a side panel from the list or the profile)

- All the stay's details, a link to the guest, and "Last updated by".
- Buttons by status: Check in, Check out, Mark no-show, Cancel (asks for a reason), Edit.

**Add / edit stay form**

- Guest (search, or "New guest"), hotel, arrival and departure dates (nights shown as you pick), booking reference (optional), room type, adults, children, room revenue and currency, channel, agent or OTA (drop-down of companies once Module 7 exists; until then left blank), occasion (drop-down).

**Import bookings**

- Step 1, Upload: drop a spreadsheet file; pick the hotel if the file is for one hotel only.
- Step 2, Match columns: each column in the file is paired with a CRM field; saved for next time.
- Step 3, Preview: one row per booking with its outcome (New guest + stay, Existing guest + stay, Update, Error) and the reason for any error. Filter by outcome; skip rows; open the matched guest to check.
- Step 4, Result: counts added, updated, skipped; list of new guests created; download the error rows.
- Import history: date, file name, who imported, counts.

**Stays panel on the guest profile**

- Totals at the top: number of stays, nights, hotels visited, last stay.
- Stays newest first: hotel, dates, room, occasion, status. Cancelled stays shown struck through. Click to open the stay detail.

## Rules

**Booking reference**

- A booking reference can appear only once per hotel. If an import row has a reference the CRM already has for that hotel, it updates that stay instead of adding a new one, so re-importing the same file is safe.
- A booking moved to a different hotel is treated as a cancellation at the old hotel and a new stay at the new one.
- Stays added by hand may leave the reference blank; a later import can fill it in.

**Finding the guest for an imported booking**

1. Same email as an existing guest (ignoring case and shared addresses).
2. Otherwise, same phone number (ignoring shared numbers).
3. Otherwise, create a new guest from the booking's name, email, phone and country.

Never match on name alone. A booking for an existing guest adds any new email or phone to them but does not change their name or primary details.

**Dates and numbers**

- Departure cannot be before arrival. Nights are worked out automatically.
- Room revenue needs a currency.

**Guest stage**

- A checked-out stay moves the guest to stayed; a second one makes them repeat guest. Booked, cancelled and no-show stays do not count.
- Cancelling the stay that made someone a repeat guest moves them back to stayed.

**Consent tick box** (if the booking file has one)

- Ticked: set email consent to opted in, recording "booking form" and the booking date, even if they had opted out before.
- Not ticked, or no column: leave consent unchanged.
- Do-not-contact guests stay blocked and are listed in the import summary for staff to confirm.

**Special requests** (if the booking file has them)

- Saved on the stay as booking remarks and shown on the stay detail. A re-import overwrites them; staff notes are kept separately (Module 4).

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Add a status to stays (booked, checked in, checked out, cancelled, no-show) and a booking remarks field; existing 4,657 stays become checked out.
- [ ] Change the automatic stage rule so only checked-out stays count, and recalculate the stage when a stay is cancelled.
- [ ] Stays panel on the guest profile: totals and stays newest first.
- [ ] Stays list with the quick filters, filters and columns above.
- [ ] Stay detail side panel with Check in, Check out, No-show, Cancel (with reason) and Edit.
- [ ] Add and edit stay form, including creating a new guest from the form.
- [ ] Import step 1: upload a spreadsheet file.
- [ ] Import step 2: match columns to fields, remembered for next time.
- [ ] Import step 3: preview each row's outcome using the booking reference and guest matching rules, without saving.
- [ ] Import step 4: save in one go, show the summary, download error rows.
- [ ] Import history list.
- [ ] Consent tick box and special requests handling, if the booking file has them.
- [ ] Role checks: only Management and Admin can add, edit or import; Marketing views.

## Done when

- Importing the same file twice adds the stays once; the second run reports them all as updates.
- A booking with Ahmed Daoud's email lands on his existing profile, not a new guest.
- A booking with a new email and phone creates a guest, listed in the import summary.
- A guest with one checked-out stay is "stayed"; checking out a second stay makes them "repeat guest"; cancelling it moves them back.
- A future booking does not change the guest's stage until check-out.

## Later

- A live connection to the booking system so bookings arrive automatically, replacing the file upload.
- Pre-arrival preparations for upcoming stays (transfers, room setup, celebrations).
