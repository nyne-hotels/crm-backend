# CRM Module 5 – Consent and Marketing List

Oct 21, 2026 · @Tehan

Build order: 5 of 8. The CRM knows who agreed to hear from Nyne, keeps proof of it, and hands marketing a clean list of only those people.

## Overview

This module records, for every guest and channel (email, WhatsApp), whether they agreed to marketing, where and when. It produces the only list marketing may send to, and makes sure an opt-out or a "don't contact me" is never lost.

**Who uses it**

- **Marketing:** exports the list, uploads bounce lists, records unsubscribes.
- **Management:** records a guest's yes or no at check-in or on the phone.
- **Management and admin:** same as marketing, plus clearing do-not-contact.

**Depends on:** Module 2 (guest profile). The booking tick box rule also needs Module 3.

**Starting point:** 902 guests opted in to email (from the website), 1 opted out, everyone else unknown. 900 of them are on the marketing list.

## Workflow

**Recording a yes or no** (at check-in, on the phone, on WhatsApp)

1. On the guest's profile, Consent panel, click **Change** next to Email or WhatsApp.
2. Pick Opted in or Opted out, where it was given (check-in form, booking form, website form, WhatsApp, in person, Wix, other), and the date. Type or paste the wording they agreed to, if there was one.
3. Save. The panel shows the new status with source and date.

**A guest unsubscribes** (replies "remove me", clicks unsubscribe in an email tool)

1. Marketing finds the guest and sets Email to Opted out, source "email unsubscribe".
2. For a batch, marketing uploads the email tool's unsubscribe list; the CRM opts out every matching email and lists any it could not match.

**A guest asks never to be contacted**

1. Staff click **Do not contact** on the profile and confirm.
2. Every channel switches to Opted out and a red banner shows on the profile. The guest disappears from the marketing list.

**Sending a campaign**

1. Marketing opens **Marketing → Email list**, narrows it (for example UK guests who stayed at Rock Villa), checks the count.
2. Clicks **Export** and imports the file into the email tool.

**After a campaign**

1. Marketing uploads the email tool's bounce list. Matching emails are marked Bounced and drop off the list.

## Screens and what users can do

**Consent panel on the guest profile**

- Two rows, Email and WhatsApp. Each shows a status chip (Opted in green, Opted out red, Not opted in grey, Unknown grey), where it was given, the date, and a "Change" button.
- Hover the chip to see the exact wording the guest agreed to.
- A small line under the panel: "On the marketing list" or the reason they are not (no opt-in, email bounced, do not contact, no personal email).

**Change consent dialog**

- Status (Opted in, Opted out), source (drop-down), date given (defaults to today), wording (optional text).

**Do not contact**

- A button in the profile's ⋯ menu: "Do not contact". The confirmation explains that all marketing stops.
- When on: a red banner across the profile, "Do not contact – requested 21 Oct 2026". Admins and management can clear it.

**Marketing → Email list**

- The total at the top ("900 guests can be emailed").
- Filters: market, country, hotel stayed at, stage (stayed, repeat guest, lead), last stay before or after a date, tag.
- Columns: name, email, country, stage, hotels, last stay.
- "Export" downloads a spreadsheet with first name, last name, email, country, last hotel. Each export is logged with who, when, filters and count.

**Marketing → Upload unsubscribes or bounces**

- Upload a file of emails, choose Unsubscribes or Bounces, preview matches, confirm. Shows how many were updated and which emails did not match anyone.

## Rules

**The latest explicit choice wins; silence changes nothing.**

| Current status | What happens | New status |
| --- | --- | --- |
| Opted out | Guest ticks a marketing box or says yes | Opted in |
| Opted out | A form without a tick, or no box | Stays opted out |
| Opted in | Guest unsubscribes or says no | Opted out |
| Opted in | A form without a tick | Stays opted in |
| Unknown or not opted in | Guest ticks or says yes | Opted in |

- Every change records the source, the date given and, where there is one, the wording.
- Unknown and Not opted in both mean no marketing.

**Do not contact**

- Switches every channel to Opted out at once.
- While it is on, an opt-in can still be recorded (the guest ticked a box), but the guest stays off the list and the profile shows "Opt-in received while on do not contact – confirm with guest". Only admin or management can clear it.

**Who is on the email list:** not deleted, not do-not-contact, email consent Opted in, and a primary email that is personal (not shared), not bounced and not marked wrong. All five, always. The export reads from this list only.

**Who can export:** Marketing, Management and Admin. Every export is logged.

**WhatsApp:** consent is recorded the same way. Bulk WhatsApp sending is not part of this module.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Turn consent source into a fixed list (Wix, website form, booking form, check-in form, WhatsApp, in person, email unsubscribe, other); map the existing "wix" values.
- [ ] Add a place to log marketing exports (who, when, filters, count).
- [ ] Consent panel on the guest profile, with the "on the list / not on the list because…" line.
- [ ] Change consent dialog applying the latest-choice-wins rules.
- [ ] Do not contact: set from the profile menu, banner, clear by admin or management only.
- [ ] Opt-in received while on do-not-contact: show the warning on the profile.
- [ ] Marketing → Email list page with filters and the live count.
- [ ] Export to spreadsheet, logged; limited to Marketing, Management, Admin.
- [ ] Upload unsubscribes and upload bounces, with preview and unmatched list.
- [ ] Booking import (Module 3) uses the same consent rules for the booking tick box.

## Done when

- The email list shows 900 guests before any changes.
- Setting a listed guest to Do not contact drops the count to 899 and both channels show Opted out.
- A guest who opted out and later ticks the box on a booking is opted in again, with source booking form and the booking date.
- Uploading a bounce file marks those emails Bounced and removes them from the list.
- A marketing user can export the list but cannot clear Do not contact.

## Later

- Connect directly to the email tool, so unsubscribes and bounces flow back without file uploads.
- A consent request email or WhatsApp message to the 5,000+ guests whose consent is unknown.
