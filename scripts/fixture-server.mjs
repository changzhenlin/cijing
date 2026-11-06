// Local test fixture only. No external requests or real API keys are used.
import { createServer } from 'node:http';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WordNest integration fixture</title>
<style>body{font:20px/1.9 Georgia,serif;max-width:800px;margin:70px auto;padding:24px;color:#273b32}h1{font-size:38px}p{margin:35px 0}code{background:#edf4ee;padding:3px 6px}input{font:inherit;padding:10px;width:80%}</style></head>
<body><h1>Understanding asynchronous JavaScript</h1>
<p id="word">The resolve function fulfills a promise with the provided value.</p>
<p id="phrase">The configuration defaults to a secure connection.</p>
<p id="sentence">When the promise is resolved, the callback that was registered earlier will run after the current task completes.</p>
<p id="repeat">The first resolve is a function; the second <em>resolve</em> refers to a method.</p>
<p id="error">The unavailable service will return an error.</p>
<input aria-label="private input" value="Private input selection should never be sent." />
</body></html>`;

const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-api-key,anthropic-version,anthropic-dangerous-direct-browser-access');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (/\/models(?:\?|$)/.test(request.url) && request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [
      { id: 'fixture-model', display_name: 'Fixture Model', type: 'model' },
      { id: 'fixture-fast', display_name: 'Fixture Fast', type: 'model' },
      { id: 'fixture-wrapped', display_name: 'Fixture Wrapped JSON', type: 'model' },
      { id: 'fixture-gateway', display_name: 'Fixture Gateway Envelope', type: 'model' },
      { id: 'fixture-invalid', display_name: 'Fixture Invalid JSON', type: 'model' },
    ], has_more: false, last_id: 'fixture-fast' }));
    return;
  }
  if (request.method !== 'POST') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
  let body = '';
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body);
  const native = request.url.endsWith('/messages');
  const system = native ? data.system : data.messages?.[0]?.content || '';
  const user = native ? data.messages?.[0]?.content : data.messages?.[1]?.content || '';
  let content;
  if (system.includes('这是连接测试')) content = { message: '连接成功' };
  else if (system.includes('短文') || system.includes('故事')) {
    const quoted = JSON.parse(user.slice(user.indexOf('[')));
    const terms = quoted.map(item => item.term);
    content = { title: 'A Small Refactor', english: `During a code review, the team worked with ${terms.join(', ')}. Each expression helped explain the behavior of the system. They wrote a small test and made the documentation clearer.`, chinese: '在一次代码审查中，团队结合这些表达理解了系统行为，编写了测试，并改进了文档。' };
  } else {
    const quoted = JSON.parse(user.slice(user.indexOf('{')));
    const term = quoted.selection;
    if (term === 'unavailable') { response.writeHead(429); response.end('{}'); return; }
    const sentence = term.split(/\s+/).length > 8;
    content = {
      term, type: sentence ? 'sentence' : term.includes(' ') ? 'phrase' : 'word',
      phonetic: term === 'resolve' ? '/rɪˈzɒlv/' : '', partOfSpeech: sentence ? '' : 'v.',
      meaning: sentence ? '当 Promise 被解决后，先前注册的回调会在当前任务完成后运行。' : term === 'defaults to' ? '默认为；在未指定其他值时采用' : '使 Promise 兑现，并采用指定的结果值',
      contextTranslation: 'resolve 函数使用提供的值兑现一个 Promise。',
      example: { en: sentence ? 'The callback runs after the task completes.' : `The helper uses ${term} to describe the result.`, zh: '辅助函数使用这个表达描述结果。' },
      technicalNote: '在 JavaScript 中，resolve 用于决定 Promise 的最终结果。',
      ...(sentence ? { sentenceAnalysis: { skeleton: 'the callback will run（回调会运行）', chunks: [
        { text: 'When the promise is resolved', role: '时间状语', meaning: '当 Promise 被解决时' },
        { text: 'the callback that was registered earlier will run', role: '主句与定语从句', meaning: '之前注册的回调将运行' },
        { text: 'after the current task completes', role: '时间状语', meaning: '在当前任务完成之后' },
      ] } } : {}),
    };
  }
  response.setHeader('Content-Type', 'application/json');
  const serialized = data.model === 'fixture-invalid' ? 'This is not JSON.'
    : data.model === 'fixture-wrapped' ? `<think>Not part of the output.</think>\nHere is the result:\n\`\`\`json\n${JSON.stringify(content)}\n\`\`\`\nDone.`
    : JSON.stringify(content);
  response.end(JSON.stringify(native && data.model !== 'fixture-gateway'
    ? { content: [{ type: 'thinking', thinking: 'Not part of the output.' }, { type: 'text', text: serialized }], stop_reason: 'end_turn' }
    : { choices: [{ message: { content: data.model === 'fixture-gateway' ? [{ type: 'text', text: serialized }] : serialized }, finish_reason: 'stop' }] }));
});
server.listen(8787, '127.0.0.1', () => console.log('WordNest test fixture: http://127.0.0.1:8787'));
