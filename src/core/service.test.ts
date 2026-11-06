import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyState } from '../shared/defaults';
import type {
  Analysis, AnalyzePayload, AnalyzeResult, AppState, Entry, Settings, StorageAdapter, Story,
} from '../shared/types';
import { exampleInputs } from './examples';
import { createService, localDate } from './service';
import { DAY_MS, scheduleReview } from './srs';

const NOW = new Date('2026-11-06T12:00:00+08:00').getTime();
const configured: Settings = { ...DEFAULT_SETTINGS, apiKey: 'secret-test-key' };
const { analysis, payload } = exampleInputs()[0];

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    ...structuredClone(analysis), id: 'entry-1', context: payload.context, source: { ...payload.source },
    createdAt: NOW - DAY_MS, updatedAt: NOW - DAY_MS, nextReviewAt: NOW - DAY_MS,
    interval: 0, streak: 0, reviewCount: 0, lastReviewedAt: null,
    status: 'learning', favorite: false, ...overrides,
  };
}

function stateWith(...entries: Entry[]): AppState {
  return { ...emptyState(), settings: { ...configured }, entries };
}

function memory(initial?: AppState) {
  let stored = structuredClone(initial);
  const adapter: StorageAdapter = {
    get: vi.fn(async () => structuredClone(stored)),
    set: vi.fn(async state => {
      await Promise.resolve();
      stored = structuredClone(state);
    }),
  };
  return { adapter, service: createService(adapter), stored: () => stored };
}

