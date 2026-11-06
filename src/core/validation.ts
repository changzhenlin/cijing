import { DEFAULT_SETTINGS, emptyState } from '../shared/defaults';
import type {
  Analysis, AnalyzePayload, AppState, Entry, Request, ReviewLog, Settings, Source, Story,
} from '../shared/types';
import { CoreError } from './errors';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const ANALYSIS_KEYS = [
  'term', 'type', 'phonetic', 'partOfSpeech', 'meaning', 'contextTranslation',
  'example', 'technicalNote', 'sentenceAnalysis',
];
const ENTRY_KEYS = [
  ...ANALYSIS_KEYS, 'id', 'context', 'source', 'createdAt', 'updatedAt', 'nextReviewAt',
  'interval', 'streak', 'reviewCount', 'lastReviewedAt', 'status', 'favorite',
];
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const MAX_DATE = 8_640_000_000_000_000;

function invalid(): never {
  throw new CoreError('数据格式无效，请检查输入或导入文件。');
}

// Validate JSON without invoking getters, accepting inherited fields, or copying poisoned keys.
export function assertJson(value: unknown): void {
  let nodes = 0;
  const seen = new WeakSet<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 500_000 || depth > 24) invalid();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.length > 2_000_000) invalid();
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid();
      return;
    }
    if (typeof item !== 'object' || seen.has(item)) invalid();
    seen.add(item);
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) invalid();
    if (Object.getOwnPropertySymbols(item).length) invalid();
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (FORBIDDEN.has(key) || !('value' in descriptor)) invalid();
      if (Array.isArray(item) && key === 'length') continue;
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

export function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some(key => !allowed.includes(key))) invalid();
}

export function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max) invalid();
  const result = value.trim();
  if (!allowEmpty && !result) invalid();
  return result;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function number(value: unknown, min: number, max: number, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isSafeInteger(value))) invalid();
  return value;
}

export function identifier(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(result) || FORBIDDEN.has(result)) invalid();
  return result;
}

export function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function entryKey(entry: Pick<Entry, 'term' | 'context'>): string {
  return JSON.stringify([normalize(entry.term), normalize(entry.context)]);
}

