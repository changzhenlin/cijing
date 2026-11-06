import type { Settings } from '../shared/types';
import { CoreError } from './errors';
import { assertJson, object } from './validation';

const JSON_ERROR = '模型正文中没有有效的 JSON 对象，请重试；若持续出现，请更换模型。';
const ENVELOPE_ERROR = '模型响应格式不匹配，请检查设置中的接口格式和 API 地址。';
const EMPTY_ERROR = '模型未返回可用的正文，请重试或更换模型。';

function responseObject(value: unknown): Record<string, unknown> {
  try { return object(value); } catch { throw new CoreError(ENVELOPE_ERROR); }
}

function parseObject(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    assertJson(parsed);
    return object(parsed);
  } catch {
    throw new CoreError(JSON_ERROR);
  }
}

export function parseModelJson(content: string): Record<string, unknown> {
  // Some gateways put reasoning before the answer in the same text field.
  const answer = content.trim().replace(/^(?:<(think|thinking|analysis)>[\s\S]*?<\/\1>\s*)+/iu, '');
  if (/^<(?:think|thinking|analysis)>/iu.test(answer)) throw new CoreError(JSON_ERROR);

  let start = -1;
  let candidate: string | undefined;
  const brackets: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < answer.length; index += 1) {
    const character = answer[index];
    if (start === -1) {
      if (character !== '{' && character !== '[') continue;
      // Never pick one of several objects or an object nested in a top-level array.
      if (candidate !== undefined) throw new CoreError('模型返回了多个 JSON 对象，无法确定结果，请重试。');
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') brackets.push(character);
    else if (character === '}' || character === ']') {
      const opening = brackets.pop();
      if (opening !== (character === '}' ? '{' : '[')) throw new CoreError(JSON_ERROR);
      if (!brackets.length) {
        candidate = answer.slice(start, index + 1);
        start = -1;
      }
    }
  }
  if (start !== -1 || candidate === undefined) throw new CoreError(JSON_ERROR);
  return parseObject(candidate);
}

function textContent(value: unknown): string {
  if (typeof value === 'string') {
    if (!value.trim()) throw new CoreError(EMPTY_ERROR);
    return value;
  }
  if (!Array.isArray(value) || value.length > 1000) throw new CoreError(ENVELOPE_ERROR);
  const parts: string[] = [];
  for (const item of value) {
    const block = responseObject(item);
    if (typeof block.type !== 'string') throw new CoreError(ENVELOPE_ERROR);
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new CoreError(ENVELOPE_ERROR);
      parts.push(block.text);
    }
  }
  if (!parts.join('').trim()) throw new CoreError(EMPTY_ERROR);
  return parts.join('');
}

export function extractModelText(envelope: Record<string, unknown>, apiStyle: Settings['apiStyle']): string {
  const useMessages = apiStyle === 'anthropic'
    ? Object.hasOwn(envelope, 'content')
    : !Object.hasOwn(envelope, 'choices') && Object.hasOwn(envelope, 'content');
  const choice = !useMessages && Array.isArray(envelope.choices) && envelope.choices.length
    ? responseObject(envelope.choices[0]) : undefined;
  if (envelope.stop_reason === 'max_tokens' || choice?.finish_reason === 'length') {
    throw new CoreError('模型输出被截断，请缩短选中文字或更换模型后重试。');
  }
  if (envelope.stop_reason === 'refusal' || choice?.finish_reason === 'content_filter') {
    throw new CoreError('模型拒绝了本次请求，请调整选中文字后重试。');
  }
  if (useMessages) return textContent(envelope.content);
  if (!choice) throw new CoreError(ENVELOPE_ERROR);
  const message = responseObject(choice.message);
  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    throw new CoreError('模型拒绝了本次请求，请调整选中文字后重试。');
  }
  if (message.content === null || message.content === undefined) throw new CoreError(EMPTY_ERROR);
  return textContent(message.content);
}
