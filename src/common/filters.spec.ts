import { z } from 'zod';
import { anyOf, ids } from './filters.js';

describe('a filter with several values', () => {
  const stage = anyOf(z.enum(['stayed', 'repeat_guest', 'lead']));

  it('reads a comma-separated list, a repeated key, or one value as older links have', () => {
    expect(stage.parse('stayed,repeat_guest')).toEqual(['stayed', 'repeat_guest']);
    expect(stage.parse(['stayed', 'lead'])).toEqual(['stayed', 'lead']);
    expect(stage.parse('lead')).toEqual(['lead']);
  });

  it('ignores blanks and repeats, and treats an empty filter as none', () => {
    expect(stage.parse(' stayed, ,stayed,')).toEqual(['stayed']);
    expect(stage.parse('')).toBeUndefined();
    expect(stage.parse(undefined)).toBeUndefined();
  });

  it('checks every value', () => {
    expect(stage.safeParse('stayed,vip').success).toBe(false);
    expect(ids.parse('3,12')).toEqual([3, 12]);
    expect(ids.safeParse('3,x').success).toBe(false);
  });
});