export function apiUrl(value: unknown): string {
  const input = text(value, 2048);
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.hash || url.search) {
    throw new CoreError('API 地址必须使用 HTTPS；仅本机 localhost 可使用 HTTP，且不能包含账号、查询参数或片段。');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseModelId(value: unknown, allowEmpty = false): string {
  const model = text(value, 120, allowEmpty);
  if (model && !/^[\w][\w./:-]*$/u.test(model)) invalid();
  return model;
}

export function parseSettings(value: unknown, options: { allowEmptyModel?: boolean } = {}): Settings {
  assertJson(value);
  const record = object(value);
  onlyKeys(record, SETTINGS_KEYS);
  const apiKey = text(record.apiKey, 4096, true);
  const model = parseModelId(record.model, options.allowEmptyModel);
  if (/[\u0000-\u001f\u007f]/u.test(apiKey)) invalid();
  if (record.apiStyle !== 'openai' && record.apiStyle !== 'anthropic') invalid();
  if (record.selectionMode !== 'auto' && record.selectionMode !== 'button') invalid();
  return {
    apiStyle: record.apiStyle, apiBaseUrl: apiUrl(record.apiBaseUrl), apiKey, model,
    enabled: bool(record.enabled), autoSave: bool(record.autoSave),
    selectionMode: record.selectionMode, technicalPriority: bool(record.technicalPriority),
    dailyGoal: number(record.dailyGoal, 1, 100),
    masteryTarget: number(record.masteryTarget, 3, 6),
  };
}

export function parseSource(value: unknown): Source {
  const record = object(value);
  onlyKeys(record, ['title', 'url']);
  const url = text(record.url, 4096);
  let parsed: URL;
  try { parsed = new URL(url); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid();
  return { title: text(record.title, 500, true), url: parsed.href };
}

export function parsePayload(value: unknown): AnalyzePayload {
  const record = object(value);
  onlyKeys(record, ['text', 'context', 'source']);
  const selected = text(record.text, 1200);
  return {
    text: selected,
    context: text(record.context, 12_000, true) || selected,
    source: parseSource(record.source),
  };
}

function analysisFields(record: Record<string, unknown>): Analysis {
  if (!['word', 'phrase', 'sentence'].includes(String(record.type))) invalid();
  const example = object(record.example);
  onlyKeys(example, ['en', 'zh']);
  const result: Analysis = {
    term: text(record.term, 1200), type: record.type as Analysis['type'],
    phonetic: text(record.phonetic, 200, true), partOfSpeech: text(record.partOfSpeech, 200, true),
    meaning: text(record.meaning, 4000), contextTranslation: text(record.contextTranslation, 12_000),
    example: { en: text(example.en, 4000), zh: text(example.zh, 4000) },
    technicalNote: text(record.technicalNote, 4000, true),
  };
  if (record.sentenceAnalysis !== undefined) {
    const sentence = object(record.sentenceAnalysis);
    onlyKeys(sentence, ['skeleton', 'chunks']);
    if (!Array.isArray(sentence.chunks) || sentence.chunks.length < 1 || sentence.chunks.length > 40) invalid();
    result.sentenceAnalysis = {
      skeleton: text(sentence.skeleton, 4000),
      chunks: sentence.chunks.map(value => {
        const chunk = object(value);
        onlyKeys(chunk, ['text', 'role', 'meaning']);
        return {
          text: text(chunk.text, 2000), role: text(chunk.role, 200),
          meaning: text(chunk.meaning, 2000),
        };
      }),
    };
  }
  if (result.type === 'sentence' && !result.sentenceAnalysis) invalid();
  return result;
}

export function parseAnalysis(value: unknown): Analysis {
  assertJson(value);
  const record = object(value);
  onlyKeys(record, ANALYSIS_KEYS);
  return analysisFields(record);
}

export function parseEntry(value: unknown): Entry {
  assertJson(value);
  const record = object(value);
  onlyKeys(record, ENTRY_KEYS);
  if (record.status !== 'learning' && record.status !== 'mastered') invalid();
  const entry: Entry = {
    ...analysisFields(record), id: identifier(record.id), context: text(record.context, 12_000),
    source: parseSource(record.source),
    createdAt: number(record.createdAt, 0, MAX_DATE), updatedAt: number(record.updatedAt, 0, MAX_DATE),
    nextReviewAt: number(record.nextReviewAt, 0, MAX_DATE),
    interval: number(record.interval, 0, 36_500, false),
    streak: number(record.streak, 0, 1_000_000), reviewCount: number(record.reviewCount, 0, 1_000_000),
    lastReviewedAt: record.lastReviewedAt === null ? null : number(record.lastReviewedAt, 0, MAX_DATE),
    status: record.status, favorite: bool(record.favorite),
  };
  if (entry.reviewCount < entry.streak || entry.updatedAt < entry.createdAt) invalid();
  return entry;
}

export function parseReview(value: unknown): ReviewLog {
  assertJson(value);
  const record = object(value);
  onlyKeys(record, ['id', 'entryId', 'rating', 'at']);
  if (!['forgot', 'hard', 'remember'].includes(String(record.rating))) invalid();
  return {
    id: identifier(record.id), entryId: identifier(record.entryId),
    rating: record.rating as ReviewLog['rating'], at: number(record.at, 0, MAX_DATE),
  };
}

export function parseStory(value: unknown): Story {
  assertJson(value);
  const record = object(value);
  onlyKeys(record, ['id', 'date', 'title', 'english', 'chinese', 'entryIds']);
  const date = text(record.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) invalid();
  const entryIds = parseEntryIds(record.entryIds);
  return {
    id: identifier(record.id), date, title: text(record.title, 300),
    english: text(record.english, 16_000), chinese: text(record.chinese, 16_000), entryIds,
  };
}

export function parseEntryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new CoreError('请选择 1 至 8 个到期词条。');
  }
  const ids = value.map(identifier);
  if (new Set(ids).size !== ids.length) invalid();
  return ids;
}

