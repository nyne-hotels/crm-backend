import type { STAFF_ROLES } from '../db/schema/index.js';

export type StaffRole = (typeof STAFF_ROLES)[number];

// What each role may do in each area of the CRM (Module 1 → "Roles and what they can do").
// 'edit' includes adding and deleting, and implies 'view'.
export type Access = 'edit' | 'view' | 'none';

export const AREAS = [
  'guests', // includes notes, preferences, special dates and tags
  'guestConsent', // marketing consent on a guest, marking do not contact, unsubscribe and bounce uploads
  'clearDoNotContact', // taking a guest off do not contact
  'stays',
  'leads', // leads and travel agents
  'feedback', // guest feedback, follow-ups and hotel ratings
  'employees', // the employee list and what guests said about named employees (Module 8)
  'marketingExport',
  'mergeGuests',
  'settings',
] as const;
export type Area = (typeof AREAS)[number];

export type Permissions = Record<Area, Access>;

const all = (access: Access): Permissions =>
  Object.fromEntries(AREAS.map((a) => [a, access])) as Permissions;

export const ROLE_PERMISSIONS: Record<StaffRole, Permissions> = {
  admin: all('edit'),
  // runs the hotels day to day: guests, stays, leads, feedback, merging, exports
  management: { ...all('edit'), settings: 'none' },
  // reads everything guest-facing; changes only consent (but can't clear do not contact),
  // and exports the marketing list. Praise and criticism of named employees is
  // for management and admin only.
  marketing: {
    ...all('view'),
    guestConsent: 'edit',
    clearDoNotContact: 'none',
    employees: 'none',
    marketingExport: 'edit',
    mergeGuests: 'none',
    settings: 'none',
  },
};

export function can(role: StaffRole, area: Area, needed: Exclude<Access, 'none'>): boolean {
  const access = ROLE_PERMISSIONS[role][area];
  return access === 'edit' || (needed === 'view' && access === 'view');
}

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: 'Admin',
  management: 'Management',
  marketing: 'Marketing',
};
