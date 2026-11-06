import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageHandler, isContentSender, isTrustedSender } from '../background';
import { emptyState } from '../shared/defaults';
import type { Request } from '../shared/types';
import { CoreError } from './errors';
import { exampleInputs } from './examples';
import { createService } from './service';
import { createChromeStorageAdapter, STORAGE_KEY } from './storage';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const trusted: chrome.runtime.MessageSender = {
  id: extensionId, url: `chrome-extension://${extensionId}/index.html`,
  origin: `chrome-extension://${extensionId}`,
};
const content = {
  id: extensionId, url: 'https://developer.mozilla.org/en-US/', origin: 'https://developer.mozilla.org',
  tab: { id: 7 }, frameId: 0,
} as chrome.runtime.MessageSender;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('background sender policy', () => {
  it('trusts only extension UI pages from this extension', () => {
    expect(isTrustedSender(trusted, extensionId)).toBe(true);
    expect(isTrustedSender({ ...trusted, url: `chrome-extension://${extensionId}/popup.html` }, extensionId)).toBe(true);
    for (const sender of [
      { ...trusted, id: 'another-extension' },
      { ...trusted, url: `chrome-extension://${extensionId}/content.js` },
      { ...trusted, origin: 'https://evil.example' },
      { ...trusted, url: `https://${extensionId}/index.html` },
      content, {},
    ]) expect(isTrustedSender(sender, extensionId)).toBe(false);
  });

  it('requires real web content from this extension with a matching frame origin', () => {
    expect(isContentSender(content, extensionId)).toBe(true);
    expect(isContentSender({ ...content, url: 'https://frame.example/', origin: 'https://frame.example' }, extensionId)).toBe(true);
    for (const sender of [
      { ...content, id: 'another-extension' },
      { ...content, tab: undefined },
      { ...content, origin: 'null' },
      { ...content, url: 'file:///tmp/page.html' },
      { ...content, url: 'chrome://settings' },
    ]) expect(isContentSender(sender, extensionId)).toBe(false);
  });

  it.each([
    'GET_STATE', 'SAVE_SETTINGS', 'TEST_CONNECTION', 'GET_MODELS', 'REVIEW',
    'UPDATE_ENTRY', 'DELETE_ENTRY', 'IMPORT', 'LOAD_EXAMPLES', 'GENERATE_STORY',
  ])('blocks web content from %s before calling the service', async type => {
    const handle = vi.fn();
    const open = vi.fn();
    const result = await createMessageHandler(handle, extensionId, open)({ type }, content);
    expect(result).toEqual({ ok: false, error: '此页面无权执行该操作。' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('allows the four content operations and routes OPEN_APP itself', async () => {
    const { analysis, payload } = exampleInputs()[0];
    const handle = vi.fn().mockResolvedValue({ allowed: true });
    const open = vi.fn().mockResolvedValue(undefined);
    const handler = createMessageHandler(handle, extensionId, open);
    for (const request of [
      { type: 'GET_PUBLIC_SETTINGS' },
      { type: 'ANALYZE', payload },
      { type: 'SAVE_ENTRY', analysis, payload },
      { type: 'OPEN_APP', page: 'settings' },
    ]) expect((await handler(request, content)).ok).toBe(true);
    expect(handle).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledWith('settings');
  });

  it('never exposes settings or the key through an allowed content operation', async () => {
    const state = emptyState();
    state.settings.apiKey = 'only-trusted-ui-may-read';
    const service = createService({ get: async () => state, set: async () => undefined });
    const handler = createMessageHandler(service.handle, extensionId, vi.fn());
    const publicResult = await handler({ type: 'GET_PUBLIC_SETTINGS' }, content);
    expect(publicResult).toEqual({ ok: true, data: { enabled: true, autoSave: true, selectionMode: 'button' } });
    const { analysis, payload } = exampleInputs()[0];
    const saveResult = await handler({ type: 'SAVE_ENTRY', analysis, payload }, content);
    expect(saveResult.ok).toBe(true);
    expect(JSON.stringify(saveResult)).not.toContain(state.settings.apiKey);
    expect(JSON.stringify(saveResult)).not.toContain('apiBaseUrl');
    const stateResult = await handler({ type: 'GET_STATE' }, trusted);
    expect(JSON.stringify(stateResult)).toContain(state.settings.apiKey);
  });

  it('blocks external and malformed senders, and disallows unsafe app navigation', async () => {
    const handle = vi.fn();
    const open = vi.fn();
    const handler = createMessageHandler(handle, extensionId, open);
    expect((await handler({ type: 'GET_PUBLIC_SETTINGS' }, { ...content, id: 'external' })).ok).toBe(false);
    expect((await handler({ type: 'OPEN_APP', page: 'https://evil.example/' }, content)).ok).toBe(false);
    expect((await handler(null, trusted)).ok).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('returns Response errors without leaking raw exception messages', async () => {
    const handle = vi.fn<(request: Request) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('api-secret-in-fetch-error'))
      .mockRejectedValueOnce(new CoreError('已关闭'));
    const handler = createMessageHandler(handle, extensionId, vi.fn());
    expect(await handler({ type: 'GET_STATE' }, trusted)).toEqual({ ok: false, error: '操作失败，请稍后重试。' });
    expect(await handler({ type: 'GET_STATE' }, trusted)).toEqual({ ok: false, error: '已关闭' });
  });
});

describe('Chrome storage adapter', () => {
  it('uses local storage only after setting TRUSTED_CONTEXTS and persists under one key', async () => {
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { ready = resolve; });
    const state = emptyState();
    const area = {
      setAccessLevel: vi.fn(() => gate),
      get: vi.fn().mockResolvedValue({ [STORAGE_KEY]: state }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createChromeStorageAdapter(area as unknown as typeof chrome.storage.local);
    const pending = adapter.get();
    await Promise.resolve();
    expect(area.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(area.get).not.toHaveBeenCalled();
    ready();
    expect(await pending).toEqual(state);
    expect(area.get).toHaveBeenCalledWith(STORAGE_KEY);
    await adapter.set(state);
    expect(area.set).toHaveBeenCalledWith({ [STORAGE_KEY]: state });
  });

  it('fails closed if local storage cannot be restricted', async () => {
    const area = {
      setAccessLevel: vi.fn().mockRejectedValue(new Error('unsupported')),
      get: vi.fn(),
      set: vi.fn(),
    };
    const adapter = createChromeStorageAdapter(area as unknown as typeof chrome.storage.local);
    await expect(adapter.get()).rejects.toThrow('无法保护');
    await expect(adapter.set(emptyState())).rejects.toThrow('无法保护');
    expect(area.get).not.toHaveBeenCalled();
    expect(area.set).not.toHaveBeenCalled();
  });
});
