import { can, ROLE_PERMISSIONS } from './permissions.js';

// The table in Module 1 → "Roles and what they can do".
describe('role permissions', () => {
  const table = {
    admin: ['edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit'],
    management: ['edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'edit', 'none'],
    marketing: ['view', 'edit', 'none', 'view', 'view', 'view', 'none', 'edit', 'view', 'none', 'none'],
  } as const;
  const areas = [
    'guests',
    'guestConsent',
    'clearDoNotContact',
    'stays',
    'leads',
    'feedback',
    'employees',
    'marketingExport',
    'campaigns',
    'mergeGuests',
    'settings',
  ] as const;

  for (const [role, row] of Object.entries(table)) {
    it(`matches the table for ${role}`, () => {
      const perms = ROLE_PERMISSIONS[role as keyof typeof table];
      expect(areas.map((a) => perms[a])).toEqual(row);
    });
  }

  it('treats edit as including view, and none as neither', () => {
    expect(can('admin', 'settings', 'view')).toBe(true);
    expect(can('marketing', 'guests', 'view')).toBe(true);
    expect(can('marketing', 'guests', 'edit')).toBe(false);
    expect(can('management', 'settings', 'view')).toBe(false);
    expect(can('marketing', 'feedback', 'view')).toBe(true);
    expect(can('marketing', 'employees', 'view')).toBe(false);
  });
});