function response(value: unknown): globalThis.Response {
  return new globalThis.Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('spaced repetition', () => {
  it('resets the streak and schedules forgotten words exactly ten minutes later', () => {
    const result = scheduleReview(entry({ streak: 3, reviewCount: 5 }), 'forgot', 4, NOW);
    expect(result).toMatchObject({
      streak: 0, status: 'learning', reviewCount: 6, lastReviewedAt: NOW,
      nextReviewAt: NOW + 600_000,
    });
    expect(result.interval * DAY_MS).toBe(600_000);
  });

  it('schedules hard words one day later without advancing progress', () => {
    expect(scheduleReview(entry({ streak: 2, reviewCount: 4 }), 'hard', 4, NOW))
      .toMatchObject({ streak: 2, interval: 1, nextReviewAt: NOW + DAY_MS, status: 'learning', reviewCount: 5 });
  });

  it('uses 1, 3, 7, 14, 30, 60 day intervals for six consecutive remembers', () => {
    let current = entry();
    for (const [index, days] of [1, 3, 7, 14, 30, 60].entries()) {
      current = scheduleReview(current, 'remember', 6, NOW);
      expect(current.interval).toBe(days);
      expect(current.nextReviewAt).toBe(NOW + days * DAY_MS);
      expect(current.streak).toBe(index + 1);
      expect(current.status).toBe(index === 5 ? 'mastered' : 'learning');
    }
  });

  it('schedules the fifth remember after 30 days without mastering at target six', () => {
    const result = scheduleReview(entry({ streak: 4, reviewCount: 4 }), 'remember', 6, NOW);
    expect(result).toMatchObject({
      streak: 5, reviewCount: 5, interval: 30,
      nextReviewAt: NOW + 30 * DAY_MS, status: 'learning',
    });
  });

  it.each([3, 4, 5, 6])('masters at the configured target %s', target => {
    const result = scheduleReview(entry({ streak: target - 1, reviewCount: target - 1 }), 'remember', target, NOW);
    expect(result.status).toBe('mastered');
    expect(result.streak).toBe(target);
    expect(result.interval).toBe([1, 3, 7, 14, 30, 60][target - 1]);
  });
});

describe('storage service and mutations', () => {
  it('starts empty and only loads seven technical examples on explicit request', async () => {
    const { service } = memory();
    expect(await service.handle({ type: 'GET_STATE' })).toEqual(emptyState());
    const state = await service.handle({ type: 'LOAD_EXAMPLES' }) as AppState;
    expect(state.entries).toHaveLength(7);
    expect(state.entries.every(item => item.nextReviewAt <= Date.now()
      && new URL(item.source.url).hostname === 'developer.mozilla.org')).toBe(true);
    const again = await service.handle({ type: 'LOAD_EXAMPLES' }) as AppState;
    expect(again.entries).toHaveLength(7);
  });

  it('deduplicates normalized term and context while retaining progress and favorites', async () => {
    const saved = entry({
      status: 'mastered', streak: 4, reviewCount: 8, interval: 14,
      nextReviewAt: NOW + 14 * DAY_MS, favorite: true, lastReviewedAt: NOW,
    });
    const { service } = memory(stateWith(saved));
    const updated = await service.handle({
      type: 'SAVE_ENTRY',
      analysis: { ...analysis, term: 'CLOSURE', meaning: '更新的闭包解释' },
      payload: { ...payload, text: 'ＣＬＯＳＵＲＥ', context: `  ${payload.context.toUpperCase().replaceAll(' ', '  ')}  ` },
    }) as Entry;
    expect(updated.id).toBe(saved.id);
    expect(updated.meaning).toBe('更新的闭包解释');
    for (const key of ['streak', 'reviewCount', 'status', 'favorite', 'interval', 'nextReviewAt', 'lastReviewedAt', 'createdAt'] as const) {
      expect(updated[key]).toBe(saved[key]);
    }
    expect((await service.handle({ type: 'GET_STATE' }) as AppState).entries).toHaveLength(1);
  });

  it('keeps identical terms in different contexts as distinct entries', async () => {
    const { service } = memory();
    await service.handle({ type: 'SAVE_ENTRY', analysis, payload });
    await service.handle({ type: 'SAVE_ENTRY', analysis, payload: { ...payload, context: 'A different closure example.' } });
    expect((await service.handle({ type: 'GET_STATE' }) as AppState).entries).toHaveLength(2);
  });

  it('serializes concurrent saves and other mutations without lost writes', async () => {
    const { service } = memory();
    const saves = Array.from({ length: 25 }, (_, index) => {
      const term = `term${index}`;
      return service.handle({
        type: 'SAVE_ENTRY', analysis: { ...analysis, term },
        payload: { ...payload, text: term },
      });
    });
    const entries = await Promise.all(saves) as Entry[];
    await Promise.all([
      ...entries.map(item => service.handle({ type: 'UPDATE_ENTRY', id: item.id, patch: { favorite: true } })),
      service.handle({ type: 'SAVE_SETTINGS', settings: { ...configured, dailyGoal: 25 } }),
    ]);
    const state = await service.handle({ type: 'GET_STATE' }) as AppState;
    expect(state.entries).toHaveLength(25);
    expect(state.entries.every(item => item.favorite)).toBe(true);
    expect(state.settings.dailyGoal).toBe(25);
  });

  it('records a review atomically, rejects early reviews, and supports restarting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { service } = memory(stateWith(entry({ streak: 3, reviewCount: 3 })));
    const state = await service.handle({ type: 'REVIEW', id: 'entry-1', rating: 'remember' }) as AppState;
    expect(state.entries[0]).toMatchObject({ status: 'mastered', streak: 4, reviewCount: 4 });
    expect(state.reviews).toHaveLength(1);
    const reset = await service.handle({ type: 'UPDATE_ENTRY', id: 'entry-1', patch: { status: 'learning' } }) as AppState;
    expect(reset.entries[0]).toMatchObject({ streak: 0, interval: 0, nextReviewAt: NOW, reviewCount: 4 });
    await service.handle({ type: 'REVIEW', id: 'entry-1', rating: 'hard' });
    await expect(service.handle({ type: 'REVIEW', id: 'entry-1', rating: 'remember' })).rejects.toThrow('尚未到');
    expect((await service.handle({ type: 'GET_STATE' }) as AppState).reviews).toHaveLength(2);
  });

  it('continues after failed writes, exposes safe errors, and does not mutate adapter data', async () => {
    const { service, adapter, stored } = memory(stateWith(entry()));
    vi.mocked(adapter.set).mockRejectedValueOnce(new Error('private secret-test-key'));
    await expect(service.handle({ type: 'UPDATE_ENTRY', id: 'entry-1', patch: { favorite: true } }))
      .rejects.toThrow('保存本地数据失败');
    expect(stored()!.entries[0].favorite).toBe(false);
    const result = await service.handle({ type: 'UPDATE_ENTRY', id: 'entry-1', patch: { favorite: true } }) as AppState;
    expect(result.entries[0].favorite).toBe(true);
    result.entries[0].meaning = 'caller mutation';
    expect(stored()!.entries[0].meaning).toBe(analysis.meaning);
  });

  it('recovers valid records without trusting corrupt settings, records, or inherited fields', async () => {
    const bad = stateWith(entry(), { ...entry({ id: 'bad-1' }), nextReviewAt: NaN });
    bad.settings = { ...configured, apiBaseUrl: 'javascript:alert(1)' };
    const { service } = memory(bad);
    const recovered = await service.handle({ type: 'GET_STATE' }) as AppState;
    expect(recovered.entries).toHaveLength(1);
    expect(recovered.settings).toEqual(DEFAULT_SETTINGS);
    const adapter: StorageAdapter = {
      get: async () => Object.create({ ...stateWith(entry()) }) as AppState,
      set: async () => undefined,
    };
    expect(await createService(adapter).handle({ type: 'GET_STATE' })).toEqual(emptyState());
  });

  it('only returns public settings through the public operation', async () => {
    const { service } = memory(stateWith());
    expect(await service.handle({ type: 'GET_PUBLIC_SETTINGS' })).toEqual({
      enabled: true, autoSave: true, selectionMode: 'button',
    });
  });
});

