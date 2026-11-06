import type {
  Analysis, AnalyzePayload, AnalyzeResult, Entry, PublicSettings, Request, Response,
} from './shared/types';

type ContentRequest = Extract<Request, { type: 'GET_PUBLIC_SETTINGS' | 'ANALYZE' | 'SAVE_ENTRY' | 'OPEN_APP' }>;
type Point = { x: number; y: number };
type Anchor = { left: number; right: number; top: number; bottom: number };
type Capture = { payload: AnalyzePayload; range: Range | null; anchor: Anchor; overLimit?: number };
type Phase = 'hidden' | 'trigger' | 'loading' | 'result' | 'error';

const MAX_SELECTION = 1200;
const MAX_CONTEXT = 2400;
const SETTINGS_TTL = 2000;
const AUTO_DELAY = 750;
const EXCLUDED = 'input, textarea, select, option, [contenteditable], [role="textbox"], [role="searchbox"], script, style, noscript, template, svg, canvas';
const BLOCK_DISPLAY = /^(block|flow-root|list-item|table-cell|table-caption|flex|grid|inline-block|inline-flex|inline-grid)$/;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function englishText(text: string): boolean {
  return /[a-z]/i.test(text) && !/(?!\p{Script=Latin})\p{L}/u.test(text);
}

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function excluded(node: Node | null): boolean {
  let element = elementOf(node);
  while (element) {
    if (element.matches(EXCLUDED) || (element instanceof HTMLElement && element.isContentEditable)) return true;
    const root = element.getRootNode();
    element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return document.designMode.toLowerCase() === 'on';
}

function activeEditor(): boolean {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return excluded(active);
}

function blockFor(node: Node): Element | null {
  let element = elementOf(node);
  while (element && element !== document.body && element !== document.documentElement) {
    if (BLOCK_DISPLAY.test(getComputedStyle(element).display)) return element;
    element = element.parentElement;
  }
  return null;
}

function containsEditor(range: Range): boolean {
  if (excluded(range.startContainer) || excluded(range.endContainer)) return true;
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return (node as Element).matches(EXCLUDED) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  return walker.nextNode() !== null;
}

function surroundingSentence(range: Range, selected: string): string {
  const block = blockFor(range.startContainer);
  if (!block || blockFor(range.endContainer) !== block) return selected;
  let before = '';
  let middle = '';
  let after = '';
  let visited = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        if (node.matches(`${EXCLUDED}, [hidden], [aria-hidden="true"]`)
          || style.display === 'none' || style.visibility === 'hidden'
          || BLOCK_DISPLAY.test(style.display)) return NodeFilter.FILTER_REJECT;
        return node.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Keep a bounded window around the actual DOM offsets, even when the word
  // occurs several times or is split across inline elements.
  let node: Node | null;
  while ((node = walker.nextNode()) && ++visited <= 10000) {
    const isText = node.nodeType === Node.TEXT_NODE;
    const data = isText ? (node as Text).data : '\n';
    const parent = node.parentNode;
    if (!parent) continue;
    const index = isText ? 0 : Array.prototype.indexOf.call(parent.childNodes, node) as number;
    const startSide = range.comparePoint(isText ? node : parent, index);
    const endSide = range.comparePoint(isText ? node : parent, isText ? data.length : index + 1);
    if (endSide < 0) {
      before = (before + data.slice(-MAX_CONTEXT)).slice(-MAX_CONTEXT);
    } else if (startSide > 0) {
      after += data.slice(0, MAX_CONTEXT - after.length);
    } else {
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : data.length;
      before = (before + data.slice(Math.max(0, start - MAX_CONTEXT), start)).slice(-MAX_CONTEXT);
      middle += data.slice(start, end);
      after += data.slice(end, end + MAX_CONTEXT - after.length);
    }
    if (after.length >= MAX_CONTEXT) break;
  }
  if (normalize(middle) !== selected) return selected;
  const text = before + middle + after;
  const start = before.length;
  const end = start + middle.length;
  let sentenceStart = start;
  let sentenceEnd = end;
  const segments = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text);
  for (const segment of segments) {
    if (segment.index < end && segment.index + segment.segment.length > start) {
      sentenceStart = Math.min(sentenceStart, segment.index);
      sentenceEnd = Math.max(sentenceEnd, segment.index + segment.segment.length);
    }
  }
  const spare = MAX_CONTEXT - middle.length;
  const clipStart = Math.max(sentenceStart, Math.min(start - Math.floor(spare / 2), sentenceEnd - MAX_CONTEXT));
  return normalize(text.slice(clipStart, Math.min(sentenceEnd, clipStart + MAX_CONTEXT))) || selected;
}

