import { describe, expect, it } from 'vitest';
import { extractModelText, parseModelJson } from './model-response';

const result = { message: '连接成功', nested: { items: ['braces { } [ ]', 'quote " and backslash \\'] } };
const json = JSON.stringify(result);

describe('model JSON extraction', () => {
  it.each([
    json,
    `\uFEFF  ${json}  `,
    `\`\`\`json\n${json}\n\`\`\``,
    `这是结果：\n\`\`\`JSON\n${json}\n\`\`\`\n以上是返回结果。`,
    `Here is the JSON:\n${json}\nDone.`,
    `<think>Ignore this {"message":"reasoning"} object.</think>\n${json}`,
    `<thinking>{"message":"reasoning"}</thinking>\n<analysis>More reasoning.</analysis>\n${json}`,
  ])('extracts one complete object while preserving escaped strings %#', content => {
    expect(parseModelJson(content)).toEqual(result);
  });

  it.each([
    'not JSON',
    'null',
    JSON.stringify([result]),
    `\`\`\`json\n[${json}]\n\`\`\``,
    `{"incomplete": ${json}`,
    '{"message":"missing quote}',
    '{"message":"bad",}',
    '{"message":undefined}',
    `{"broken":]}\n${json}`,
    `<think>${json}</think>`,
    `<think>Unfinished reasoning ${json}`,
    `${json}\n{"message":"another answer"}`,
    '{"message":"ready","__proto__":{"polluted":true}}',
    '{"message":"ready","nested":{"constructor":{"prototype":{"polluted":true}}}}',
  ])('rejects invalid, ambiguous, incomplete or unsafe data %#', content => {
    expect(() => parseModelJson(content)).toThrow('模型');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not strip reasoning-looking strings inside JSON', () => {
    const value = { message: '<think>Literal learning material.</think>' };
    expect(parseModelJson(JSON.stringify(value))).toEqual(value);
  });
});

describe('response text extraction', () => {
  it.each(['openai', 'anthropic'] as const)('reads known gateway envelopes with %s requests', style => {
    expect(extractModelText({ content: [{ type: 'text', text: json }] }, style)).toBe(json);
    expect(extractModelText({ content: json }, style)).toBe(json);
    expect(extractModelText({ choices: [{ message: { content: json } }] }, style)).toBe(json);
    expect(extractModelText({
      choices: [{ message: { content: [
        { type: 'thinking', thinking: '{"message":"not an answer"}' },
        { type: 'text', text: json.slice(0, 15) },
        { type: 'text', text: json.slice(15) },
      ] } }],
    }, style)).toBe(json);
  });

  it.each([
    [{ content: [] }, '正文'],
    [{ content: [{ type: 'thinking', thinking: json }] }, '正文'],
    [{ choices: [{ message: { content: null, reasoning_content: json } }] }, '正文'],
    [{ choices: [{ message: { content: '' } }] }, '正文'],
    [{ content: [{ type: 'text', text: 1 }] }, '接口格式'],
    [{ content: [{ text: json }] }, '接口格式'],
    [{ choices: [] }, '接口格式'],
    [{ choices: [null] }, '接口格式'],
    [{ content: [{ type: 'text', text: json }], stop_reason: 'max_tokens' }, '截断'],
    [{ choices: [{ message: { content: json }, finish_reason: 'length' }] }, '截断'],
    [{ choices: [{ message: { content: null, refusal: 'private provider refusal' } }] }, '拒绝'],
    [{ choices: [{ message: { content: json }, finish_reason: 'content_filter' }] }, '拒绝'],
    [{ content: [{ type: 'text', text: json }], stop_reason: 'refusal' }, '拒绝'],
  ] as const)('gives a specific safe error for invalid response %#', (envelope, expected) => {
    expect(() => extractModelText(envelope, 'anthropic')).toThrow(expected);
    expect(() => extractModelText(envelope, 'anthropic')).not.toThrow('private provider refusal');
  });
});