describe('import validation and merge', () => {
  it('accepts exported JSON without a key, preserves current settings and existing progress', async () => {
    const existing = entry({ streak: 2, reviewCount: 3, favorite: true });
    const { service } = memory(stateWith(existing));
    const { apiKey: _key, ...exportSettings } = DEFAULT_SETTINGS;
    const data = {
      schemaVersion: 1, settings: exportSettings, exportedAt: new Date(NOW).toISOString(),
      entries: [
        entry({ id: 'imported-duplicate', term: 'CLOSURE' }),
        entry({ id: existing.id, term: 'callback', context: 'A callback is a function.' }),
      ],
      reviews: [{ id: 'review-imported', entryId: existing.id, rating: 'remember', at: NOW }],
      stories: [],
    };
    const state = await service.handle({ type: 'IMPORT', data: JSON.stringify(data) }) as AppState;
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toMatchObject({ id: existing.id, streak: 2, reviewCount: 3, favorite: true });
    expect(state.settings).toEqual(configured);
    const callback = state.entries.find(item => item.term === 'callback')!;
    expect(callback.id).not.toBe(existing.id);
    expect(state.reviews[0].entryId).toBe(callback.id);
  });

  it('ignores imported credentials and never replaces the current provider', async () => {
    const { service } = memory(stateWith());
    const state = await service.handle({
      type: 'IMPORT', data: { ...stateWith(entry()), settings: { apiKey: 'imported-secret', apiBaseUrl: 'https://evil.example' } },
    }) as AppState;
    expect(state.settings).toEqual(configured);
    expect(JSON.stringify(state)).not.toContain('imported-secret');
    expect(JSON.stringify(state)).not.toContain('evil.example');
  });

  it.each([
    { schemaVersion: 2, entries: [] },
    { schemaVersion: 1, entries: [{}] },
    { schemaVersion: 1, entries: [{ ...entry(), nextReviewAt: 'tomorrow' }] },
    { schemaVersion: 1, entries: [{ ...entry(), source: { title: 'bad', url: 'javascript:alert(1)' } }] },
    { schemaVersion: 1, entries: [{ ...entry(), unexpectedKey: 'do not copy' }] },
    { schemaVersion: 1, entries: [entry(), entry()] },
    { schemaVersion: 1, entries: [], reviews: [{ id: 'log-1', entryId: 'missing', rating: 'remember', at: NOW }] },
    { schemaVersion: 1, entries: [entry()], stories: [{ id: 'story-1', date: '2026-02-31', title: 'bad', english: 'closure', chinese: '闭包', entryIds: ['entry-1'] }] },
  ])('rejects malformed imports atomically %#', async data => {
    const { service, adapter } = memory(stateWith(entry()));
    await expect(service.handle({ type: 'IMPORT', data })).rejects.toThrow();
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it('rejects prototype keys at every depth without polluting prototypes', async () => {
    const { service, adapter } = memory();
    for (const poison of [
      '{"schemaVersion":1,"entries":[],"__proto__":{"polluted":true}}',
      '{"schemaVersion":1,"entries":[],"settings":{"constructor":{"prototype":{"polluted":true}}}}',
    ]) {
      await expect(service.handle({ type: 'IMPORT', data: JSON.parse(poison) })).rejects.toThrow();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it('rejects untrusted mutation fields and settings outside allowed ranges', async () => {
    const { service } = memory(stateWith(entry()));
    await expect(service.handle({
      type: 'UPDATE_ENTRY', id: 'entry-1', patch: { apiKey: 'evil' },
    } as never)).rejects.toThrow();
    for (const settings of [
      { ...configured, masteryTarget: 2 }, { ...configured, masteryTarget: 7 },
      { ...configured, apiBaseUrl: 'http://api.example.com' },
      { ...configured, apiBaseUrl: 'https://key:password@api.example.com' },
    ]) {
      await expect(service.handle({ type: 'SAVE_SETTINGS', settings })).rejects.toThrow();
    }
  });
});

describe('model calls and analysis', () => {
  it('blocks disabled analysis before any fetch or write', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { service, adapter } = memory({ ...stateWith(), settings: { ...configured, enabled: false } });
    await expect(service.handle({ type: 'ANALYZE', payload })).rejects.toThrow('已关闭');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it('validates structured output, quotes user data, and saves without exposing settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(analysis));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = memory(stateWith());
    const result = await service.handle({ type: 'ANALYZE', payload }) as AnalyzeResult;
    expect(result.analysis).toEqual(analysis);
    expect(result.entry?.term).toBe(payload.text);
    expect(Object.keys(result).sort()).toEqual(['analysis', 'entry']);
    expect(JSON.stringify(result)).not.toContain(configured.apiKey);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(options.redirect).toBe('error');
    const body = JSON.parse(options.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('不可信');
    expect(body.messages[1].content).toContain(JSON.stringify({ selection: payload.text, context: payload.context }));
    expect(body.messages[1].content).not.toContain(payload.source.url);
    expect(body.messages[1].content).not.toContain(payload.source.title);
    expect(options.headers).toMatchObject({ Authorization: `Bearer ${configured.apiKey}` });
  });

  it('preserves review progress through repeated successful model analysis', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...analysis, meaning: '更准确的解释' })));
    const saved = entry({ streak: 2, reviewCount: 3, nextReviewAt: NOW + DAY_MS, favorite: true });
    const { service } = memory(stateWith(saved));
    const result = await service.handle({ type: 'ANALYZE', payload }) as AnalyzeResult;
    expect(result.entry).toMatchObject({
      id: saved.id, streak: 2, reviewCount: 3, favorite: true, nextReviewAt: saved.nextReviewAt,
      meaning: '更准确的解释',
    });
  });

  it('does not hold the mutation queue while a model request is pending', async () => {
    const started = deferred<void>();
    const model = deferred<globalThis.Response>();
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return model.promise; }));
    const { service } = memory(stateWith(entry()));
    const pending = service.handle({ type: 'ANALYZE', payload });
    await started.promise;
    const result = await service.handle({ type: 'UPDATE_ENTRY', id: 'entry-1', patch: { favorite: true } }) as AppState;
    expect(result.entries[0].favorite).toBe(true);
    await service.handle({ type: 'SAVE_SETTINGS', settings: { ...configured, autoSave: false } });
    model.resolve(response(analysis));
    expect(await pending).toMatchObject({ analysis, entry: null });
    expect((await service.handle({ type: 'GET_STATE' }) as AppState).entries[0].favorite).toBe(true);
  });

  it('honors disabling the feature during a pending model call', async () => {
    const started = deferred<void>();
    const model = deferred<globalThis.Response>();
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return model.promise; }));
    const { service } = memory(stateWith());
    const pending = service.handle({ type: 'ANALYZE', payload });
    await started.promise;
    await service.handle({ type: 'SAVE_SETTINGS', settings: { ...configured, enabled: false } });
    const rejection = expect(pending).rejects.toThrow('已关闭');
    model.resolve(response(analysis));
    await rejection;
    expect((await service.handle({ type: 'GET_STATE' }) as AppState).entries).toHaveLength(0);
  });

  it('honors autoSave false while allowing explicit save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(analysis)));
    const { service } = memory({ ...stateWith(), settings: { ...configured, autoSave: false } });
    const result = await service.handle({ type: 'ANALYZE', payload }) as AnalyzeResult;
    expect(result.entry).toBeNull();
    const saved = await service.handle({ type: 'SAVE_ENTRY', analysis: result.analysis, payload }) as Entry;
    expect(saved.id).toBeTruthy();
  });

  it.each([
    { ...analysis, term: 'different term' },
    { ...analysis, meaning: '' },
    { ...analysis, type: 'sentence' },
    { ...analysis, apiKey: 'unexpected' },
  ])('rejects malformed model analysis without saving %#', async modelAnalysis => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(modelAnalysis)));
    const { service, adapter } = memory(stateWith());
    await expect(service.handle({ type: 'ANALYZE', payload })).rejects.toThrow('模型');
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it('validates complete long-sentence breakdowns', async () => {
    const sentence = 'The callback runs when the Promise resolves.';
    const sentenceAnalysis: Analysis = {
      ...analysis, term: sentence, type: 'sentence',
      sentenceAnalysis: {
        skeleton: 'The callback runs：回调执行',
        chunks: [
          { text: 'The callback runs', role: '主句', meaning: '回调执行' },
          { text: 'when the Promise resolves', role: '时间状语从句', meaning: '当 Promise 兑现时' },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(sentenceAnalysis)));
    const { service } = memory(stateWith());
    const result = await service.handle({
      type: 'ANALYZE', payload: { ...payload, text: sentence, context: sentence },
    }) as AnalyzeResult;
    expect(result.analysis.sentenceAnalysis?.chunks).toHaveLength(2);
  });

  it.each([401, 429, 500])('does not expose the provider error body for HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new globalThis.Response(`private ${configured.apiKey}`, { status })));
    const { service } = memory(stateWith());
    const error = await service.handle({ type: 'ANALYZE', payload }).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(configured.apiKey);
  });

  it('sanitizes fetch exceptions and never invents fallback analysis', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`Network ${configured.apiKey}`)));
    const { service, adapter } = memory(stateWith());
    const error = await service.handle({ type: 'ANALYZE', payload }).catch(value => value as Error);
    expect((error as Error).message).toContain('无法连接');
    expect((error as Error).message).not.toContain(configured.apiKey);
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it.each(['not json', '{"choices":[]}', '{"choices":[{"message":{"content":"not JSON"}}]}'])(
    'rejects malformed provider envelopes or JSON without saving %s', async body => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new globalThis.Response(body)));
      const { service, adapter } = memory(stateWith());
      await expect(service.handle({ type: 'ANALYZE', payload })).rejects.toThrow('模型');
      expect(adapter.set).not.toHaveBeenCalled();
    },
  );

  it('aborts after 25 seconds even if fetch never settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchMock = vi.fn((_url: string, _options: RequestInit) => new Promise<globalThis.Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = memory(stateWith());
    const pending = service.handle({ type: 'ANALYZE', payload });
    const rejection = expect(pending).rejects.toThrow('25 秒');
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.signal?.aborted).toBe(true);
  });

  it('supports localhost HTTP and existing /chat/completions paths for connection tests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message: 'ready' }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = memory();
    const result = await service.handle({
      type: 'TEST_CONNECTION',
      settings: { ...configured, apiBaseUrl: 'http://localhost:8080/v1/chat/completions/' },
    });
    expect(result).toEqual({ message: '连接成功，模型接口可用。' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/v1/chat/completions');
  });
});

