import type { Analysis, AnalyzePayload } from '../shared/types';

interface Example extends Analysis {
  context: string;
  source: AnalyzePayload['source'];
}

// Short source excerpts from the linked MDN pages; the bilingual examples are authored exercises.
const EXAMPLES: Example[] = [
  {
    term: 'closure', type: 'word', phonetic: '', partOfSpeech: '名词',
    meaning: '闭包：函数连同对其词法环境中变量的引用。',
    context: 'A closure is the combination of a function bundled together (enclosed) with references to its surrounding state (the lexical environment).',
    contextTranslation: '闭包是函数与其周围状态（词法环境）的引用组合而成的整体。',
    example: { en: 'The closure keeps the counter private.', zh: '这个闭包让计数器保持私有。' },
    technicalNote: '内部函数仍能访问其定义时外层作用域的变量。',
    source: { title: 'Closures - MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures' },
  },
  {
    term: 'Promise', type: 'word', phonetic: '', partOfSpeech: '名词',
    meaning: '表示异步操作最终完成或失败及其结果的对象。',
    context: 'A Promise is an object representing the eventual completion or failure of an asynchronous operation.',
    contextTranslation: 'Promise 是一个表示异步操作最终完成或失败的对象。',
    example: { en: 'The Promise resolves when the file is ready.', zh: '文件准备好后，这个 Promise 会兑现。' },
    technicalNote: 'Promise 本身不是最终值，而是用于组合异步结果的对象。',
    source: { title: 'Using promises - MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises' },
  },
  {
    term: 'await', type: 'word', phonetic: '', partOfSpeech: '运算符',
    meaning: '等待 Promise 敲定，并取得兑现值，或抛出拒绝原因。',
    context: 'The await operator is used to wait for a Promise and get its fulfillment value.',
    contextTranslation: 'await 运算符用于等待 Promise，并获取其兑现值。',
    example: { en: 'Use await to read the response before updating the view.', zh: '先用 await 读取响应，再更新视图。' },
    technicalNote: '暂停当前异步函数的执行，不会因此阻塞整个浏览器线程。',
    source: { title: 'await - MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await' },
  },
  {
    term: 'event loop', type: 'phrase', phonetic: '', partOfSpeech: '名词短语',
    meaning: '事件循环：协调执行任务、事件处理和异步回调的运行机制。',
    context: 'JavaScript has a runtime model based on an event loop, which is responsible for executing the code, collecting and processing events.',
    contextTranslation: 'JavaScript 的运行模型基于事件循环，负责执行代码、收集并处理事件。',
    example: { en: 'A long task can keep the event loop busy.', zh: '一个长任务可能让事件循环持续忙碌。' },
    technicalNote: '异步回调需要等待当前任务让出执行权。',
    source: { title: 'JavaScript execution model - MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model' },
  },
  {
    term: 'callback', type: 'word', phonetic: '', partOfSpeech: '名词',
    meaning: '回调函数：作为参数传入另一个函数，并由后者调用的函数。',
    context: 'A callback function is a function passed into another function as an argument.',
    contextTranslation: '回调函数是作为参数传入另一个函数的函数。',
    example: { en: 'The callback updates the label after the click.', zh: '点击后，这个回调会更新标签。' },
    technicalNote: '回调既可能同步调用，也可能异步调用，取决于接收它的 API。',
    source: { title: 'Callback function - MDN', url: 'https://developer.mozilla.org/en-US/docs/Glossary/Callback_function' },
  },
  {
    term: 'immutable', type: 'word', phonetic: '', partOfSpeech: '形容词',
    meaning: '不可变的：对象或值创建后，其内容无法再被修改。',
    context: 'An immutable object is an object whose content cannot be changed.',
    contextTranslation: '不可变对象是内容无法被修改的对象。',
    example: { en: 'An immutable value can be safely shared.', zh: '不可变值可以被安全地共享。' },
    technicalNote: 'const 限制的是变量重新赋值，并不自动让其引用的对象不可变。',
    source: { title: 'Immutable - MDN', url: 'https://developer.mozilla.org/en-US/docs/Glossary/Immutable' },
  },
  {
    term: 'destructuring', type: 'word', phonetic: '', partOfSpeech: '名词',
    meaning: '解构：将数组中的值或对象中的属性提取到不同变量中的语法。',
    context: 'It unpacks values from arrays, or properties from objects, into distinct variables.',
    contextTranslation: '它把数组中的值或对象中的属性提取到不同的变量中。',
    example: { en: 'Use destructuring to extract the name from the user object.', zh: '使用解构从用户对象中提取姓名。' },
    technicalNote: '可结合默认值、重命名和剩余语法；缺失属性的默认结果是 undefined。',
    source: { title: 'Destructuring - MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Destructuring' },
  },
];

export function exampleInputs(): { analysis: Analysis; payload: AnalyzePayload }[] {
  return EXAMPLES.map(({ context, source, ...analysis }) => ({
    analysis: structuredClone(analysis),
    payload: { text: analysis.term, context, source: { ...source } },
  }));
}
