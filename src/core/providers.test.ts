import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageHandler } from '../background';
import { DEFAULT_SETTINGS, emptyState } from '../shared/defaults';
import type { AnalyzeResult, AppState, Entry, ModelOption, Settings, StorageAdapter, Story } from '../shared/types';
import { exampleInputs } from './examples';
import { createService } from './service';
import { parseSettings } from './validation';

const anthropic: Settings = {
  ...DEFAULT_SETTINGS, apiStyle: 'anthropic', apiBaseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'secret-claude-test-key', model: 'claude-test',
};
const openai: Settings = {
  ...DEFAULT_SETTINGS, apiKey: 'secret-openai-test-key', model: 'openai-test',
};
const { analysis, payload } = exampleInputs()[0];

function jsonResponse(data: unknown, status = 200): globalThis.Response {
  return new globalThis.Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function claudeResponse(value: unknown, extra: Record<string, unknown> = {}): globalThis.Response {
  return jsonResponse({ content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn', ...extra });
}

function serviceWith(settings: Settings = anthropic, entries: Entry[] = []) {
  let state: AppState = { ...emptyState(), settings: { ...settings }, entries };
  const adapter: StorageAdapter = {
    get: vi.fn(async () => structuredClone(state)),
    set: vi.fn(async next => { state = structuredClone(next); }),
  };
  return { service: createService(adapter), adapter, state: () => state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('native Claude Messages', () => {
  it('sends a native body and headers, then validates and saves the text-block analysis', async () => {
    const fetchMock = vi.fn().mockResolvedValue(claudeResponse(analysis));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    const result = await service.handle({ type: 'ANALYZE', payload }) as AnalyzeResult;
    expect(result.analysis).toEqual(analysis);
    expect(result.entry?.source).toEqual(payload.source);
    expect(JSON.stringify(result)).not.toContain(anthropic.apiKey);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': anthropic.apiKey, 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    const body = JSON.parse(options.body as string);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    expect(body.model).toBe(anthropic.model);
    expect(body.max_tokens).toBe(4000);
    expect(body.system).toContain('不可信');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain(JSON.stringify({ selection: payload.text, context: payload.context }));
    expect(JSON.stringify(body)).not.toContain(payload.source.url);
    expect(JSON.stringify(body)).not.toContain(payload.source.title);
    expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');
  });

  it('ignores thinking blocks and assembles only text blocks before parsing JSON', async () => {
    const serialized = JSON.stringify(analysis);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'Do not parse or expose this private reasoning.', signature: 'opaque' },
        { type: 'text', text: serialized.slice(0, 70) },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: serialized.slice(70) },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    const result = await service.handle({ type: 'ANALYZE', payload }) as AnalyzeResult;
    expect(result.analysis).toEqual(analysis);
    expect(JSON.stringify(result)).not.toContain('private reasoning');
    expect(JSON.stringify(result)).not.toContain('opaque');
  });

  it('rejects max_tokens truncation even if the content happens to be valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(claudeResponse(analysis, { stop_reason: 'max_tokens' })));
    const { service, adapter } = serviceWith();
    await expect(service.handle({ type: 'ANALYZE', payload })).rejects.toThrow('截断');
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it.each([
    { content: [] },
    { content: [{ type: 'thinking', thinking: '{"meaning":"not the answer"}' }] },
    { content: [{ type: 'text', text: 'not JSON' }] },
    { content: [{ type: 'text', text: 7 }] },
    { content: [{ text: JSON.stringify(analysis) }] },
  ])('rejects invalid native responses instead of using fabricated fallback data %#', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(data)));
    const { service, adapter } = serviceWith();
    await expect(service.handle({ type: 'ANALYZE', payload })).rejects.toThrow('模型');
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it.each([
    { content: `这是分析结果：\n\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\`` },
    { choices: [{ message: { content: JSON.stringify(analysis) }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: [{ type: 'text', text: JSON.stringify(analysis) }] } }] },
  ])('validates and saves analyses from gateway text variants %#', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(data)));
    const { service } = serviceWith();
    const result = await service.handle({ type: 'ANALYZE', payload }) as AnalyzeResult;
    expect(result.analysis).toEqual(analysis);
    expect(result.entry?.term).toBe(payload.text);
  });

  it('accepts a wrapped JSON connection reply through a gateway', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '<think>Checking the request.</think>\n这是结果：\n```json\n{"message":"连接成功"}\n```' } }],
    })));
    const { service } = serviceWith();
    expect(await service.handle({ type: 'TEST_CONNECTION', settings: anthropic }))
      .toEqual({ message: '连接成功，模型接口可用。' });
  });

  it.each([
    'Here are the results:\n{"term":"other","type":"word"}',
    `<think>${JSON.stringify(analysis)}</think>`,
    `${JSON.stringify(analysis)}\n${JSON.stringify(analysis)}`,
    JSON.stringify([analysis]),
    JSON.stringify(analysis).slice(0, -1),
  ])('does not save invalid or ambiguous analyses after extraction %#', async content => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: content }] })));
    const { service, adapter } = serviceWith();
    await expect(service.handle({ type: 'ANALYZE', payload })).rejects.toThrow('模型');
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it.each([
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/v1/messages/', 'https://api.anthropic.com/v1/messages'],
    ['https://gateway.example/custom/v1/chat/completions', 'https://gateway.example/custom/v1/messages'],
    ['http://localhost:8080', 'http://localhost:8080/v1/messages'],
  ])('normalizes the Anthropic base %s', async (apiBaseUrl, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(claudeResponse({ message: 'ready' }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    expect(await service.handle({ type: 'TEST_CONNECTION', settings: { ...anthropic, apiBaseUrl } }))
      .toEqual({ message: '连接成功，模型接口可用。' });
    expect(fetchMock.mock.calls[0][0]).toBe(expected);
    if (!apiBaseUrl.includes('api.anthropic.com')) {
      expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('anthropic-dangerous-direct-browser-access');
    }
  });

  it('uses the same native transport for real generated stories', async () => {
    const now = Date.now();
    const entry: Entry = {
      ...analysis, id: 'story-entry', context: payload.context, source: payload.source,
      createdAt: now, updatedAt: now, nextReviewAt: now, interval: 0, streak: 0,
      reviewCount: 0, lastReviewedAt: null, status: 'learning', favorite: false,
    };
    const generated = { title: '闭包练习', english: 'The programmer used a closure to keep state.', chinese: '程序员使用闭包保存状态。' };
    const fetchMock = vi.fn().mockResolvedValue(claudeResponse(generated));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith(anthropic, [entry]);
    const story = await service.handle({ type: 'GENERATE_STORY', entryIds: [entry.id] }) as Story;
    expect(story).toMatchObject({ ...generated, entryIds: [entry.id] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.system).toContain('故事');
    expect(body).not.toHaveProperty('response_format');
  });

  it('keeps the OpenAI body and bearer authentication after normalizing a full Messages input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"message":"ready"}' }, finish_reason: 'stop' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    await service.handle({
      type: 'TEST_CONNECTION', settings: { ...openai, apiBaseUrl: 'https://gateway.example/v1/messages' },
    });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/chat/completions');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${openai.apiKey}` });
    const body = JSON.parse(options.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body).not.toHaveProperty('system');
  });
});