describe('daily stories', () => {
  it('generates a validated story from due selected entries, stores it, and caches it for today', async () => {
    const story = { title: '闭包练习', english: 'The developer used a closure to keep the counter private.', chinese: '开发者使用闭包让计数器保持私有。' };
    const fetchMock = vi.fn().mockResolvedValue(response(story));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = memory(stateWith(entry()));
    const result = await service.handle({ type: 'GENERATE_STORY', entryIds: ['entry-1'] }) as Story;
    expect(result).toMatchObject({ ...story, date: localDate(), entryIds: ['entry-1'] });
    expect((await service.handle({ type: 'GET_STATE' }) as AppState).stories).toEqual([result]);
    expect(await service.handle({ type: 'GENERATE_STORY', entryIds: ['entry-1'] })).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects not-due entries, missing IDs, empty selections, and more than eight IDs before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { service } = memory(stateWith(entry({ nextReviewAt: Date.now() + DAY_MS })));
    for (const entryIds of [[], ['missing'], ['entry-1'], Array.from({ length: 9 }, (_, index) => `id-${index}`)]) {
      await expect(service.handle({ type: 'GENERATE_STORY', entryIds })).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fabricate stories when the key is missing, a term is omitted, or fetch fails', async () => {
    const { service: noKey } = memory({ ...stateWith(entry()), settings: { ...DEFAULT_SETTINGS } });
    await expect(noKey.handle({ type: 'GENERATE_STORY', entryIds: ['entry-1'] })).rejects.toThrow('密钥');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      title: '无关故事', english: 'A bird found a tree.', chinese: '一只鸟找到一棵树。',
    })));
    const { service, adapter } = memory(stateWith(entry()));
    await expect(service.handle({ type: 'GENERATE_STORY', entryIds: ['entry-1'] })).rejects.toThrow('遗漏');
    expect(adapter.set).not.toHaveBeenCalled();
  });
});