function viewport(): { left: number; top: number; right: number; bottom: number } {
  const view = window.visualViewport;
  const left = view?.offsetLeft ?? 0;
  const top = view?.offsetTop ?? 0;
  return { left, top, right: left + (view?.width ?? innerWidth), bottom: top + (view?.height ?? innerHeight) };
}

function rangeAnchor(range: Range, point?: Point): Anchor | null {
  const view = viewport();
  const rects = Array.from(range.getClientRects()).filter(rect =>
    rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
    && rect.right > view.left && rect.left < view.right);
  if (!rects.length) return null;
  const distance = (rect: DOMRect) => point
    ? Math.max(rect.left - point.x, 0, point.x - rect.right) ** 2
      + Math.max(rect.top - point.y, 0, point.y - rect.bottom) ** 2
    : 0;
  const rect = point ? rects.reduce((best, next) => distance(next) < distance(best) ? next : best) : rects[rects.length - 1];
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

function source(): AnalyzePayload['source'] {
  return { title: document.title, url: location.href };
}

function captureSelection(point?: Point): Capture | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || activeEditor()) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (range.startContainer.getRootNode() !== document || range.endContainer.getRootNode() !== document
    || containsEditor(range)) return null;
  const raw = range.toString().trim();
  const text = normalize(raw);
  if (!englishText(text)) return null;
  const anchor = rangeAnchor(range, point);
  if (!anchor) return null;
  if (raw.length > MAX_SELECTION) {
    return { payload: { text: text.slice(0, MAX_SELECTION), context: '', source: source() }, range, anchor, overLimit: raw.length };
  }
  return { payload: { text, context: surroundingSentence(range, text), source: source() }, range, anchor };
}

function currentSelection(capture: Capture): boolean {
  if (!capture.range) return true;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  return range.startContainer === capture.range.startContainer && range.startOffset === capture.range.startOffset
    && range.endContainer === capture.range.endContainer && range.endOffset === capture.range.endOffset;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/extension context invalidated|receiving end does not exist|message port closed/i.test(text)) {
    return '扩展连接已中断，请刷新页面后重试。';
  }
  return text.slice(0, 500) || '暂时无法完成操作，请稍后重试。';
}

function send<T>(request: ContentRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => finish(undefined, '请求超时，请稍后重试。'), request.type === 'ANALYZE' ? 90000 : 15000);
    function finish(response?: Response<T>, error?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else if (response?.ok === true) resolve(response.data);
      else reject(new Error(response && response.ok === false ? response.error : '后台未返回有效响应，请刷新页面后重试。'));
    }
    try {
      const pending: unknown = chrome.runtime.sendMessage(request, (response: Response<T>) => {
        const error = chrome.runtime.lastError?.message;
        finish(response, error);
      });
      // Chrome uses the callback when provided; Promise-based bridges can
      // return a thenable instead. Settle once without sending twice.
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        void (pending as Promise<Response<T>>).then(response => finish(response), error => finish(undefined, errorText(error)));
      }
    } catch (error) {
      finish(undefined, errorText(error));
    }
  });
}

