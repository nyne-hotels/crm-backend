import {
  formatPhone,
  initialStage,
  marketForCountry,
  matchKey,
  searchTerms,
  stageAfterTypeChange,
} from './guest-rules.js';

describe('formatPhone', () => {
  it('saves numbers in the international form of the imported list', () => {
    expect(formatPhone('0771234567', 'LK')).toBe('+94 77 123 4567');
    expect(formatPhone('77 123 4567', 'LK')).toBe('+94 77 123 4567');
    expect(formatPhone('+966541488817')).toBe('+966 54 148 8817');
    expect(formatPhone('+44 7935 493395')).toBe('+44 7935 493395');
  });

  it('lets a typed +code win over the picked country', () => {
    expect(formatPhone('+966 54 148 8817', 'LK')).toBe('+966 54 148 8817');
  });

  it('refuses things that are not phone numbers', () => {
    expect(formatPhone('12', 'LK')).toBeNull();
    expect(formatPhone('hello')).toBeNull();
    expect(formatPhone('0771234567')).toBeNull(); // no country to read it in
    expect(formatPhone('0771234567', 'XX')).toBeNull();
  });
});

describe('matchKey', () => {
  it('ignores case and spaces', () => {
    expect(matchKey('email', ' AhmedDaoud.1985@Gmail.com ')).toBe('ahmeddaoud.1985@gmail.com');
    expect(matchKey('phone', '+966 54 148 8817')).toBe(matchKey('phone', '+966541488817'));
  });
});

describe('marketForCountry', () => {
  it('follows the country', () => {
    expect(marketForCountry('LK')).toBe('local');
    expect(marketForCountry('GB')).toBe('foreign');
    expect(marketForCountry(null)).toBe('unknown');
  });
});

describe('stages and types', () => {
  it('starts agent contacts and influencers on their own stage, everyone else as a lead', () => {
    expect(initialStage('guest')).toBe('lead');
    expect(initialStage('lead')).toBe('lead');
    expect(initialStage('agent_contact')).toBe('agent_contact');
    expect(initialStage('influencer')).toBe('influencer');
  });

  it('only moves the stage when the type crosses into or out of agent contact / influencer', () => {
    expect(stageAfterTypeChange('repeat_guest', 'lead', 3)).toBeUndefined();
    expect(stageAfterTypeChange('stayed', 'agent_contact', 1)).toBe('agent_contact');
    expect(stageAfterTypeChange('agent_contact', 'agent_contact', 0)).toBeUndefined();
    expect(stageAfterTypeChange('agent_contact', 'guest', 0)).toBe('lead');
    expect(stageAfterTypeChange('influencer', 'guest', 1)).toBe('stayed');
    expect(stageAfterTypeChange('influencer', 'guest', 2)).toBe('repeat_guest');
  });
});

describe('searchTerms', () => {
  it('splits names into words', () => {
    expect(searchTerms('  ahmed   daoud ')).toEqual({ text: 'ahmed daoud', words: ['ahmed', 'daoud'], phoneDigits: [] });
  });

  it('reads phone-like text as digits', () => {
    expect(searchTerms('+966 54').phoneDigits).toEqual(['96654']);
    expect(searchTerms('077 123').phoneDigits).toEqual(['077123', '77123']);
    expect(searchTerms('12').phoneDigits).toEqual([]);
    expect(searchTerms('daoud 54').phoneDigits).toEqual([]);
  });
});
