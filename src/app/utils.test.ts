import { describe, expect, it } from 'vitest';
import { emptyState } from '../shared/defaults';
import type { Entry } from '../shared/types';
import { createBackup, createCsv, makeCloze, safeUrl } from './utils';

const entry: Entry = {
  id: 'test-entry', term: 'bind', type: 'word', phonetic: '', partOfSpeech: 'verb',
  meaning: '绑定', context: 'Use bind to set this.', contextTranslation: '使用 bind 设置 this。',
  example: { en: 'Use bind to set this.', zh: '使用 bind 设置 this。' }, technicalNote: '',
  source: { title: 'Reference', url: 'https://example.com/' }, createdAt: 1, updatedAt: 1,
  nextReviewAt: 1, interval: 0, streak: 0, reviewCount: 0, lastReviewedAt: null,
  status: 'learning', favorite: false,
};

describe('learning tools', () => {
  it('omits API keys from JSON backups without mutating settings', () => {
    const state = emptyState(); state.settings.apiKey = 'a-private-test-value';
    expect(JSON.stringify(createBackup(state))).not.toContain('a-private-test-value');
    expect(createBackup(state).settings).not.toHaveProperty('apiKey');
    expect(state.settings.apiKey).toBe('a-private-test-value');
  });
  it('neutralizes spreadsheet formulas and correctly quotes CSV text', () => {
    const csv = createCsv([{ ...entry, term: '=1+1', meaning: '含"引号",内容', context: '  @SUM(1)' }]);
    expect(csv).toContain("\"'=1+1\"");
    expect(csv).toContain('"含""引号"",内容"');
    expect(csv).toContain("\"'  @SUM(1)\"");
  });
  it('blanks a whole word, not a substring in another word', () => {
    const cloze = makeCloze({ ...entry, example: { en: 'Rebinding is different; use bind here.', zh: '' } });
    expect(cloze).toEqual({ before: 'Rebinding is different; use ', after: ' here.', answer: 'bind' });
  });
  it('handles regex characters and case in technical vocabulary', () => {
    expect(makeCloze({ ...entry, term: 'C++', example: { en: 'Use c++ for this.', zh: '' } })?.answer).toBe('c++');
  });
  it('omits missing or sentence-sized cloze questions', () => {
    expect(makeCloze({ ...entry, term: 'absent' })).toBeNull();
    expect(makeCloze({ ...entry, type: 'sentence' })).toBeNull();
  });
  it('refuses active and malformed source URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,test')).toBeUndefined();
    expect(safeUrl('https://example.com')).toBe('https://example.com/');
  });
});
