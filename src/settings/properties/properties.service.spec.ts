import { createPropertySchema, nextPropertyId } from './properties.service.js';

describe('new hotel ids', () => {
  it('follows the highest P-number', () => {
    expect(nextPropertyId(['P01', 'P02', 'P11', 'P09'])).toBe('P12');
  });

  it('starts at P01 with no hotels', () => {
    expect(nextPropertyId([])).toBe('P01');
  });

  it('keeps two digits, then grows past them', () => {
    expect(nextPropertyId(['P08'])).toBe('P09');
    expect(nextPropertyId(['P99'])).toBe('P100');
  });

  it('ignores ids that are not P-numbers', () => {
    expect(nextPropertyId(['P03', 'HQ', 'P1X'])).toBe('P04');
  });
});

describe('new hotel input', () => {
  it('needs a name and blanks the rest', () => {
    expect(createPropertySchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(createPropertySchema.parse({ name: ' Nyne Galle ', location: '', webUrl: '' })).toEqual({
      name: 'Nyne Galle',
      location: null,
      webUrl: null,
    });
  });
});