function start(): void {
  if (!document.documentElement || document.getElementById('wordnest-root')) return;
  const host = document.createElement('div');
  host.id = 'wordnest-root';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0 auto auto 0', 'important');
  host.style.setProperty('width', '0', 'important');
  host.style.setProperty('height', '0', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .trigger, .panel {
      position: fixed; margin: 0; pointer-events: auto; color: #233c33;
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      letter-spacing: 0; text-align: left; direction: ltr; color-scheme: light;
    }
    button { appearance: none; font: inherit; letter-spacing: 0; cursor: pointer; }
    button:focus-visible, summary:focus-visible { outline: 2px solid #20765c; outline-offset: 3px; }
    button:disabled { cursor: wait; opacity: .65; }
    .trigger {
      border: 1px solid #20765c; border-radius: 6px; background: #20765c; color: #fff;
      padding: 6px 12px; min-height: 34px; white-space: nowrap; line-height: 20px;
      box-shadow: 0 3px 12px #163d2926;
    }
    .trigger:hover, .primary:hover { background: #175c47; }
    .panel {
      display: flex; flex-direction: column; width: 396px; border: 1px solid #d7e4dc;
      border-radius: 8px; background: #fff; box-shadow: 0 12px 44px #173d2d29, 0 2px 6px #173d2d0d;
      overflow: hidden; overflow-wrap: anywhere; overscroll-behavior: contain;
    }
    .header { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-bottom: 1px solid #edf1ed; flex-shrink: 0; }
    .brand { font-weight: 700; color: #20765c; font-size: 15px; }
    .subtitle { font-size: 12px; color: #78867f; flex: 1; }
    .quiet { border: 0; background: transparent; color: #60776b; padding: 4px 6px; border-radius: 4px; font-size: 12px; }
    .quiet:hover { color: #20765c; background: #eff6f2; }
    .close { border: 0; border-radius: 4px; background: transparent; color: #74837a; width: 28px; height: 28px; font-size: 23px; line-height: 24px; padding: 0; flex-shrink: 0; }
    .close:hover { background: #eff6f2; color: #20765c; }
    .body { padding: 18px; overflow: auto; overscroll-behavior: contain; min-height: 0; scrollbar-width: thin; }
    .term { margin: 0; color: #173f30; font-size: 22px; font-weight: 650; line-height: 1.35; white-space: pre-wrap; }
    .term.sentence { font-size: 17px; line-height: 1.55; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 7px; color: #728178; font-size: 12px; }
    .meaning { margin: 12px 0 0; color: #233c33; font-size: 16px; line-height: 1.75; white-space: pre-wrap; }
    .section { margin-top: 18px; }
    .label { margin: 0 0 6px; color: #20765c; font-size: 12px; font-weight: 650; }
    .text { margin: 0; white-space: pre-wrap; }
    .english { color: #45574d; font-size: 13px; }
    .translation { margin-top: 5px; color: #233c33; font-size: 14px; }
    .original { padding-left: 10px; border-left: 2px solid #c8dfd1; }
    .technical { padding: 11px 12px; background: #f2f7f4; border-radius: 4px; font-size: 13px; }
    .technical .label { margin-bottom: 4px; }
    .chunks { margin: 8px 0 0; padding: 0; list-style: none; }
    .chunk { padding: 9px 0; border-bottom: 1px solid #edf1ed; }
    .chunk:last-child { padding-bottom: 0; border: 0; }
    .chunk-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
    .chunk-text { font-size: 13px; font-weight: 600; color: #344f40; }
    .role { font-size: 11px; color: #7b877f; }
    .source { margin-top: 18px; padding-top: 10px; border-top: 1px solid #edf1ed; color: #7b877f; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 11px 14px; border-top: 1px solid #edf1ed; flex-shrink: 0; }
    .status { color: #708176; font-size: 12px; flex: 1; min-width: 70px; }
    .saved { color: #20765c; font-weight: 600; }
    .primary { border: 1px solid #20765c; border-radius: 5px; background: #20765c; color: #fff; padding: 5px 11px; font-size: 12px; }
    .footer-error { flex-basis: 100%; margin: 0; color: #ac443d; font-size: 12px; white-space: pre-wrap; }
    .loading { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding: 14px 0; color: #60776b; font-size: 13px; }
    .spinner { width: 16px; height: 16px; flex-shrink: 0; border: 2px solid #d9e9df; border-top-color: #20765c; border-radius: 50%; animation: spin .8s linear infinite; }
    .error-title { color: #934e41; font-size: 15px; font-weight: 600; margin: 18px 0 5px; }
    .error-message { margin: 0; color: #6f665f; font-size: 13px; white-space: pre-wrap; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    @media (forced-colors: active) { .trigger, .panel, .primary { border: 1px solid ButtonText; } }
  `;

  function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(text: string, className: string, action: () => void): HTMLButtonElement {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }
  const trigger = button('词境 解释', 'trigger', () => {
    if (capture) void analyze(capture);
  });
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  // A pointer click must not collapse the page selection before ANALYZE.
  trigger.addEventListener('pointerdown', event => event.preventDefault());
  trigger.addEventListener('mousedown', event => event.preventDefault());
  const panel = node('section', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '词境 · 语境解释');
  panel.setAttribute('aria-modal', 'false');
  const header = node('header', 'header');
  const close = button('×', 'close', dismiss);
  close.title = '关闭解释';
  close.setAttribute('aria-label', '关闭解释');
  header.append(node('span', 'brand', '词境'), node('span', 'subtitle', '语境解释'), button('设置', 'quiet', () => void openApp('settings')), close);
  const body = node('div', 'body');
  body.setAttribute('aria-live', 'polite');
  const footer = node('footer', 'footer');
  panel.append(header, body, footer);
  trigger.hidden = true;
  panel.hidden = true;
  shadow.append(style, trigger, panel);
  document.documentElement.append(host);

  let phase: Phase = 'hidden';
  let capture: Capture | null = null;
  let epoch = 0;
  let autoTimer = 0;
  let selectionTimer = 0;
  let positionFrame = 0;
  let dragging = false;
  let settings: PublicSettings | null = null;
  let settingsAt = 0;
  let settingsVersion = 0;
  let settingsPending: Promise<PublicSettings> | null = null;
  let menu: { at: number; point: Point; blocked: boolean; capture: Capture | null } | null = null;

  function cancelAuto(): void {
    clearTimeout(autoTimer);
    autoTimer = 0;
  }
  function dismiss(): void {
    const focusedInside = shadow.activeElement !== null;
    ++epoch;
    cancelAuto();
    clearTimeout(selectionTimer);
    capture = null;
    phase = 'hidden';
    trigger.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    if (focusedInside && shadow.activeElement instanceof HTMLElement) shadow.activeElement.blur();
  }
  async function publicSettings(force = false): Promise<PublicSettings> {
    if (!force && settings && Date.now() - settingsAt < SETTINGS_TTL) return settings;
    if (settingsPending) return settingsPending;
    const version = settingsVersion;
    const pending = send<PublicSettings>({ type: 'GET_PUBLIC_SETTINGS' }).then(value => {
      if (!value || typeof value.enabled !== 'boolean' || typeof value.autoSave !== 'boolean'
        || !['button', 'auto'].includes(value.selectionMode)) throw new Error('无法读取划词设置，请打开设置后重试。');
      if (version !== settingsVersion) return publicSettings();
      const result: PublicSettings = { enabled: value.enabled, autoSave: value.autoSave, selectionMode: value.selectionMode };
      if (version === settingsVersion) {
        settings = result;
        settingsAt = Date.now();
        if (!result.enabled) dismiss();
      }
      return result;
    });
    settingsPending = pending;
    try {
      return await pending;
    } finally {
      if (settingsPending === pending) settingsPending = null;
    }
  }
  function reposition(): void {
    if (!capture || phase === 'hidden') return;
    if (capture.range) {
      if (!capture.range.startContainer.isConnected || !capture.range.endContainer.isConnected) return dismiss();
      const next = rangeAnchor(capture.range, {
        x: (capture.anchor.left + capture.anchor.right) / 2,
        y: capture.anchor.bottom,
      });
      if (!next) return dismiss();
      capture.anchor = next;
    }
    const view = viewport();
    const margin = 10;
    const gap = 8;
    const element = phase === 'trigger' ? trigger : panel;
    const availableWidth = Math.max(0, view.right - view.left - margin * 2);
    const availableHeight = Math.max(0, view.bottom - view.top - margin * 2);
    element.style.maxWidth = `${availableWidth}px`;
    element.style.maxHeight = `${availableHeight}px`;
    const rect = element.getBoundingClientRect();
    const anchor = capture.anchor;
    const left = Math.min(Math.max(view.left + margin, anchor.left), Math.max(view.left + margin, view.right - rect.width - margin));
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - rect.height;
    const top = below + rect.height <= view.bottom - margin ? below
      : above >= view.top + margin ? above
        : Math.min(Math.max(view.top + margin, below), view.bottom - rect.height - margin);
    element.style.left = `${left}px`;
    element.style.top = `${Math.max(view.top + margin, top)}px`;
  }
  function queuePosition(): void {
    if (!positionFrame) positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      reposition();
    });
  }
  function showTrigger(value: Capture): void {
    capture = value;
    phase = 'trigger';
    panel.hidden = true;
    trigger.hidden = false;
    trigger.setAttribute('aria-expanded', 'false');
    reposition();
  }
  function showPanel(value: Capture, state: Phase): void {
    capture = value;
    phase = state;
    trigger.hidden = true;
    trigger.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    body.scrollTop = 0;
    body.replaceChildren();
    footer.replaceChildren();
  }
  function term(text: string, sentence = false): void {
    body.append(node('h2', `term${sentence || text.length > 65 ? ' sentence' : ''}`, text));
  }
  function section(label: string, ...children: HTMLElement[]): void {
    const element = node('section', 'section');
    element.append(node('h3', 'label', label), ...children);
    body.append(element);
  }
  function appendSource(value: Capture): void {
    const sourceLine = node('div', 'source', `来源 · ${value.payload.source.title || value.payload.source.url}`);
    sourceLine.title = value.payload.source.url;
    body.append(sourceLine);
  }
  function footerError(error: unknown): void {
    footer.querySelector('.footer-error')?.remove();
    const message = node('p', 'footer-error', errorText(error));
    message.setAttribute('role', 'alert');
    footer.append(message);
    queuePosition();
  }
  async function openApp(page: 'settings' | 'library' | 'review'): Promise<void> {
    const token = epoch;
    try {
      await send({ type: 'OPEN_APP', page });
    } catch (error) {
      if (token === epoch && phase !== 'hidden') footerError(error);
    }
  }
  function showError(value: Capture, error: unknown): void {
    showPanel(value, 'error');
    panel.setAttribute('aria-busy', 'false');
    term(value.payload.text);
    body.append(node('p', 'error-title', '暂时无法解释'), node('p', 'error-message', errorText(error)));
    appendSource(value);
    footer.append(node('span', 'status', '检查连接或模型设置'), button('打开设置', 'quiet', () => void openApp('settings')), button('重试', 'primary', () => void analyze(value)));
    reposition();
  }
  function showLengthError(value: Capture): void {
    showPanel(value, 'error');
    panel.setAttribute('aria-busy', 'false');
    term(value.payload.text.length > 100 ? `${value.payload.text.slice(0, 100)}…` : value.payload.text, true);
    body.append(node('p', 'error-title', `选区超过 ${MAX_SELECTION} 个字符`));
    const message = node('p', 'error-message', `当前选中了 ${value.overLimit} 个字符，请缩短英文选区后再试。`);
    message.setAttribute('role', 'alert');
    body.append(message);
    footer.append(node('span', 'status', '可选择单词、短语或一段英文'));
    reposition();
  }
  function showResult(value: Capture, result: AnalyzeResult): void {
    const analysis = result.analysis;
    showPanel(value, 'result');
    panel.setAttribute('aria-busy', 'false');
    term(analysis.term || value.payload.text, analysis.type === 'sentence');
    const meta = node('div', 'meta');
    if (analysis.phonetic) meta.append(node('span', '', analysis.phonetic));
    if (analysis.partOfSpeech) meta.append(node('span', '', analysis.partOfSpeech));
    if (meta.childNodes.length) body.append(meta);
    body.append(node('p', 'meaning', analysis.meaning));
    if (value.payload.context || analysis.contextTranslation) {
      const original = node('div', 'original');
      original.append(node('p', 'text english', value.payload.context));
      if (analysis.contextTranslation) original.append(node('p', 'text translation', analysis.contextTranslation));
      section('原句与翻译', original);
    }
    if (analysis.example?.en || analysis.example?.zh) {
      const example = node('div');
      if (analysis.example.en) example.append(node('p', 'text english', analysis.example.en));
      if (analysis.example.zh) example.append(node('p', 'text translation', analysis.example.zh));
      section('双语例句', example);
    }
    if (analysis.technicalNote) {
      const note = node('div', 'section technical');
      note.append(node('h3', 'label', '专业语境'), node('p', 'text', analysis.technicalNote));
      body.append(note);
    }
    if (analysis.sentenceAnalysis?.skeleton) section('句子主干', node('p', 'text', analysis.sentenceAnalysis.skeleton));
    if (analysis.sentenceAnalysis?.chunks?.length) {
      const chunks = node('ol', 'chunks');
      for (const chunk of analysis.sentenceAnalysis.chunks) {
        const item = node('li', 'chunk');
        const head = node('div', 'chunk-head');
        head.append(node('span', 'chunk-text', chunk.text), node('span', 'role', chunk.role));
        item.append(head, node('p', 'text translation', chunk.meaning));
        chunks.append(item);
      }
      section('意群拆解', chunks);
    }
    appendSource(value);
    const status = node('span', `status${result.entry ? ' saved' : ''}`, result.entry ? '已收藏' : '保留原句与来源');
    status.setAttribute('role', 'status');
    footer.append(status, button('打开词库', 'quiet', () => void openApp('library')));
    if (!result.entry) {
      const save = button('收藏词条', 'primary', () => void saveResult(analysis, value, status, save));
      footer.append(save);
    }
    reposition();
  }
  async function saveResult(analysis: Analysis, value: Capture, status: HTMLElement, save: HTMLButtonElement): Promise<void> {
    const token = epoch;
    save.disabled = true;
    save.textContent = '收藏中…';
    footer.querySelector('.footer-error')?.remove();
    try {
      const entry = await send<Entry>({ type: 'SAVE_ENTRY', analysis, payload: value.payload });
      if (token !== epoch) return;
      if (!entry || typeof entry.id !== 'string') throw new Error('收藏未完成，请重试。');
      save.remove();
      status.textContent = '已收藏';
      status.classList.add('saved');
      queuePosition();
    } catch (error) {
      if (token !== epoch) return;
      save.disabled = false;
      save.textContent = '重试收藏';
      footerError(error);
    }
  }
  async function analyze(value: Capture): Promise<void> {
    if (value.overLimit) return showLengthError(value);
    if (phase === 'loading' && capture === value) return;
    cancelAuto();
    const token = ++epoch;
    showPanel(value, 'loading');
    panel.setAttribute('aria-busy', 'true');
    term(value.payload.text);
    const loading = node('div', 'loading');
    loading.setAttribute('role', 'status');
    const spinner = node('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    loading.append(spinner, node('span', '', '正在理解语境…'));
    body.append(loading);
    footer.append(node('span', 'status', '词境 · WordNest'));
    reposition();
    try {
      const config = await publicSettings();
      if (token !== epoch || !config.enabled) return;
      const result = await send<AnalyzeResult>({ type: 'ANALYZE', payload: value.payload });
      if (token !== epoch) return;
      if (!result?.analysis || typeof result.analysis.meaning !== 'string') throw new Error('解释结果不完整，请重试。');
      showResult(value, result);
    } catch (error) {
      if (token === epoch) showError(value, error);
    }
  }
  function scheduleAuto(value: Capture): void {
    cancelAuto();
    const token = epoch;
    autoTimer = window.setTimeout(() => {
      autoTimer = 0;
      if (token === epoch && phase === 'trigger' && !dragging && currentSelection(value)) void analyze(value);
    }, AUTO_DELAY);
  }
  async function selected(point?: Point): Promise<void> {
    const value = captureSelection(point);
    if (!value) return dismiss();
    if (capture && currentSelection(capture) && phase !== 'hidden') return;
    dismiss();
    const token = epoch;
    try {
      const config = await publicSettings();
      if (token !== epoch || !config.enabled || !currentSelection(value)) return;
      if (value.overLimit) return showLengthError(value);
      showTrigger(value);
      if (config.selectionMode === 'auto') scheduleAuto(value);
    } catch {
      // Unsolicited page selections stay quiet if the extension was reloaded.
      if (token === epoch) dismiss();
    }
  }
  function inside(event: Event): boolean {
    return event.composedPath().includes(host);
  }
  async function contextAnalyze(text: string): Promise<void> {
    const normalized = normalize(text);
    const recentMenu = menu && Date.now() - menu.at < 60000 ? menu : null;
    if (!englishText(normalized) || activeEditor() || recentMenu?.blocked) return;
    const selectedValue = recentMenu?.capture ?? captureSelection(recentMenu?.point);
    const point = recentMenu?.point ?? { x: viewport().left + 24, y: viewport().top + 60 };
    const value: Capture = selectedValue?.payload.text === normalized ? selectedValue
      : {
        payload: { text: normalized.slice(0, MAX_SELECTION), context: normalized.slice(0, MAX_SELECTION), source: source() },
        range: null, anchor: { left: point.x, right: point.x, top: point.y, bottom: point.y },
        ...(text.trim().length > MAX_SELECTION ? { overLimit: text.trim().length } : {}),
      };
    dismiss();
    const token = epoch;
    try {
      const config = await publicSettings(true);
      if (token === epoch && config.enabled) {
        if (value.overLimit) showLengthError(value);
        else await analyze(value);
      }
    } catch (error) {
      if (token === epoch) showError(value, error);
    }
  }

  document.addEventListener('pointerdown', event => {
    if (inside(event)) return;
    dragging = event.button === 0;
    dismiss();
  }, true);
  document.addEventListener('pointerup', event => {
    dragging = false;
    if (inside(event) || event.button !== 0) return;
    if (event.composedPath().some(item => item instanceof Node && excluded(item))) return dismiss();
    clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => void selected({ x: event.clientX, y: event.clientY }), 0);
  }, true);
  document.addEventListener('pointercancel', () => { dragging = false; cancelAuto(); }, true);
  document.addEventListener('selectionchange', () => {
    if (dragging || shadow.activeElement || !capture?.range) return;
    const anchorNode = window.getSelection()?.anchorNode;
    if (anchorNode === host || anchorNode?.getRootNode() === shadow) return;
    if (!currentSelection(capture)) dismiss();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && phase !== 'hidden') {
      if (inside(event)) event.preventDefault();
      dismiss();
    }
  }, true);
  document.addEventListener('keyup', event => {
    if (inside(event) || event.isComposing) return;
    if (event.key === 'Shift' || ((event.shiftKey || event.ctrlKey || event.metaKey)
      && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|a)$/i.test(event.key))) void selected();
  });
  document.addEventListener('contextmenu', event => {
    if (inside(event)) return;
    const point = { x: event.clientX, y: event.clientY };
    menu = {
      at: Date.now(), point,
      blocked: event.composedPath().some(item => item instanceof Node && excluded(item)),
      capture: captureSelection(point),
    };
    cancelAuto();
  }, true);
  document.addEventListener('scroll', event => {
    if (inside(event)) return;
    cancelAuto();
    queuePosition();
  }, true);
  window.addEventListener('resize', queuePosition, { passive: true });
  window.visualViewport?.addEventListener('resize', queuePosition, { passive: true });
  window.visualViewport?.addEventListener('scroll', queuePosition, { passive: true });
  window.addEventListener('pagehide', dismiss);
  document.addEventListener('visibilitychange', () => { if (document.hidden) dismiss(); });
  window.addEventListener('blur', cancelAuto);
  window.addEventListener('focus', () => {
    if (phase !== 'hidden') void publicSettings().catch(() => dismiss());
  });
  // Storage access may be restricted to trusted contexts. Never read values
  // from storage events; refresh just the three public flags through the worker.
  chrome.storage?.onChanged?.addListener((_changes, area) => {
    if (area !== 'local') return;
    settingsAt = 0;
    ++settingsVersion;
    settingsPending = null;
    cancelAuto();
    if (phase !== 'hidden') void publicSettings(true).then(config => {
      if (config.enabled && config.selectionMode === 'auto' && phase === 'trigger' && capture) scheduleAuto(capture);
    }).catch(() => dismiss());
  });
  chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
    if (!message || typeof message !== 'object' || !('type' in message)
      || message.type !== 'CONTEXT_ANALYZE' || !('text' in message) || typeof message.text !== 'string') return;
    void contextAnalyze(message.text);
    respond({ ok: true, data: null });
  });
}

if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') start();
