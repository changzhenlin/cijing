import type { AppState, StorageAdapter } from '../shared/types';
import { CoreError } from './errors';

export const STORAGE_KEY = 'wordnest.state';

export function createChromeStorageAdapter(area: typeof chrome.storage.local = chrome.storage.local): StorageAdapter {
  // Fail closed: no read or write occurs unless web content has lost direct access.
  const ready = Promise.resolve()
    .then(() => area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .then(() => undefined, () => { throw new CoreError('无法保护本地数据，请更新 Chrome 后重试。'); });
  // Initialization may fail before the first request; retain the rejection for that request.
  void ready.catch(() => undefined);
  return {
    async get() {
      await ready;
      const result = await area.get(STORAGE_KEY);
      return result[STORAGE_KEY] as AppState | undefined;
    },
    async set(state) {
      await ready;
      await area.set({ [STORAGE_KEY]: state });
    },
  };
}
