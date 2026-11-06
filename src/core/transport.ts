import type { Settings } from '../shared/types';
import { CoreError } from './errors';
import { apiUrl, assertJson, object } from './validation';

const TIMEOUT_MS = 25_000;

export function providerBase(settings: Settings): string {
  const url = new URL(apiUrl(settings.apiBaseUrl));
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|messages)$/u, '').replace(/\/+$/u, '');
  if (settings.apiStyle === 'anthropic' && (!url.pathname || url.pathname === '/')) {
    url.pathname = '/v1';
  }
  return url.href.replace(/\/+$/u, '');
}

function authHeaders(settings: Settings): Record<string, string> {
  if (!settings.apiKey) throw new CoreError('请先在设置中填写 API 密钥。');
  if (settings.apiStyle === 'anthropic') {
    const headers: Record<string, string> = {
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (new URL(settings.apiBaseUrl).hostname === 'api.anthropic.com') {
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    return headers;
  }
  return { Authorization: `Bearer ${settings.apiKey}` };
}

export async function withApiTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CoreError('模型请求超时（25 秒），请稍后重试。'));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    // Never surface provider errors, fetch exceptions, or request URLs containing private data.
    throw new CoreError('无法连接模型接口，请检查网络、API 地址和域名访问权限。');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

async function readBody(response: globalThis.Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    throw new CoreError('模型接口响应过长，请缩小请求范围后重试。');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new CoreError('模型接口响应过长，请缩小请求范围后重试。');
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchJson(
  url: string,
  settings: Settings,
  signal: AbortSignal,
  options: { body?: unknown; maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const headers = authHeaders(settings);
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CoreError('API 鉴权失败，请检查密钥和接口访问权限。');
    }
    if (response.status === 429) throw new CoreError('API 请求过于频繁或额度不足，请稍后重试。');
    throw new CoreError('模型接口请求失败，请检查 API 地址、模型和账户状态。');
  }
  const body = await readBody(response, options.maxBytes ?? 128_000);
  try {
    const result: unknown = JSON.parse(body);
    assertJson(result);
    return object(result);
  } catch {
    throw new CoreError('模型接口返回的数据无效，请重试。');
  }
}
