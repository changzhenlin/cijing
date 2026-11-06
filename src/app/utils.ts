import type { AppState, Entry } from '../shared/types';

export const TYPE_LABELS = { word: '单词', phrase: '短语', sentence: '长句' };
export function dayKey(time = Date.now()) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dueEntries(state: AppState) {
  return state.entries.filter(entry => entry.status === 'learning' && entry.nextReviewAt <= Date.now())
    .sort((a, b) => a.nextReviewAt - b.nextReviewAt);
}
export function todayCount(state: AppState) {
  return new Set(state.reviews.filter(review => dayKey(review.at) === dayKey()).map(review => review.entryId)).size;
}
export function dateLabel(time: number) {
  return new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
export function sourceHost(entry: Entry) {
  try { return new URL(entry.source.url).hostname.replace(/^www\./, ''); } catch { return '手动导入'; }
}
export function safeUrl(value: string) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function createBackup(state: AppState) {
  const { apiKey: _key, ...settings } = state.settings;
  return { ...state, settings, exportedAt: new Date().toISOString() };
}
export function exportJson(state: AppState) {
  download(`wordnest-${dayKey()}.json`, JSON.stringify(createBackup(state), null, 2), 'application/json');
}
export function createCsv(entries: Entry[]) {
  const quote = (value: string) => `"${(/^[\s]*[=+\-@\t\r]/.test(value) ? "'" : '') + value.replace(/"/g, '""')}"`;
  const rows = [
    ['内容', '类型', '释义', '原句', '原句翻译', '英文例句', '例句翻译', '技术含义', '来源', '状态'],
    ...entries.map(entry => [
      entry.term, TYPE_LABELS[entry.type], entry.meaning, entry.context, entry.contextTranslation,
      entry.example.en, entry.example.zh, entry.technicalNote, entry.source.url,
      entry.status === 'mastered' ? '已掌握' : '学习中',
    ]),
  ];
  return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n');
}
export function exportCsv(entries: Entry[]) {
  download(`wordnest-${dayKey()}.csv`, createCsv(entries), 'text/csv;charset=utf-8');
}
export function speak(text: string) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 0.88;
  speechSynthesis.speak(utterance);
}
export function makeCloze(entry: Entry) {
  const sentence = entry.example.en || entry.context;
  if (!sentence || entry.type === 'sentence') return null;
  const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, 'i');
  const match = sentence.match(expression);
  if (!match) return null;
  return { before: sentence.slice(0, match.index), after: sentence.slice((match.index || 0) + match[0].length), answer: match[0] };
}
