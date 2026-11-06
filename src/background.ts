import type { Request, Response } from './shared/types';
import { CoreError, safeError } from './core/errors';
import { createService } from './core/service';
import { createChromeStorageAdapter } from './core/storage';
import { object, parseRequest } from './core/validation';

const CONTENT_REQUESTS = new Set(['GET_PUBLIC_SETTINGS', 'ANALYZE', 'SAVE_ENTRY', 'OPEN_APP']);
const APP_PAGES = new Set(['review', 'library', 'story', 'practice', 'settings']);
const MENU_ID = 'wordnest-context-analyze';

export function isTrustedSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    const origin = `chrome-extension://${extensionId}`;
    if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId
      || url.username || url.password) return false;
    if (sender.origin !== undefined && sender.origin !== origin) return false;
    return url.pathname === '/index.html' || url.pathname === '/popup.html';
  } catch { return false; }
}

export function isContentSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || !sender.tab || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    return sender.origin === undefined || sender.origin === url.origin;
  } catch { return false; }
}

export function createMessageHandler(
  handle: (request: Request) => Promise<unknown>,
  extensionId: string,
  openApp: (page?: string) => Promise<unknown>,
): (message: unknown, sender: chrome.runtime.MessageSender) => Promise<Response> {
  return async (message, sender) => {
    try {
      const trusted = isTrustedSender(sender, extensionId);
      const type = object(message).type;
      if (!trusted && (!isContentSender(sender, extensionId)
        || typeof type !== 'string' || !CONTENT_REQUESTS.has(type))) {
        throw new CoreError('此页面无权执行该操作。');
      }
      const request = parseRequest(message);
      if (request.type === 'OPEN_APP') {
        if (request.page !== undefined && !APP_PAGES.has(request.page)) {
          throw new CoreError('无效的应用页面。');
        }
        await openApp(request.page);
        return { ok: true, data: null };
      }
      return { ok: true, data: await handle(request) };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  };
}

function installBackground(): void {
  const service = createService(createChromeStorageAdapter());
  const handler = createMessageHandler(service.handle, chrome.runtime.id, async page => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`index.html${page ? `#${page}` : ''}`),
    });
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    void handler(message, sender).then(sendResponse);
    return true;
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) return;
      chrome.contextMenus.create({
        id: MENU_ID, title: '用词境解释“%s”', contexts: ['selection'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      }, () => { void chrome.runtime.lastError; });
    });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || !info.selectionText?.trim() || tab?.id === undefined) return;
    const url = info.frameUrl || info.pageUrl || tab.url || '';
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) return;
    } catch { return; }
    void chrome.tabs.sendMessage(tab.id, {
      type: 'CONTEXT_ANALYZE', text: info.selectionText.slice(0, 1200),
    }, { frameId: info.frameId ?? 0 }).catch(() => undefined);
  });
}

// The guard allows importing sender policy in unit tests and in the local UI preview.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && chrome.storage?.local) {
  installBackground();
}
