# CRM Module 1 – Foundation: Sign-in, Roles and Settings

Oct 21, 2026 · @Tehan

Build order: 1 of 8. Everything else needs a signed-in staff member with a role, and the pick-lists this module manages.

## Overview

This module gives the CRM its front door and its settings: staff sign in, see only the menus their role allows, and every change they make is recorded against their name. It also lets an admin manage the hotels and the pick-lists other modules use.

**Who uses it**

- **Admin:** creates and deactivates staff users, edits hotels and pick-lists.
- **Management and Marketing:** sign in, sign out, change their own password.

**Depends on:** nothing. The database tables are already in place.

**In this module:** sign-in with a username and password (built on the Better Auth library), the app shell (navigation and top bar), staff users, roles, hotel settings, occasions, the country list for drop-downs, and the shared behaviour every later screen relies on (who-changed-what, soft delete).

## Workflow

1. **Admin adds a staff member:** first and last name, a username (for example nisha.silva), role, home hotel (or "All hotels") and a temporary password. Email is optional.
2. **Admin passes on the username and temporary password** in person or by message.
3. **First sign-in:** the staff member signs in with the temporary password and must choose their own password before going any further. They land on the home screen; until Module 2 is built, home is a simple welcome page.
4. **They work.** Every save quietly records who made it and when. Screens show "Last updated by Nisha Silva, 21 Oct 2026" where it helps.
5. **They forget their password.** They ask an admin, who sets a new temporary password. They choose a new one at their next sign-in.
6. **They delete something by mistake.** Deleting hides the record instead of erasing it; an admin can bring it back later.
7. **A staff member leaves.** The admin deactivates them. They are signed out everywhere at once and can no longer sign in, but their name stays on everything they did.

## Screens and what users can do

**Sign-in**

- Username and password fields and a "Sign in" button. No sign-up link. Under the button: "Forgot your password? Ask your admin."
- Wrong details show "Username or password is incorrect". A deactivated user sees "Your account is inactive. Ask an admin."
- After signing in with a temporary password, a "Choose a new password" screen appears before anything else.

**App shell (on every screen)**

- Left menu: Guests, Stays, Leads, Feedback, Reports, Settings. Each item appears only once its module is built and only for roles allowed to use it.
- Top bar: the Nyne logo, the signed-in person's name and role, and a menu with "Change password" and "Sign out".

**Settings → Staff users** (admin only)

- Table: name, username, role, home hotel, active or inactive, last sign-in. Search by name or username; filter by role and hotel.
- "Add staff user" opens a form: first name, last name, username, role (drop-down), home hotel (drop-down, includes "All hotels"), temporary password (with a "Generate" button), email (optional).
- Each row: Edit, Reset password (sets a new temporary password), Sign out everywhere, Deactivate or Reactivate.

**Settings → Hotels** (admin only)

- The 8 hotels with name, location, type and website. Edit opens a form; an "Active" switch hides a hotel from drop-downs without losing its history.

**Settings → Occasions** (admin only)

- The 12 trip reasons (Honeymoon, Birthday, Business trip …) in drop-down order. Add, rename, drag to reorder, retire.

**Country picker** (used by later screens)

- A searchable drop-down: type "sri" or "LK" and pick Sri Lanka. Shows the name and the dialling code.

## Rules

**Roles and what they can do.** There are three roles. All of them see all 8 hotels in the first version. "Edit" includes adding and deleting.

- **Admin:** everything, including Settings (staff users, hotels, occasions).
- **Management:** runs the hotels day to day: guests, stays, leads, agents, feedback, merging duplicates and the marketing export. No Settings.
- **Marketing:** sees everything guest-facing, changes only marketing consent, and exports the marketing list.

| Role | Guests | Stays | Leads & agents | Feedback | Marketing export | Merge guests | Settings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Admin | Edit | Edit | Edit | Edit | Yes | Yes | Edit |
| Management | Edit | Edit | Edit | Edit | Yes | Yes | — |
| Marketing | View, plus consent | View | View | View | Yes | — | — |

"Guests" includes their notes, preferences, special dates and tags.

**Sign-in**

- Sign-in uses the Better Auth library with username and password only. No public sign-up, no Google or Microsoft sign-in.
- Only an admin can create a staff user, and each staff user has one sign-in account.
- Usernames are unique and not case-sensitive: 3 to 30 characters, letters, numbers and dots.
- Passwords are at least 10 characters. A temporary password must be changed at the first sign-in after it is set.
- Repeated wrong attempts are slowed down: after 5 failures in a minute for a username, further tries are refused for a short while.
- Deactivating a user ends all their sessions at once. A session also ends after 12 hours without activity.
- Password resets are done by an admin, not by email.

**Who changed what**

- Every add, edit and delete records the signed-in person and the time automatically. Nobody types this in, and it cannot be edited.
- Changes made by the system (for example a scheduled booking import) show as "System".

**Deleting**

- Delete hides a record everywhere; it is never erased. Lists, searches and reports never show deleted records.
- Pick-list items (hotels, occasions) are retired with an "Active" switch rather than deleted, so old records keep their value.

## Tasks

In build order. The technical details are in Nyne CRM – How the Database Operates.

- [ ] Check the database has its automatic rules installed (who-changed-what, lifecycle, merge, views) and add any that are missing.
- [ ] Set up Better Auth with username and password sign-in only, public sign-up turned off, and its admin features for creating users, setting roles, deactivating and ending sessions.
- [ ] Add Better Auth's own tables to the database and link each staff user to their sign-in account.
- [ ] Connect Better Auth to NestJS so every page requires sign-in unless marked public.
- [ ] Make every request tell the database which staff member is acting, so who-changed-what fills itself in.
- [ ] Sign-in screen, sign-out, session ends after 12 hours of inactivity.
- [ ] Forced password change after a temporary password; change password from the top bar.
- [ ] Slow down repeated wrong sign-in attempts; block deactivated users and end their sessions.
- [ ] App shell: left menu and top bar, menu items shown by role.
- [ ] Role checks on every action, not just hidden menu items.
- [ ] Settings → Staff users: list, search, filter, add with a temporary password, edit, reset password, sign out everywhere, deactivate, reactivate.
- [ ] Settings → Hotels: list, edit, active switch.
- [ ] Settings → Occasions: list, add, rename, reorder, retire.
- [ ] Country picker component, searchable by name or code.
- [ ] Shared "Last updated by …" line and shared delete behaviour for later screens.
- [ ] Create the first admin account (Tehan) during setup.

## Done when

- An admin creates a management user with a temporary password; the user signs in, is made to choose a new password, and lands on the home screen.
- The management user cannot see Settings, and is refused if they open a Settings address directly.
- After an admin resets a password, the old one stops working and the user must choose a new one at sign-in.
- Renaming an occasion shows "Last updated by" with the admin's name.
- A deactivated user is signed out at once and cannot sign back in.

## Later

- Password reset by email, for staff who have a work email.
- Sign in with Google or Microsoft.
- Limiting staff to their own hotel's guests and stays.
- A "Deleted items" screen for admins to restore records.
