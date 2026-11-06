import { emptyState } from '../shared/defaults';
import type {
  Analysis, AnalyzePayload, AppState, Entry, Request, StorageAdapter, Story,
} from '../shared/types';
import { analyze, generateStory, testConnection } from './ai';
import { CoreError } from './errors';
import { exampleInputs } from './examples';
import { getModels } from './models';
import { scheduleReview } from './srs';
import { entryKey, parseImport, parseRequest, recoverState } from './validation';

function newId(): string {
  return crypto.randomUUID();
}

export function localDate(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function saveEntry(state: AppState, analysis: Analysis, payload: AnalyzePayload, now: number): Entry {
  const key = entryKey({ term: payload.text, context: payload.context });
  const index = state.entries.findIndex(entry => entryKey(entry) === key);
  if (index >= 0) {
    const existing = state.entries[index];
    // Explanation refreshes never replace a learner's scheduling or favorite fields.
    const refreshed: Entry = {
      ...existing, ...analysis, term: payload.text, context: payload.context,
      source: { ...payload.source }, updatedAt: now,
    };
    // Remove a previous sentence breakdown if the updated analysis is a word or phrase.
    if (!analysis.sentenceAnalysis) delete refreshed.sentenceAnalysis;
    state.entries[index] = refreshed;
    return refreshed;
  }
  if (state.entries.length >= 5000) throw new CoreError('词库已达到 5000 条，请先导出并清理部分词条。');
  const entry: Entry = {
    ...analysis, id: newId(), term: payload.text, context: payload.context,
    source: { ...payload.source }, createdAt: now, updatedAt: now, nextReviewAt: now,
    interval: 0, streak: 0, reviewCount: 0, lastReviewedAt: null,
    status: 'learning', favorite: false,
  };
  state.entries.unshift(entry);
  return entry;
}

function requireEntry(state: AppState, id: string): Entry {
  const entry = state.entries.find(item => item.id === id);
  if (!entry) throw new CoreError('词条不存在，可能已被删除。');
  return entry;
}

function mergeImport(state: AppState, data: ReturnType<typeof parseImport>): void {
  const byKey = new Map(state.entries.map(entry => [entryKey(entry), entry]));
  const ids = new Set(state.entries.map(entry => entry.id));
  const remapped = new Map<string, string>();
  for (const incoming of data.entries) {
    const key = entryKey(incoming);
    const existing = byKey.get(key);
    if (existing) {
      remapped.set(incoming.id, existing.id);
      continue;
    }
    const id = ids.has(incoming.id) ? newId() : incoming.id;
    const entry = { ...incoming, id };
    state.entries.push(entry);
    byKey.set(key, entry);
    ids.add(id);
    remapped.set(incoming.id, id);
  }
  if (state.entries.length > 5000) throw new CoreError('合并后的词库超过 5000 条，请拆分导入文件。');
  const reviewIds = new Set(state.reviews.map(review => review.id));
  const reviewKeys = new Set(state.reviews.map(review => JSON.stringify([review.entryId, review.at, review.rating])));
  for (const incoming of data.reviews) {
    const entryId = remapped.get(incoming.entryId)!;
    const key = JSON.stringify([entryId, incoming.at, incoming.rating]);
    if (reviewKeys.has(key)) continue;
    const id = reviewIds.has(incoming.id) ? newId() : incoming.id;
    state.reviews.push({ ...incoming, id, entryId });
    reviewIds.add(id);
    reviewKeys.add(key);
  }
  state.reviews = state.reviews.slice(-100_000);
  const days = new Set(state.stories.map(story => story.date));
  const storyIds = new Set(state.stories.map(story => story.id));
  for (const incoming of data.stories) {
    if (days.has(incoming.date)) continue;
    const entryIds = [...new Set(incoming.entryIds.map(id => remapped.get(id)!))];
    const id = storyIds.has(incoming.id) ? newId() : incoming.id;
    state.stories.push({ ...incoming, id, entryIds });
    storyIds.add(id);
    days.add(incoming.date);
  }
  state.stories = state.stories.slice(-3660);
}

function sameSelection(story: Story, ids: string[]): boolean {
  return story.entryIds.length === ids.length && ids.every(id => story.entryIds.includes(id));
}

export function createService(adapter: StorageAdapter): { handle(request: Request): Promise<unknown> } {
  let tail: Promise<void> = Promise.resolve();

  async function read(): Promise<AppState> {
    try {
      return recoverState(await adapter.get());
    } catch {
      throw new CoreError('读取本地数据失败，请稍后重试。');
    }
  }

  async function snapshot(): Promise<AppState> {
    await tail;
    return read();
  }

  function transaction<T>(change: (state: AppState) => { result: T; persist?: boolean }): Promise<T> {
    const operation = tail.then(async () => {
      const state = await read();
      const { result, persist = true } = change(state);
      if (persist) {
        try { await adapter.set(structuredClone(state)); }
        catch { throw new CoreError('保存本地数据失败，请检查存储空间后重试。'); }
      }
      return structuredClone(result);
    });
    // A rejected mutation must not poison later transactions.
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function handle(input: Request): Promise<unknown> {
    const request = parseRequest(input);
    switch (request.type) {
      case 'GET_STATE':
        return snapshot();
      case 'GET_PUBLIC_SETTINGS': {
        const { enabled, autoSave, selectionMode } = (await snapshot()).settings;
        return { enabled, autoSave, selectionMode };
      }
      case 'SAVE_SETTINGS':
        return transaction(state => {
          state.settings = request.settings;
          return { result: state };
        });
      case 'TEST_CONNECTION':
        return testConnection(request.settings);
      case 'GET_MODELS':
        return getModels(request.settings);
      case 'ANALYZE': {
        const before = await snapshot();
        if (!before.settings.enabled) throw new CoreError('划词解释已关闭，请先在设置中启用。');
        // No storage queue is held while the provider is running.
        const analysis = await analyze(before.settings, request.payload);
        return transaction(state => {
          if (!state.settings.enabled) throw new CoreError('划词解释已关闭，请先在设置中启用。');
          const entry = state.settings.autoSave
            ? saveEntry(state, analysis, request.payload, Date.now()) : null;
          return { result: { analysis, entry }, persist: entry !== null };
        });
      }
      case 'SAVE_ENTRY':
        return transaction(state => ({
          result: saveEntry(state, request.analysis, request.payload, Date.now()),
        }));
      case 'REVIEW':
        return transaction(state => {
          const entry = requireEntry(state, request.id);
          if (entry.status !== 'learning') throw new CoreError('该词条已掌握，请先重新学习。');
          const now = Date.now();
          if (entry.nextReviewAt > now) throw new CoreError('该词条尚未到复习时间。');
          const updated = scheduleReview(entry, request.rating, state.settings.masteryTarget, now);
          state.entries[state.entries.findIndex(item => item.id === entry.id)] = updated;
          state.reviews.push({ id: newId(), entryId: entry.id, rating: request.rating, at: now });
          state.reviews = state.reviews.slice(-100_000);
          return { result: state };
        });
      case 'UPDATE_ENTRY':
        return transaction(state => {
          const entry = requireEntry(state, request.id);
          const now = Date.now();
          if (request.patch.favorite !== undefined) entry.favorite = request.patch.favorite;
          if (request.patch.status !== undefined) {
            const restarting = request.patch.status === 'learning';
            entry.status = request.patch.status;
            if (restarting) {
              entry.streak = 0;
              entry.interval = 0;
              entry.nextReviewAt = now;
            }
          }
          entry.updatedAt = now;
          return { result: state };
        });
      case 'DELETE_ENTRY':
        return transaction(state => {
          requireEntry(state, request.id);
          state.entries = state.entries.filter(entry => entry.id !== request.id);
          state.reviews = state.reviews.filter(review => review.entryId !== request.id);
          state.stories = state.stories.filter(story => !story.entryIds.includes(request.id));
          return { result: state };
        });
      case 'IMPORT': {
        const data = parseImport(request.data);
        return transaction(state => {
          mergeImport(state, data);
          return { result: state };
        });
      }
      case 'LOAD_EXAMPLES':
        return transaction(state => {
          const now = Date.now();
          for (const { analysis, payload } of exampleInputs()) saveEntry(state, analysis, payload, now);
          return { result: state };
        });
      case 'GENERATE_STORY': {
        const before = await snapshot();
        const date = localDate();
        const entries = request.entryIds.map(id => requireEntry(before, id));
        if (entries.some(entry => entry.status !== 'learning' || entry.nextReviewAt > Date.now())) {
          throw new CoreError('每日故事只能使用当前到期的学习词条。');
        }
        const cached = before.stories.find(story => story.date === date && sameSelection(story, request.entryIds));
        if (cached) return cached;
        const generated = await generateStory(before.settings, entries);
        return transaction(state => {
          const now = Date.now();
          if (localDate(now) !== date) throw new CoreError('日期已变化，请为今天重新生成故事。');
          if (request.entryIds.some(id => {
            const entry = state.entries.find(item => item.id === id);
            return !entry || entry.status !== 'learning' || entry.nextReviewAt > now;
          })) throw new CoreError('所选词条已发生变化，请刷新后重试。');
          const existing = state.stories.find(story => story.date === date && sameSelection(story, request.entryIds));
          if (existing) return { result: existing, persist: false };
          const story: Story = {
            ...generated, id: newId(), date, entryIds: [...request.entryIds],
          };
          state.stories = state.stories.filter(item => item.date !== date);
          state.stories.push(story);
          state.stories = state.stories.slice(-3660);
          return { result: story };
        });
      }
      case 'OPEN_APP':
        throw new CoreError('打开应用需要使用扩展后台。');
    }
  }

  return { handle };
}

export { emptyState };
