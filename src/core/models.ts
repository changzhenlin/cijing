import type { ModelOption, Settings } from '../shared/types';
import { CoreError } from './errors';
import { fetchJson, providerBase, withApiTimeout } from './transport';
import { object, parseModelId, text } from './validation';

const MAX_MODELS = 1000;
const MAX_PAGES = 10;

export async function getModels(settings: Settings): Promise<ModelOption[]> {
  const endpoint = `${providerBase(settings)}/models`;
  return withApiTimeout(async signal => {
    const models = new Map<string, ModelOption>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let rows = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(endpoint);
      if (cursor !== undefined) {
        url.searchParams.set(settings.apiStyle === 'anthropic' ? 'after_id' : 'after', cursor);
      }
      const result = await fetchJson(url.href, settings, signal, { maxBytes: 1_000_000 });
      try {
        if (!Array.isArray(result.data)) throw new Error();
        if (result.has_more !== undefined && typeof result.has_more !== 'boolean') throw new Error();
        if (result.last_id !== undefined && result.last_id !== null) parseModelId(result.last_id);
        for (const value of result.data.slice(0, MAX_MODELS - rows)) {
          const model = object(value);
          const id = parseModelId(model.id);
          const name = settings.apiStyle === 'anthropic' && model.display_name !== undefined
            ? text(model.display_name, 300) : id;
          if (!models.has(id)) models.set(id, { id, name });
          rows += 1;
        }
        const next = result.has_more === true ? parseModelId(result.last_id) : undefined;
        if (next !== undefined && (!result.data.length || cursors.has(next))) throw new Error();
        if (rows >= MAX_MODELS || next === undefined || page === MAX_PAGES - 1) return [...models.values()];
        cursors.add(next);
        cursor = next;
      } catch {
        throw new CoreError('模型列表格式或分页信息无效，请检查接口是否支持获取模型。');
      }
    }
    return [...models.values()];
  });
}
