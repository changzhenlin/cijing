import type { AppState, Request, Response, Settings } from './types';

export const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
const PREVIEW_KEY = 'wordnest.preview.v1';

let previewService: Promise<{ handle: (request: Request) => Promise<unknown> }> | undefined;
async function getPreviewService() {
  previewService ??= import('../core/service').then(({ createService }) => createService({
    async get() {
      const raw = localStorage.getItem(PREVIEW_KEY);
      return raw ? JSON.parse(raw) as AppState : undefined;
    },
    async set(state: AppState) {
      localStorage.setItem(PREVIEW_KEY, JSON.stringify(state));
      window.dispatchEvent(new Event('wordnest:change'));
    },
  }));
  return previewService;
}

export async function rpc<T = AppState>(request: Request): Promise<T> {
  if (!isExtension) {
    if (request.type === 'OPEN_APP') {
      window.open(`./index.html#${request.page || 'review'}`, '_blank', 'noopener');
      return undefined as T;
    }
    return (await (await getPreviewService()).handle(request)) as T;
  }
  const response = await chrome.runtime.sendMessage(request) as Response<T> | undefined;
  if (!response) throw new Error('扩展后台暂未响应，请重新加载扩展。');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export function subscribe(listener: () => void) {
  if (isExtension) {
    const handler = (_changes: unknown, area: string) => { if (area === 'local') listener(); };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }
  window.addEventListener('storage', listener);
  window.addEventListener('wordnest:change', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('wordnest:change', listener);
  };
}

export function apiOrigin(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('API 地址必须使用 HTTPS；本机服务可以使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址中不能包含账户、密码、查询参数或片段。');
  return `${url.origin}/*`;
}

export async function requestApiPermission(settings: Settings) {
  const origin = apiOrigin(settings.apiBaseUrl);
  if (!isExtension) return;
  const allowed = await chrome.permissions.request({ origins: [origin] });
  if (!allowed) throw new Error('需要允许访问该 API 地址才能使用翻译。');
}