export function parseRequest(value: unknown): Request {
  assertJson(value);
  const record = object(value);
  switch (record.type) {
    case 'GET_STATE':
    case 'GET_PUBLIC_SETTINGS':
    case 'LOAD_EXAMPLES':
      onlyKeys(record, ['type']);
      return { type: record.type };
    case 'SAVE_SETTINGS':
    case 'TEST_CONNECTION':
      onlyKeys(record, ['type', 'settings']);
      return { type: record.type, settings: parseSettings(record.settings) };
    case 'GET_MODELS':
      onlyKeys(record, ['type', 'settings']);
      return { type: record.type, settings: parseSettings(record.settings, { allowEmptyModel: true }) };
    case 'ANALYZE':
      onlyKeys(record, ['type', 'payload']);
      return { type: record.type, payload: parsePayload(record.payload) };
    case 'SAVE_ENTRY': {
      onlyKeys(record, ['type', 'analysis', 'payload']);
      const payload = parsePayload(record.payload);
      const analysis = parseAnalysis(record.analysis);
      if (normalize(payload.text) !== normalize(analysis.term)) invalid();
      return { type: record.type, payload, analysis: { ...analysis, term: payload.text } };
    }
    case 'REVIEW':
      onlyKeys(record, ['type', 'id', 'rating']);
      if (!['forgot', 'hard', 'remember'].includes(String(record.rating))) invalid();
      return { type: record.type, id: identifier(record.id), rating: record.rating as ReviewLog['rating'] };
    case 'UPDATE_ENTRY': {
      onlyKeys(record, ['type', 'id', 'patch']);
      const patch = object(record.patch);
      onlyKeys(patch, ['favorite', 'status']);
      const result: Extract<Request, { type: 'UPDATE_ENTRY' }>['patch'] = {};
      if (patch.favorite !== undefined) result.favorite = bool(patch.favorite);
      if (patch.status !== undefined) {
        if (patch.status !== 'learning' && patch.status !== 'mastered') invalid();
        result.status = patch.status;
      }
      if (!Object.keys(result).length) invalid();
      return { type: record.type, id: identifier(record.id), patch: result };
    }
    case 'DELETE_ENTRY':
      onlyKeys(record, ['type', 'id']);
      return { type: record.type, id: identifier(record.id) };
    case 'IMPORT':
      onlyKeys(record, ['type', 'data']);
      return { type: record.type, data: record.data };
    case 'GENERATE_STORY':
      onlyKeys(record, ['type', 'entryIds']);
      return { type: record.type, entryIds: parseEntryIds(record.entryIds) };
    case 'OPEN_APP':
      onlyKeys(record, ['type', 'page']);
      return record.page === undefined
        ? { type: record.type }
        : { type: record.type, page: text(record.page, 40) };
    default:
      throw new CoreError('不支持的操作。');
  }
}

export interface ImportData {
  entries: Entry[];
  reviews: ReviewLog[];
  stories: Story[];
}

export function parseImport(value: unknown): ImportData {
  let data = value;
  if (typeof data === 'string') {
    if (data.length > 10_000_000) invalid();
    try { data = JSON.parse(data); } catch { return invalid(); }
  }
  assertJson(data);
  const record = object(data);
  onlyKeys(record, ['schemaVersion', 'entries', 'reviews', 'stories', 'settings', 'exportedAt']);
  if (record.schemaVersion !== 1 || !Array.isArray(record.entries) || record.entries.length > 5000) invalid();
  if (record.settings !== undefined) object(record.settings); // Imported settings, including keys, are never applied.
  if (record.exportedAt !== undefined && typeof record.exportedAt !== 'string'
    && typeof record.exportedAt !== 'number') invalid();
  function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) invalid();
    return value.map(parse);
  }
  const entries = record.entries.map(parseEntry);
  const reviews = list(record.reviews, 100_000, parseReview);
  const stories = list(record.stories, 3660, parseStory);
  const ids = new Set(entries.map(entry => entry.id));
  if (ids.size !== entries.length
    || new Set(reviews.map(review => review.id)).size !== reviews.length
    || new Set(stories.map(story => story.id)).size !== stories.length
    || reviews.some(review => !ids.has(review.entryId))
    || stories.some(story => story.entryIds.some(id => !ids.has(id)))) invalid();
  return { entries, reviews, stories };
}

export function recoverState(value: unknown): AppState {
  const state = emptyState();
  let record: Record<string, unknown>;
  try {
    record = object(value);
    // A poisoned container cannot safely contribute even otherwise valid records.
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record))) {
      if (FORBIDDEN.has(key) || !('value' in descriptor)) return state;
    }
    if (record.schemaVersion !== 1) return state;
  } catch { return state; }
  try {
    const raw = object(record.settings);
    assertJson(raw);
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const key of SETTINGS_KEYS) {
      if (Object.hasOwn(raw, key)) settings[key] = raw[key];
    }
    state.settings = parseSettings(settings);
  } catch { /* Invalid configuration must not send a stored key to a fallback host. */ }
  function recover<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
    if (!Array.isArray(value)) return [];
    const results: T[] = [];
    for (const item of value.slice(0, max)) {
      try { results.push(parse(item)); } catch { /* Keep other valid records. */ }
    }
    return results;
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  state.entries = recover(record.entries, 5000, parseEntry).filter(entry => {
    const key = entryKey(entry);
    if (ids.has(entry.id) || keys.has(key)) return false;
    ids.add(entry.id);
    keys.add(key);
    return true;
  });
  const reviewIds = new Set<string>();
  state.reviews = recover(record.reviews, 100_000, parseReview).filter(review => {
    if (!ids.has(review.entryId) || reviewIds.has(review.id)) return false;
    reviewIds.add(review.id);
    return true;
  });
  const days = new Set<string>();
  state.stories = recover(record.stories, 3660, parseStory).filter(story => {
    if (days.has(story.date) || story.entryIds.some(id => !ids.has(id))) return false;
    days.add(story.date);
    return true;
  });
  return state;
}