describe('authenticated model discovery', () => {
  it.each([
    ['openai', 'https://gateway.example/v1/chat/completions/', { data: [{ id: 'model-a', owned_by: 'provider' }] }, [{ id: 'model-a', name: 'model-a' }]],
    ['anthropic', 'https://api.anthropic.com/v1/messages', { data: [{ id: 'claude-test', display_name: 'Claude Test', type: 'model' }], has_more: false, last_id: 'claude-test' }, [{ id: 'claude-test', name: 'Claude Test' }]],
  ] as const)('fetches and validates %s models even before a model is selected', async (apiStyle, apiBaseUrl, data, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);
    const { service, adapter } = serviceWith();
    const settings = { ...anthropic, apiStyle, apiBaseUrl, model: '' };
    expect(await service.handle({ type: 'GET_MODELS', settings })).toEqual(expected);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/v1/models');
    expect(options.method).toBe('GET');
    expect(options).not.toHaveProperty('body');
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual(apiStyle === 'anthropic'
      ? {
          'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        }
      : { Authorization: `Bearer ${settings.apiKey}` });
    expect(adapter.get).not.toHaveBeenCalled();
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it('normalizes an Anthropic root to /v1/models and handles an empty authenticated list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], has_more: false, last_id: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    expect(await service.handle({
      type: 'GET_MODELS', settings: { ...anthropic, apiBaseUrl: 'https://api.anthropic.com', model: '' },
    })).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models');
  });

  it.each(['anthropic', 'openai'] as const)('paginates %s results using validated cursors and deduplicates IDs', async apiStyle => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'model-a', display_name: 'Model A' }, { id: 'model-b', display_name: 'Model B' }],
        has_more: true, last_id: 'model-b',
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'model-b', display_name: 'Duplicate B' }, { id: 'model-c', display_name: 'Model C' }],
        has_more: false, last_id: 'model-c',
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    const models = await service.handle({
      type: 'GET_MODELS', settings: { ...anthropic, apiStyle, model: '' },
    }) as ModelOption[];
    expect(models.map(model => model.id)).toEqual(['model-a', 'model-b', 'model-c']);
    expect(models[1].name).toBe(apiStyle === 'anthropic' ? 'Model B' : 'model-b');
    const second = new URL(fetchMock.mock.calls[1][0]);
    expect(second.searchParams.get(apiStyle === 'anthropic' ? 'after_id' : 'after')).toBe('model-b');
    expect(fetchMock.mock.calls[0][1].signal).toBe(fetchMock.mock.calls[1][1].signal);
  });

  it('caps pagination at ten pages', async () => {
    let page = 0;
    const fetchMock = vi.fn(async () => {
      const id = `model-${++page}`;
      return jsonResponse({ data: [{ id }], has_more: true, last_id: id });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    const result = await service.handle({ type: 'GET_MODELS', settings: anthropic }) as ModelOption[];
    expect(result).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('caps the number of returned entries at 1000 without fetching another page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: Array.from({ length: 1001 }, (_, index) => ({ id: `model-${index}` })),
      has_more: true, last_id: 'model-1000',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    const result = await service.handle({ type: 'GET_MODELS', settings: openai }) as ModelOption[];
    expect(result).toHaveLength(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { data: {} },
    { data: [null] },
    { data: [{ id: '' }] },
    { data: [{ id: 'has spaces' }] },
    { data: [{ id: 'valid', display_name: {} }] },
    { data: [{ id: 'valid' }], has_more: 'yes' },
    { data: [{ id: 'valid' }], has_more: true },
    { data: [], has_more: true, last_id: 'valid' },
  ])('rejects invalid model-list shapes and pagination without fabricated fallback models %#', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(data)));
    const { service, adapter } = serviceWith();
    await expect(service.handle({ type: 'GET_MODELS', settings: anthropic })).rejects.toThrow('模型列表');
    expect(adapter.set).not.toHaveBeenCalled();
  });

  it('rejects repeating pagination cursors instead of looping', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({
      data: [{ id: 'same-model' }], has_more: true, last_id: 'same-model',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    await expect(service.handle({ type: 'GET_MODELS', settings: anthropic })).rejects.toThrow('分页');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 500])('sanitizes native model-list HTTP %s failures without echoing a key', async status => {
    const errorBody = `Provider failure: ${anthropic.apiKey}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new globalThis.Response(errorBody, { status })));
    const { service } = serviceWith();
    const error = await service.handle({ type: 'GET_MODELS', settings: anthropic }).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(anthropic.apiKey);
    expect((error as Error).message).not.toContain('Provider failure');
  });

  it('sanitizes network errors and rejects malformed JSON and oversized responses', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error(`fetch failed ${anthropic.apiKey}`))
      .mockResolvedValueOnce(new globalThis.Response(`not JSON ${anthropic.apiKey}`))
      .mockResolvedValueOnce(new globalThis.Response('ignored', { headers: { 'content-length': '1000001' } }))
      .mockResolvedValueOnce(new globalThis.Response('x'.repeat(1_000_001)))
      .mockResolvedValueOnce(new globalThis.Response('{"data":[],"__proto__":{"polluted":true}}'));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    for (let index = 0; index < 5; index += 1) {
      const error = await service.handle({ type: 'GET_MODELS', settings: anthropic }).catch(value => value as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(anthropic.apiKey);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('requires an API key and secure URL even for an empty model lookup', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    for (const settings of [
      { ...anthropic, apiKey: '', model: '' },
      { ...anthropic, apiBaseUrl: 'http://public.example/v1', model: '' },
    ]) await expect(service.handle({ type: 'GET_MODELS', settings })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses one 25-second timeout across all pages and aborts a stuck later page', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }))
      .mockImplementationOnce((_url: string, _options: RequestInit) => new Promise<globalThis.Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    const pending = service.handle({ type: 'GET_MODELS', settings: anthropic });
    const rejection = expect(pending).rejects.toThrow('25 秒');
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('allows other mutations while a model list is pending and never persists lookup settings', async () => {
    let finish!: (response: globalThis.Response) => void;
    const network = new Promise<globalThis.Response>(resolve => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => network));
    const { service, state } = serviceWith(openai);
    const pending = service.handle({ type: 'GET_MODELS', settings: { ...anthropic, model: '' } });
    const result = await service.handle({
      type: 'SAVE_SETTINGS', settings: { ...openai, dailyGoal: 30 },
    }) as AppState;
    expect(result.settings.dailyGoal).toBe(30);
    finish(jsonResponse({ data: [] }));
    expect(await pending).toEqual([]);
    expect(state().settings).toEqual({ ...openai, dailyGoal: 30 });
  });
});

describe('settings migration and model-discovery boundary', () => {
  it('validates apiStyle and allows empty models only for GET_MODELS', async () => {
    const { service } = serviceWith();
    expect(() => parseSettings({ ...anthropic, apiStyle: 'unsupported' })).toThrow();
    expect(() => parseSettings({ ...anthropic, model: '' })).toThrow();
    expect(parseSettings({ ...anthropic, model: '' }, { allowEmptyModel: true }).model).toBe('');
    for (const type of ['SAVE_SETTINGS', 'TEST_CONNECTION'] as const) {
      await expect(service.handle({ type, settings: { ...anthropic, model: '' } })).rejects.toThrow();
    }
  });

  it('migrates old persisted settings without apiStyle to openai while keeping the key and endpoint', async () => {
    const legacy: Record<string, unknown> = { ...openai, apiBaseUrl: 'https://gateway.example/v1' };
    delete legacy.apiStyle;
    const service = createService({
      get: async () => ({ ...emptyState(), settings: legacy }) as unknown as AppState,
      set: async () => undefined,
    });
    const state = await service.handle({ type: 'GET_STATE' }) as AppState;
    expect(state.settings).toEqual({ ...openai, apiBaseUrl: 'https://gateway.example/v1', apiStyle: 'openai' });
  });

  it('keeps model discovery and native headers restricted to trusted extension UI', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({
      data: [{ id: 'claude-test', display_name: 'Claude Test' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = serviceWith();
    const handler = createMessageHandler(service.handle, extensionId, vi.fn());
    const content = {
      id: extensionId, url: 'https://developer.mozilla.org/en-US/', origin: 'https://developer.mozilla.org',
      tab: { id: 7 },
    } as chrome.runtime.MessageSender;
    const request = { type: 'GET_MODELS', settings: { ...anthropic, model: '' } };
    const denied = await handler(request, content);
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(denied)).not.toContain(anthropic.apiKey);
    expect(fetchMock).not.toHaveBeenCalled();
    const trusted = {
      id: extensionId, url: `chrome-extension://${extensionId}/index.html`,
      origin: `chrome-extension://${extensionId}`,
    };
    const result = await handler(request, trusted);
    expect(result).toEqual({ ok: true, data: [{ id: 'claude-test', name: 'Claude Test' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(anthropic.apiKey);
    expect(JSON.stringify(await handler({ type: 'GET_PUBLIC_SETTINGS' }, content))).not.toContain('apiStyle');
  });
});
