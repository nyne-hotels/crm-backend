# CRM Module 7 – Sales: Leads, Interactions and Travel Agents

Oct 21, 2026 · @Tehan

Build order: 7 of 8. Every enquiry is followed through to a booking or a reason it was lost, and every travel agent relationship has one place.

## Overview

This module turns enquiries into bookings. Each enquiry is a lead with an owner and a follow-up date, every conversation is logged against it, and it ends as booked or lost with a reason. It also gives travel agents and DMCs a profile of their own: the people there, the guests they sent, and every conversation with them.

**Who uses it**

- **Management:** creates and works leads, logs calls and messages, manages agents, and sees conversion and lost reasons.
- **Marketing:** sees leads and agents (view only).

**Depends on:** Module 2 (guest profile). Automatic conversion to a stay needs Module 3.

**Starting point:** no leads yet. 45 travel agencies from the 2026 B2B list, with 56 contact people.

## Workflow

_(Diagram: lead statuses — New → Contacted → Quoted → Booked; any open status can move to Lost, which needs a reason and can be reopened.)_

A lead moves left to right as the conversation progresses and can drop to Lost from any open status.

**From enquiry to booking**

1. **An enquiry comes in** by website form, WhatsApp, Instagram, phone, email, an agent, a walk-in or an OTA message. A management user clicks **New lead**.
2. **Find or create the person.** Search by name, email or phone; if they are new, add them on the same form. A new person becomes a contact at stage "lead"; an existing guest keeps their stage.
3. **Fill in the request:** hotel, dates, adults and children, occasion, and any budget or details in a note. Assign an owner (defaults to yourself) and a follow-up date. The lead starts as **New**.
4. **Reply and log it.** Every call, WhatsApp, email or meeting is logged on the lead with a short summary. The first logged reply moves it to **Contacted**.
5. **Send a quote.** Enter the quoted amount and currency; the lead moves to **Quoted**. Set the next follow-up date.
6. **It books.** When the booking is imported (Module 3), the lead is marked **Booked** and linked to the stay automatically. Staff can also link it by hand.
7. **It doesn't book.** Mark it **Lost** and choose why: price, dates unavailable, went elsewhere, no response, plans changed, other.

**Every morning**

1. Each salesperson opens **My follow-ups**: their leads due today and overdue, oldest first.

**Working with travel agents**

1. Open **Companies**, find the agency, see its people, the stays it booked and the last conversation.
2. Log a sales visit or call against the company, update commission terms, add a note.
3. When a booking arrives through that agent, it shows on the agency's profile.

## Screens and what users can do

**Leads (board and list)**

- Board view: five columns, New, Contacted, Quoted, Booked, Lost. Each card shows the person, hotel, dates, owner, follow-up date (red when overdue) and source icon. Drag a card to move it.
- List view: the same leads as a table, with filters for owner, hotel, source, status and follow-up due.
- "New lead" button, top right.

**Lead detail**

- Left: the person (link to their profile), request details (hotel, dates, guests, occasion), status, owner, follow-up date, quoted amount, linked stay.
- Right: one timeline of everything on the lead, newest first: logged calls and messages, notes, status changes.
- Buttons: Log call, Log WhatsApp, Log email, Add note, Change status, Link stay, Mark lost.

**New lead form**

- Person (search, or add new with name, email, phone, country), source, hotel, check-in and check-out, adults, children, occasion, owner, follow-up date, first note.

**My follow-ups**

- The signed-in person's open leads due today or overdue, oldest first, with one-click "Log call" and "Snooze to tomorrow".

**Leads panel on the guest profile**

- The person's leads, newest first, with status chips.

**Companies (list)**

- Name, type (travel agent, inbound DMC, outbound agent, OTA, corporate, media), country, account owner, status (active, prospect, dormant), stays booked in the last 12 months, last contact date.

**Company profile**

- Details and commission terms; the people who work there (links to their profiles); stays booked through them; a timeline of interactions and notes; buttons Log interaction, Add note, Add person, Edit.

## Rules

**Lead statuses**

- A lead moves New → Contacted → Quoted → Booked, or to Lost from any open status. Staff may skip a step (a walk-in can go straight to Booked).
- **Lost** needs a reason. **Booked** needs a linked stay, except when marked by hand while the stay is still being entered; the lead then shows "stay to link".
- A Lost lead can be reopened to New, Contacted or Quoted if the person comes back.
- Open leads (New, Contacted, Quoted) need an owner and a follow-up date.
- Moving to Quoted asks for the quoted amount and currency.

**The person's stage**

- A person at stage "lead" moves to "enquired" when their first lead is created. Guests who have stayed keep their stage.
- When a lead is booked, the stage then follows the stay (Module 3).

**Automatic conversion**

- When a booking is imported for a person with an open lead at the same hotel (or a lead with no hotel), that lead becomes Booked and is linked to the new stay. If they have several open leads, the one with the closest dates is chosen.

**Interactions**

- Each one is a call, WhatsApp, email, meeting, visit or Instagram DM, inbound or outbound, with a date, the staff member who had the conversation, and a short summary.
- It belongs to a person, a company, or both, and optionally to a lead.

**Companies**

- Company names are unique. A person can belong to one company.
- A stay booked through an agent is linked to that company, so the agency's profile shows its bookings.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] New lead form, including finding or adding the person; stage moves to "enquired" for new people.
- [ ] Leads list view with filters.
- [ ] Leads board view with drag to change status, applying the status rules.
- [ ] Lead detail with the combined timeline of interactions, notes and status changes.
- [ ] Log call, WhatsApp, email, meeting, visit or Instagram DM on a lead or a person.
- [ ] Mark lost with reason; reopen; link a stay by hand.
- [ ] Automatic conversion when a booking is imported (hook into Module 3's import).
- [ ] My follow-ups page with snooze.
- [ ] Leads panel on the guest profile.
- [ ] Companies list and company profile: people, stays booked, timeline, edit, add person.
- [ ] Agent drop-down on the stay form (Module 3) using companies.
- [ ] Role checks: Management and Admin edit; Marketing views only.

## Done when

- A WhatsApp enquiry from a new person creates a contact at stage "enquired" and a New lead owned by the creator.
- Logging the first reply moves the lead to Contacted; entering a quote moves it to Quoted.
- Importing that person's booking at the same hotel marks the lead Booked and links the stay.
- Marking a lead Lost without a reason is refused.
- An overdue follow-up shows in red on the board and at the top of My follow-ups.
- Relax Lanka Tours' profile shows its people and every stay booked through it.

## Later

- Website and WhatsApp enquiries creating leads automatically.
- A sales report: leads by source, conversion rate, lost reasons, average time to book.
