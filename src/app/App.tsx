import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, ChevronDown,
  ChevronRight, CircleCheck, Clock3, ExternalLink, Eye, EyeOff, FileJson, Flame,
  Layers3, List, LoaderCircle, PanelLeftClose, Plus, RotateCcw, Search,
  Settings2, Sparkles, Sprout, SquarePen, Star, Target, Trash2, Upload, X,
} from 'lucide-react';
import { isExtension, requestApiPermission, rpc, subscribe } from '../shared/bridge';
import type { AppState, Entry, ModelOption, Rating, Settings, Story } from '../shared/types';
import { dateLabel, dayKey, dueEntries, exportCsv, exportJson, makeCloze, safeUrl, sourceHost, speak, todayCount, TYPE_LABELS } from './utils';

type Page = 'review' | 'library' | 'story' | 'practice' | 'settings';
type Notify = (message: string, error?: boolean) => void;
const pages: Page[] = ['review', 'library', 'story', 'practice', 'settings'];
const getPage = (): Page => pages.includes(location.hash.slice(1) as Page) ? location.hash.slice(1) as Page : 'review';
const PAGE_NAMES = { review: '今日复习', library: '我的生词本', story: '每日故事', practice: '填空练习', settings: '偏好设置' };

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>(getPage);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(async () => {
    try { setState(await rpc({ type: 'GET_STATE' })); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [page]);
  useEffect(() => {
    void refresh();
    const stop = subscribe(() => { void refresh(); });
    const hash = () => { setPage(getPage()); setSidebar(false); };
    window.addEventListener('hashchange', hash);
    const timer = setInterval(() => { void refresh(); }, 60_000);
    return () => { stop(); window.removeEventListener('hashchange', hash); clearInterval(timer); };
  }, [refresh]);
  const notify: Notify = (message, isError = false) => {
    setToast({ message, error: isError });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  };
  const go = (next: Page) => { location.hash = next; setPage(next); setSidebar(false); };
  const examples = async () => {
    try { setState(await rpc({ type: 'LOAD_EXAMPLES' })); notify('示例词条已加入生词本'); }
    catch (cause) { notify(errorText(cause), true); }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('备份文件不能超过 8 MB。');
      setState(await rpc({ type: 'IMPORT', data: JSON.parse(await file.text()) }));
      notify('备份已合并，已有词条的学习进度已保留');
    } catch (cause) { notify(errorText(cause), true); }
  };
  if (!state) return <div className="boot"><img src="./brand.svg" alt="" /><h1>词境 WordNest</h1>{error ? <><p className="error-text">{error}</p><button onClick={refresh}>重新连接</button></> : <LoaderCircle className="spin" size={22} />}</div>;
  const due = dueEntries(state);
  const mastered = state.entries.filter(entry => entry.status === 'mastered').length;
  const selected = state.entries.find(entry => entry.id === detail);
  return <div className="app-shell">
    {sidebar && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
      <a href="#review" className="brand"><img src="./brand.svg" alt="" /><div><strong>词境<span>WordNest</span></strong><small>在语境中，慢慢记住。</small></div></a>
      <div className="workspace-label">我的学习空间</div>
      <nav aria-label="主导航">
        <Nav icon={<Layers3 size={19} />} label="今日复习" active={page === 'review'} onClick={() => go('review')} count={due.length || undefined} />
        <Nav icon={<BookOpen size={19} />} label="我的生词本" active={page === 'library'} onClick={() => go('library')} count={state.entries.length || undefined} />
        <Nav icon={<Sparkles size={19} />} label="每日故事" active={page === 'story'} onClick={() => go('story')} />
        <Nav icon={<SquarePen size={19} />} label="填空练习" active={page === 'practice'} onClick={() => go('practice')} />
      </nav>
      <div className="sidebar-progress"><div className="progress-label"><span><Sprout size={16} />日积月累</span><strong>{mastered}<small> / {state.entries.length}</small></strong></div><div className="mini-track"><i style={{ width: `${state.entries.length ? mastered / state.entries.length * 100 : 0}%` }} /></div><p>每一个记住的词，都是一点进步。</p></div>
      <div className="sidebar-bottom">
        <Nav icon={<Settings2 size={19} />} label="偏好设置" active={page === 'settings'} onClick={() => go('settings')} />
        <div className="local-status"><span /><span>数据保存在本机</span><span className="version">v1.0</span></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="展开导航" onClick={() => setSidebar(true)}><PanelLeftClose size={19} /></button><span>我的学习空间</span><ChevronRight size={14} /><strong>{PAGE_NAMES[page]}</strong></div><div className="topbar-right"><span className="today-date">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span><div className="avatar" title="本地学习空间">W</div></div></header>
      <main className={`main-content ${page === 'settings' ? 'settings-width' : ''}`} id="main">
        {error && <div className="inline-error">{error}<button onClick={refresh}>重试</button></div>}
        {!state.settings.apiKey && page !== 'settings' && <div className="setup-banner"><span><span className="status-dot" />翻译服务尚未连接</span><button onClick={() => go('settings')}>配置 API <ArrowRight size={14} /></button></div>}
        {page === 'review' && <ReviewPage state={state} setState={setState} notify={notify} go={go} examples={examples} onDetail={setDetail} />}
        {page === 'library' && <LibraryPage state={state} setState={setState} notify={notify} examples={examples} onDetail={setDetail} importFile={importFile} />}
        {page === 'story' && <StoryPage state={state} refresh={refresh} notify={notify} go={go} />}
        {page === 'practice' && <PracticePage state={state} setState={setState} notify={notify} go={go} />}
        {page === 'settings' && <SettingsPage state={state} setState={setState} notify={notify} importFile={importFile} />}
        <footer className="page-footer"><span>WordNest<span className="footer-dot">·</span>让每次阅读，都留下点什么。</span><span><span className="tiny-dot" />本地优先 · 你的词，你的节奏</span></footer>
      </main>
    </div>
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">{toast.error ? <X size={17} /> : <Check size={17} />}{toast.message}<button className="icon-button" aria-label="关闭通知" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {selected && <EntryDetail entry={selected} close={() => setDetail(null)} state={state} setState={setState} notify={notify} />}
  </div>;
}

function errorText(cause: unknown) { return cause instanceof Error ? cause.message : '操作失败，请稍后再试。'; }
function Nav({ icon, label, active, onClick, count }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; count?: number }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>{icon}<span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}</button>;
}
function SectionHeading({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{subtitle && <p className="section-subtitle">{subtitle}</p>}</div>{action}</div>;
}
function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark"><BookOpen size={34} strokeWidth={1.4} /></div><h2>{title}</h2><p>{text}</p><div className="empty-actions">{children}</div></div>;
}
function SourceLink({ entry }: { entry: Entry }) {
  const url = safeUrl(entry.source.url);
  return url ? <a href={url} className="source-link" target="_blank" rel="noreferrer" title={entry.source.title}><span className="source-favicon">{sourceHost(entry).slice(0, 1).toUpperCase()}</span>{sourceHost(entry)}<ExternalLink size={12} /></a> : <span className="muted">手动导入</span>;
}
function Pronounce({ text }: { text: string }) {
  return <button className="icon-button pronounce" title="朗读英文" aria-label={`朗读 ${text}`} onClick={event => { event.stopPropagation(); speak(text); }}><AudioLines size={19} /></button>;
}
function ReviewPage({ state, setState, notify, go, examples, onDetail }: {
  state: AppState; setState: (state: AppState) => void; notify: Notify; go: (page: Page) => void; examples: () => void; onDetail: (id: string) => void;
}) {
  const [started, setStarted] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [hint, setHint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const due = dueEntries(state);
  const current = due[0];
  const count = todayCount(state);
  const mastered = state.entries.filter(entry => entry.status === 'mastered').length;
  const rate = async (rating: Rating) => {
    if (!current || saving) return;
    setSaving(true);
    try {
      setState(await rpc({ type: 'REVIEW', id: current.id, rating }));
      setSessionCount(value => value + 1);
      setFlipped(false); setHint(false);
    } catch (cause) { notify(errorText(cause), true); }
    finally { setSaving(false); }
  };
  const start = () => { setStarted(true); setSessionCount(0); setSessionTotal(due.length); setFlipped(false); };
  const recent = [...state.entries].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  return <>
    <SectionHeading eyebrow="A LITTLE, EVERY DAY" title="今日复习" subtitle="把读过的英文，变成熟悉的表达。" action={<div className="daily-target"><Target size={17} /><span>今日目标</span><strong>{count}<span> / {state.settings.dailyGoal}</span></strong></div>} />
    <div className="stats-strip">
      <div><span className="stat-icon amber"><Layers3 size={20} /></span><div><span className="stat-label">待复习</span><strong>{due.length}<small>个词条</small></strong></div><span className="stat-note">今天的温故知新</span></div>
      <div><span className="stat-icon green"><CircleCheck size={20} /></span><div><span className="stat-label">今日已学</span><strong>{count}<small>个词条</small></strong></div><span className="stat-note">{count >= state.settings.dailyGoal ? '今日目标已达成' : `距离目标还差 ${Math.max(0, state.settings.dailyGoal - count)} 个`}</span></div>
      <div><span className="stat-icon blue"><Sprout size={21} /></span><div><span className="stat-label">已掌握</span><strong>{mastered}<small>个词条</small></strong></div><span className="stat-note">每一点进步都算数</span></div>
    </div>
    <div className="review-layout">
      <section className="review-section">
        <div className="block-heading"><h2><Layers3 size={18} />温故，知新</h2><span>{started && current ? `${sessionCount + 1} / ${sessionTotal}` : '间隔复习'}</span></div>
        <div className={`flashcard ${flipped ? 'is-flipped' : ''}`}>
          {!state.entries.length ? <EmptyState title="从一个新词开始" text="遇见的英文，都会在这里慢慢生根。"><button className="button primary" onClick={() => go('settings')}>连接翻译服务<ArrowRight size={16} /></button><button className="text-button" onClick={examples}>用示例词条体验</button></EmptyState> :
            !current ? <EmptyState title={sessionCount ? '今天，又记住了一点' : '暂时没有到期的词条'} text={sessionCount ? `完成了 ${sessionCount} 次复习。下次相遇，会更熟悉。` : '让记忆休息一下，新的阅读也在等你。'}><button className="button primary" onClick={() => go('library')}>看看我的生词本<ArrowRight size={16} /></button></EmptyState> :
              <><div className="flashcard-top"><span className="type-badge">{TYPE_LABELS[current.type]}</span><span><span className="small-dot" />{current.streak > 0 ? `连续记得 ${current.streak} 次` : '等待与你熟悉'}</span><button className={`icon-button ${current.favorite ? 'is-starred' : ''}`} title={current.favorite ? '取消星标' : '添加星标'} aria-label="切换星标" onClick={async () => { try { setState(await rpc({ type: 'UPDATE_ENTRY', id: current.id, patch: { favorite: !current.favorite } })); } catch (cause) { notify(errorText(cause), true); } }}><Star size={18} fill={current.favorite ? 'currentColor' : 'none'} /></button></div>
                <div className={`word-face ${current.type === 'sentence' ? 'sentence-face' : ''}`}><div className="word-row"><h2>{current.term}</h2><Pronounce text={current.term} /></div>{current.phonetic && <p className="phonetic">{current.phonetic}<span>{current.partOfSpeech}</span></p>}
                  {flipped ? <div className="answer-face"><h3>{current.meaning}</h3>{current.contextTranslation && <p>{current.contextTranslation}</p>}<div className="example"><span className="eyebrow">IN CONTEXT</span><p>{current.example.en}</p><small>{current.example.zh}</small></div>{current.technicalNote && <p className="technical-note"><span>技术语境</span>{current.technicalNote}</p>}</div> :
                    <><p className="recall-prompt">{started ? '这个表达，在原句里是什么意思？' : '重逢一个词，也重回一段语境。'}</p>{hint ? <blockquote className="context-hint">{current.context}</blockquote> : <button className="hint-button" onClick={() => setHint(true)}><Eye size={15} />看一眼原句</button>}</>}
                </div>
                <div className="flashcard-bottom"><SourceLink entry={current} /><span>收藏于 {dateLabel(current.createdAt)}</span></div>
              </>}
        </div>
        {current && <div className="review-controls">{!started ? <button className="button primary start-review" onClick={start}>开始今日复习<ArrowRight size={17} /><span>{due.length} 个</span></button> : !flipped ? <button className="button primary flip-button" onClick={() => setFlipped(true)}><RotateCcw size={17} />翻面，看看答案</button> : <div className="rating-buttons"><button disabled={saving} onClick={() => rate('forgot')}><RotateCcw size={17} /><strong>忘了</strong><small>10 分钟后</small></button><button disabled={saving} onClick={() => rate('hard')}><Clock3 size={17} /><strong>模糊</strong><small>明天再见</small></button><button disabled={saving} onClick={() => rate('remember')}><Check size={18} /><strong>记得</strong><small>{current.streak + 1 >= state.settings.masteryTarget ? '掌握归档' : `${[1, 3, 7, 14, 30, 60][Math.min(current.streak, 5)]} 天后`}</small></button></div>}</div>}
        <div className="review-caption"><span><span className="tiny-dot" />{state.settings.masteryTarget} 次连续记得，词条自动归档</span><button className="text-button" onClick={() => go('practice')}>换个方式，试试填空<ArrowRight size={13} /></button></div>
      </section>
      <aside className="review-aside">
        <WeekActivity state={state} />
        <div className="recent-section"><div className="block-heading"><h2>最近收藏</h2><button className="text-button" onClick={() => go('library')}>全部<ChevronRight size={14} /></button></div>{recent.length ? recent.map(entry => <button className="recent-entry" key={entry.id} onClick={() => onDetail(entry.id)}><span className={`entry-letter ${entry.type}`}>{entry.type === 'sentence' ? 'S' : entry.term.slice(0, 1).toUpperCase()}</span><span><strong>{entry.term}</strong><small>{entry.meaning}</small></span><ChevronRight size={15} /></button>) : <p className="aside-empty">还没有收藏，留一点空间给新词。</p>}</div>
        <button className="story-teaser" onClick={() => go('story')}><div className="story-teaser-top"><Sparkles size={19} /><span>WORDS INTO STORIES</span><ArrowRight size={17} /></div><h3>让单词，连成故事。</h3><p>今日词汇，下一段阅读。</p><span className="story-lines" aria-hidden="true"><i /><i /><i /></span></button>
      </aside>
    </div>
  </>;
}

function WeekActivity({ state }: { state: AppState }) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(); date.setDate(date.getDate() - (6 - index));
    const key = dayKey(date.getTime());
    return { label: ['日', '一', '二', '三', '四', '五', '六'][date.getDay()], key, count: new Set(state.reviews.filter(review => dayKey(review.at) === key).map(review => review.entryId)).size };
  });
  const total = days.reduce((sum, day) => sum + day.count, 0);
  let streak = 0;
  const active = new Set(state.reviews.map(review => dayKey(review.at)));
  const cursor = new Date();
  if (!active.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  for (let index = 0; index < 366 && active.has(dayKey(cursor.getTime())); index++) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return <section className="week-section"><div className="block-heading"><h2>学习节奏</h2><span>近 7 天</span></div><div className="week-summary"><strong>{total}<small>次温习</small></strong><span><Flame size={15} />连续 {streak} 天</span></div><div className="week-chart" aria-label="近七天复习记录">{days.map((day, index) => <div key={day.key} className={index === 6 ? 'today' : ''} title={`${day.key}：${day.count} 个词条`}><div className="bar-track"><i style={{ height: day.count ? `${Math.max(12, day.count / Math.max(...days.map(item => item.count), state.settings.dailyGoal) * 100)}%` : '4px' }} /></div><span>{index === 6 ? '今' : day.label}</span></div>)}</div><p className="week-note">{total ? '熟悉，来自一次次恰好的重逢。' : '小小的一步，也值得被记录。'}</p></section>;
}

function LibraryPage({ state, setState, notify, examples, onDetail, importFile }: {
  state: AppState; setState: (state: AppState) => void; notify: Notify; examples: () => void; onDetail: (id: string) => void; importFile: (file?: File) => void;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('recent');
  const [exportOpen, setExportOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mastered = state.entries.filter(entry => entry.status === 'mastered').length;
  const filtered = state.entries.filter(entry =>
    (tab === 'all' || tab === 'favorites' && entry.favorite || entry.status === tab) &&
    (type === 'all' || entry.type === type) &&
    `${entry.term} ${entry.meaning} ${entry.context}`.toLowerCase().includes(query.toLowerCase()),
  ).sort((a, b) => sort === 'alpha' ? a.term.localeCompare(b.term) : sort === 'due' ? a.nextReviewAt - b.nextReviewAt : b.createdAt - a.createdAt);
  return <>
    <SectionHeading eyebrow="YOUR PERSONAL DICTIONARY" title="我的生词本" subtitle={`在阅读中收集，在语境中记住。共 ${state.entries.length} 个词条。`} action={<div className="heading-actions"><button className="button secondary" onClick={() => input.current?.click()}><Upload size={16} />导入</button><div className="dropdown-wrap"><button className="button secondary" onClick={() => setExportOpen(!exportOpen)}><ArrowDownToLine size={16} />导出<ChevronDown size={14} /></button>{exportOpen && <div className="dropdown"><button onClick={() => { exportJson(state); setExportOpen(false); }}><FileJson size={16} />JSON 完整备份</button><button onClick={() => { exportCsv(filtered); setExportOpen(false); }}><ArrowDownToLine size={16} />CSV 当前列表</button></div>}</div></div>} />
    <input ref={input} type="file" accept=".json,application/json" className="visually-hidden" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
    <div className="library-tabs" role="tablist">{[['all', '全部词条', state.entries.length], ['learning', '学习中', state.entries.length - mastered], ['mastered', '已掌握', mastered], ['favorites', '星标', state.entries.filter(entry => entry.favorite).length]].map(([value, label, count]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(String(value))}>{label}<span>{count}</span></button>)}</div>
    <div className="library-toolbar"><div className="search-field"><Search size={17} /><input aria-label="搜索词条" placeholder="搜索单词、释义或原句…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button>}</div><select aria-label="词条类型" value={type} onChange={event => setType(event.target.value)}><option value="all">全部类型</option><option value="word">单词</option><option value="phrase">短语</option><option value="sentence">长句</option></select><select aria-label="排列顺序" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">最近收藏</option><option value="alpha">字母顺序</option><option value="due">复习时间</option></select></div>
    {!state.entries.length ? <EmptyState title="你的下一次阅读，从这里留下痕迹" text="收藏的单词、短语和长句，会保留它们原来的语境。"><button className="button primary" onClick={examples}><Plus size={16} />加入示例词条</button><button className="button secondary" onClick={() => input.current?.click()}>导入已有备份</button></EmptyState> : !filtered.length ? <EmptyState title="没有找到匹配的词条" text="换个关键词，或试试其他筛选条件。"><button className="text-button" onClick={() => { setQuery(''); setTab('all'); setType('all'); }}>重置筛选</button></EmptyState> :
      <div className="library-table"><div className="table-head"><span>词条 / 释义</span><span>阅读语境</span><span>学习进度</span><span /></div>{filtered.map(entry => <div className="table-row" key={entry.id}><button className="term-cell" onClick={() => onDetail(entry.id)}><span className="term-cell-top"><strong>{entry.term}</strong><span className={`type-badge ${entry.type}`}>{TYPE_LABELS[entry.type]}</span></span><span>{entry.meaning}</span></button><button className="context-cell" onClick={() => onDetail(entry.id)}><p>{entry.context || entry.example.en}</p><small>{sourceHost(entry)}<span>·</span>{dateLabel(entry.createdAt)}</small></button><div className="status-cell">{entry.status === 'mastered' ? <span className="mastered-badge"><CircleCheck size={14} />已掌握</span> : <><div className="streak-dots">{Array.from({ length: state.settings.masteryTarget }, (_, index) => <i key={index} className={index < entry.streak ? 'filled' : ''} />)}</div><span>{entry.nextReviewAt <= Date.now() ? '待复习' : `${dateLabel(entry.nextReviewAt)}复习`}</span></>}</div><button className={`icon-button ${entry.favorite ? 'is-starred' : ''}`} aria-label={`${entry.favorite ? '取消' : '添加'} ${entry.term} 星标`} title="星标词条" onClick={async () => { try { setState(await rpc({ type: 'UPDATE_ENTRY', id: entry.id, patch: { favorite: !entry.favorite } })); } catch (cause) { notify(errorText(cause), true); } }}><Star size={17} fill={entry.favorite ? 'currentColor' : 'none'} /></button></div>)}</div>}
    {filtered.length > 0 && <div className="table-footer"><span>共 {filtered.length} 个词条</span><span>每个词，都有它自己的来处。</span></div>}
  </>;
}

function EntryDetail({ entry, close, state, setState, notify }: { entry: Entry; close: () => void; state: AppState; setState: (state: AppState) => void; notify: Notify }) {
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const dialog = document.querySelector<HTMLElement>('.detail-dialog');
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, [tabindex="0"]') || []);
    focusable()[0]?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', keyboard); previous?.focus({ preventScroll: true }); };
  }, [entry.id]);
  async function update(status: 'mastered' | 'learning') {
    try { setState(await rpc({ type: 'UPDATE_ENTRY', id: entry.id, patch: { status } })); notify(status === 'mastered' ? '已归档到掌握词条' : '已加入待复习词条'); }
    catch (cause) { notify(errorText(cause), true); }
  }
  return <div className="modal-backdrop" onClick={close}><section className="detail-dialog" role="dialog" aria-modal="true" aria-label="词条详情" onClick={event => event.stopPropagation()}><header><span className="eyebrow">A WORD, IN CONTEXT</span><button className="icon-button" aria-label="关闭详情" onClick={close} autoFocus><X size={20} /></button></header><div className="detail-word"><span className={`type-badge ${entry.type}`}>{TYPE_LABELS[entry.type]}</span><div className="word-row"><h2>{entry.term}</h2><Pronounce text={entry.term} /></div><p className="phonetic">{entry.phonetic} <span>{entry.partOfSpeech}</span></p><h3>{entry.meaning}</h3></div><div className="detail-block"><h4>原来的语境</h4><blockquote>{entry.context}</blockquote><p>{entry.contextTranslation}</p><SourceLink entry={entry} /></div>{entry.technicalNote && <div className="detail-block"><h4><span className="tiny-dot" />技术语境</h4><p>{entry.technicalNote}</p></div>}{entry.sentenceAnalysis && <div className="detail-block"><h4>句子主干</h4><blockquote>{entry.sentenceAnalysis.skeleton}</blockquote><div className="chunk-list">{entry.sentenceAnalysis.chunks.map((chunk, index) => <div key={index}><span>{chunk.role}</span><strong>{chunk.text}</strong><p>{chunk.meaning}</p></div>)}</div></div>}<div className="detail-block"><h4>再看一个例句</h4><blockquote>{entry.example.en}</blockquote><p>{entry.example.zh}</p></div><div className="detail-meta"><span>复习 {entry.reviewCount} 次</span><span>连续记得 {entry.streak} / {state.settings.masteryTarget} 次</span><span>收藏于 {dateLabel(entry.createdAt)}</span></div><footer>{deleting ? <div className="delete-confirm"><span>确定删除这个词条？</span><button className="button danger" onClick={async () => { try { setState(await rpc({ type: 'DELETE_ENTRY', id: entry.id })); close(); notify('词条已删除'); } catch (cause) { notify(errorText(cause), true); } }}>确定删除</button><button className="text-button" onClick={() => setDeleting(false)}>取消</button></div> : <><button className="icon-button delete-button" title="删除词条" aria-label="删除词条" onClick={() => setDeleting(true)}><Trash2 size={18} /></button><button className="button secondary" onClick={() => update(entry.status === 'mastered' ? 'learning' : 'mastered')}>{entry.status === 'mastered' ? <RotateCcw size={16} /> : <CircleCheck size={16} />}{entry.status === 'mastered' ? '重新学习' : '标记已掌握'}</button></>}</footer></section></div>;
}

function StoryPage({ state, refresh, notify, go }: { state: AppState; refresh: () => Promise<void>; notify: Notify; go: (page: Page) => void }) {
  const [busy, setBusy] = useState(false);
  const [showChinese, setShowChinese] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const due = dueEntries(state);
  const words = due.filter(entry => entry.type !== 'sentence').slice(0, 8);
  const sorted = [...state.stories].sort((a, b) => b.date.localeCompare(a.date));
  const story = sorted.find(item => item.id === selectedId) || sorted[0];
  async function generate() {
    setBusy(true);
    try {
      const result = await rpc<Story>({ type: 'GENERATE_STORY', entryIds: words.map(entry => entry.id) });
      setSelectedId(result.id); setShowChinese(false); await refresh(); notify('今日故事已就绪');
    } catch (cause) { notify(errorText(cause), true); }
    finally { setBusy(false); }
  }
  return <><SectionHeading eyebrow="A NEW CONTEXT FOR FAMILIAR WORDS" title="每日故事" subtitle="熟悉的词，放进一段新的语境。" action={<button className="button primary" disabled={busy || !words.length || !state.settings.apiKey} onClick={generate}>{busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{busy ? '正在写故事…' : story?.date === dayKey() ? '更新今日故事' : '生成今日故事'}</button>} />
    <div className="story-layout"><section className="story-reading">{story ? <><div className="story-reading-head"><span className="story-day">DAILY READING <span>/</span> {story.date}</span><button className="text-button" onClick={() => setShowChinese(!showChinese)}>{showChinese ? <EyeOff size={15} /> : <Eye size={15} />}{showChinese ? '收起译文' : '显示译文'}</button></div><h2>{story.title}</h2><div className="story-copy">{story.english.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}><HighlightedText text={paragraph} words={story.entryIds.map(id => state.entries.find(entry => entry.id === id)?.term).filter((word): word is string => Boolean(word))} /></p>)}</div>{showChinese && <div className="story-translation"><h3>中文译文</h3>{story.chinese.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>}<div className="story-reading-footer"><span><BookOpen size={15} />{story.entryIds.length} 个词条 · 约 {Math.max(1, Math.ceil(story.english.split(/\s+/).length / 160))} 分钟阅读</span><Pronounce text={story.english} /></div></> : <EmptyState title="今天的词，今天的故事" text={words.length ? `用 ${words.length} 个学习中的表达，开始一次新的阅读。` : '先收藏几个单词，让故事有一个开始。'}>{!state.settings.apiKey ? <button className="button primary" onClick={() => go('settings')}>连接翻译服务<ArrowRight size={16} /></button> : !words.length ? <button className="button primary" onClick={() => go('library')}>前往生词本<ArrowRight size={16} /></button> : <button className="button primary" disabled={busy} onClick={generate}><Sparkles size={16} />{busy ? '正在写故事…' : '写下今天的故事'}</button>}</EmptyState>}</section><aside className="story-aside"><div className="block-heading"><h2>{story ? '故事里的词' : '今日候选词汇'}</h2><span>{story ? story.entryIds.length : words.length} 个</span></div><div className="story-words">{(story ? story.entryIds.map(id => state.entries.find(entry => entry.id === id)).filter((entry): entry is Entry => Boolean(entry)) : words).map(entry => <div key={entry.id}><strong>{entry.term}</strong><span>{entry.meaning}</span></div>)}</div>{sorted.length > 0 && <div className="story-archive"><h3>往日阅读</h3>{sorted.map(item => <button key={item.id} onClick={() => { setSelectedId(item.id); setShowChinese(false); }} className={item.id === story?.id ? 'selected' : ''}><span>{item.date}</span><strong>{item.title}</strong><ChevronRight size={14} /></button>)}</div>}</aside></div>
  </>;
}
function HighlightedText({ text, words }: { text: string; words: string[] }) {
  const escaped = words.filter(Boolean).sort((a, b) => b.length - a.length).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return <>{text}</>;
  const expression = new RegExp(`(?<![a-zA-Z])(${escaped.join('|')})(?![a-zA-Z])`, 'gi');
  const parts: ReactNode[] = []; let cursor = 0;
  for (const match of text.matchAll(expression)) {
    parts.push(text.slice(cursor, match.index)); parts.push(<mark key={match.index}>{match[0]}</mark>); cursor = match.index! + match[0].length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function PracticePage({ state, setState, notify, go }: { state: AppState; setState: (state: AppState) => void; notify: Notify; go: (page: Page) => void }) {
  const [queue] = useState(() => dueEntries(state).filter(entry => makeCloze(entry)).map(entry => entry.id).slice(0, 10));
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<'correct' | 'incorrect' | null>(null);
  const [correct, setCorrect] = useState(0);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'input' | 'choice'>('input');
  const entry = state.entries.find(item => item.id === queue[index]);
  const cloze = entry && makeCloze(entry);
  const choices = entry ? [entry.term, ...state.entries.filter(item => item.type !== 'sentence' && item.term.toLowerCase() !== entry.term.toLowerCase()).map(item => item.term).filter((term, idx, all) => all.findIndex(candidate => candidate.toLowerCase() === term.toLowerCase()) === idx).slice(0, 3)].sort((a, b) => a.localeCompare(b)) : [];
  async function check(value = answer) {
    if (!entry || !cloze || result || saving || !value.trim()) return;
    const matches = value.trim().toLowerCase().replace(/[.!?]+$/, '') === cloze.answer.toLowerCase();
    setSaving(true);
    try {
      setState(await rpc({ type: 'REVIEW', id: entry.id, rating: matches ? 'remember' : 'forgot' }));
      setResult(matches ? 'correct' : 'incorrect');
      if (matches) setCorrect(count => count + 1);
    } catch (cause) { notify(errorText(cause), true); }
    finally { setSaving(false); }
  }
  return <><SectionHeading eyebrow="PUT YOUR WORDS TO WORK" title="填空练习" subtitle="回到句子里，试着找回那个词。" action={<div className="segmented"><button className={mode === 'input' ? 'active' : ''} onClick={() => { setMode('input'); setAnswer(''); }}>拼写</button><button className={mode === 'choice' ? 'active' : ''} onClick={() => { setMode('choice'); setAnswer(''); }}>选择</button></div>} />
    {!queue.length ? <EmptyState title="还没有可以练习的例句" text="收藏带有双语例句的单词或短语，再来试试。"><button className="button primary" onClick={() => go('library')}>前往生词本<ArrowRight size={16} /></button></EmptyState> : !entry || !cloze ? <div className="practice-complete"><CircleCheck size={45} /><p className="eyebrow">NICELY DONE</p><h2>这一次，又熟悉了一点。</h2><p>{queue.length} 道题，答对 {correct} 道。</p><button className="button primary" onClick={() => go('review')}>回到今日复习<ArrowRight size={16} /></button></div> : <section className="practice-tool"><div className="practice-progress"><span>IN CONTEXT</span><span>{index + 1} / {queue.length}</span></div><div className="mini-track"><i style={{ width: `${index / queue.length * 100}%` }} /></div><p className="practice-sentence">{cloze.before}<span className={result === 'correct' ? 'cloze-correct' : result === 'incorrect' ? 'cloze-incorrect' : ''}>{result ? cloze.answer : '________'}</span>{cloze.after}</p><p className="practice-translation">{entry.example.zh}</p><span className="type-badge">{entry.partOfSpeech || TYPE_LABELS[entry.type]}</span>{mode === 'input' ? <form className="practice-answer" onSubmit={event => { event.preventDefault(); void check(); }}><input aria-label="填入缺失的英文" autoComplete="off" spellCheck={false} placeholder="填入缺失的英文…" disabled={Boolean(result)} value={answer} onChange={event => setAnswer(event.target.value)} autoFocus /><button className="button primary" disabled={!answer.trim() || Boolean(result) || saving} type="submit">{saving ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}检查</button></form> : <div className="choice-options">{choices.map((choice, idx) => <button disabled={Boolean(result) || saving} key={choice} className={result && choice.toLowerCase() === entry.term.toLowerCase() ? 'correct' : ''} onClick={() => { setAnswer(choice); void check(choice); }}><span>{String.fromCharCode(65 + idx)}</span>{choice}</button>)}</div>}{result && <div className={`practice-result ${result}`}><div><strong>{result === 'correct' ? '记住了，就是这样。' : `正确答案是 ${cloze.answer}`}</strong><p>{entry.meaning}</p></div><button className="button secondary" onClick={() => { setIndex(value => value + 1); setAnswer(''); setResult(null); }}>{index + 1 >= queue.length ? '查看结果' : '下一题'}<ArrowRight size={16} /></button></div>}<div className="practice-source"><SourceLink entry={entry} /><span>{correct} 题正确</span></div></section>}
  </>;
}

function SettingsPage({ state, setState, notify, importFile }: { state: AppState; setState: (state: AppState) => void; notify: Notify; importFile: (file?: File) => void }) {
  const [form, setForm] = useState<Settings>({ ...state.settings });
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [manualModel, setManualModel] = useState(true);
  const modelRequest = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const connectionIdentity = JSON.stringify([form.apiStyle, form.apiBaseUrl, form.apiKey]);
  useEffect(() => {
    modelRequest.current++;
    setModels([]); setManualModel(true); setFetchingModels(false);
  }, [connectionIdentity]);
  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm(previous => ({ ...previous, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      await requestApiPermission(form);
      setState(await rpc({ type: 'SAVE_SETTINGS', settings: form }));
      notify('设置已保存');
    } catch (cause) { notify(errorText(cause), true); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setTesting(true);
    try {
      await requestApiPermission(form);
      const result = await rpc<{ message: string }>({ type: 'TEST_CONNECTION', settings: form });
      notify(result.message || '连接成功，可以开始翻译');
    } catch (cause) { notify(errorText(cause), true); }
    finally { setTesting(false); }
  };
  const fetchModels = async () => {
    const token = ++modelRequest.current;
    setFetchingModels(true);
    try {
      await requestApiPermission(form);
      const result = await rpc<ModelOption[]>({ type: 'GET_MODELS', settings: { ...form } });
      if (token !== modelRequest.current) return;
      if (!result.length) throw new Error('接口没有返回可用模型，可以手动填写模型名称。');
      setModels(result); setManualModel(false);
      setForm(previous => ({ ...previous, model: result.some(item => item.id === previous.model) ? previous.model : result[0].id }));
      notify(`已获取 ${result.length} 个模型`);
    } catch (cause) { if (token === modelRequest.current) notify(errorText(cause), true); }
    finally { if (token === modelRequest.current) setFetchingModels(false); }
  };
  const provider = form.apiStyle === 'anthropic' && /^https:\/\/api\.anthropic\.com(?:\/v1)?\/?$/.test(form.apiBaseUrl) ? 'anthropic'
    : form.apiStyle === 'openai' && form.apiBaseUrl === 'https://api.deepseek.com' ? 'deepseek' : 'custom';
  return <><SectionHeading eyebrow="MAKE YOURSELF AT HOME" title="偏好设置" subtitle="按照自己的节奏，把英文读下去。" />
    <form onSubmit={save}>
      <section className="settings-section"><div className="settings-section-title"><span className="settings-icon"><Sparkles size={20} /></span><div><h2>翻译服务</h2><p>API Key 仅保存在本机，不随生词备份导出。</p></div><span className={`connection-badge ${state.settings.apiKey ? 'connected' : ''}`}><span />{state.settings.apiKey ? '已配置' : '待连接'}</span></div><div className="settings-fields">
        <label>服务商<select aria-label="服务商" value={provider} onChange={event => {
          if (event.target.value === 'deepseek') setForm(previous => ({ ...previous, apiStyle: 'openai', apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' }));
          else if (event.target.value === 'anthropic') setForm(previous => ({ ...previous, apiStyle: 'anthropic', apiBaseUrl: 'https://api.anthropic.com/v1', model: '', apiKey: '' }));
          else setForm(previous => ({ ...previous, apiBaseUrl: '', model: '', apiKey: '' }));
        }}><option value="deepseek">DeepSeek</option><option value="anthropic">Claude / Anthropic</option><option value="custom">自定义兼容接口</option></select></label>
        <label>接口格式<select aria-label="接口格式" value={form.apiStyle} onChange={event => patch('apiStyle', event.target.value as Settings['apiStyle'])}><option value="openai">OpenAI 兼容 · Chat Completions</option><option value="anthropic">Claude 风格 · Messages</option></select></label>
        <label className="full">API 地址<input required type="url" placeholder="https://api.example.com/v1" value={form.apiBaseUrl} onChange={event => patch('apiBaseUrl', event.target.value)} /></label>
        <label className="full">API Key<div className="secret-input"><input type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder="输入你的 API Key" value={form.apiKey} onChange={event => patch('apiKey', event.target.value)} /><button className="icon-button" type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
        <div className="full model-field"><label htmlFor="model-name">模型名称</label><div className="model-controls">{models.length && !manualModel ? <select id="model-name" required value={form.model} onChange={event => patch('model', event.target.value)}>{!models.some(item => item.id === form.model) && form.model && <option value={form.model}>{form.model}</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}</select> : <input id="model-name" required autoComplete="off" placeholder="获取模型列表，或输入模型 ID" value={form.model} onChange={event => patch('model', event.target.value)} />}<button className="button secondary" type="button" disabled={fetchingModels || !form.apiKey.trim() || !form.apiBaseUrl.trim()} onClick={fetchModels}>{fetchingModels ? <LoaderCircle size={16} className="spin" /> : <List size={16} />}{fetchingModels ? '获取中…' : '获取模型'}</button></div>{models.length > 0 && <div className="model-field-meta"><span>{models.length} 个可用模型</span><button className="text-button" type="button" onClick={() => setManualModel(!manualModel)}>{manualModel ? '从列表选择' : '手动填写模型 ID'}</button></div>}</div>
        <div className="full api-actions"><p><span className="tiny-dot" />仅将选中内容及附近原句发送至此服务。</p><button className="button secondary" type="button" disabled={testing || !form.apiKey || !form.apiBaseUrl || !form.model} onClick={test}>{testing ? <LoaderCircle size={16} className="spin" /> : <AudioLines size={16} />}{testing ? '测试中…' : '测试连接'}</button></div>
      </div></section>
      <section className="settings-section"><div className="settings-section-title"><span className="settings-icon"><BookOpen size={20} /></span><div><h2>阅读与收藏</h2><p>让每次停留，都刚刚好。</p></div></div><ToggleRow title="开启网页划词" description="选中英文后提供词境解释入口" checked={form.enabled} onChange={value => patch('enabled', value)} /><ToggleRow title="自动加入生词本" description="解释成功后，连同原句和来源一起收藏" checked={form.autoSave} onChange={value => patch('autoSave', value)} /><ToggleRow title="优先解释技术含义" description="关注编程与技术文档中的特定用法" checked={form.technicalPriority} onChange={value => patch('technicalPriority', value)} /><div className="setting-row"><div><strong>划词触发方式</strong><p>选中英文后何时显示解释</p></div><div className="segmented"><button type="button" className={form.selectionMode === 'button' ? 'active' : ''} onClick={() => patch('selectionMode', 'button')}>点击解释</button><button type="button" className={form.selectionMode === 'auto' ? 'active' : ''} onClick={() => patch('selectionMode', 'auto')}>自动解释</button></div></div></section>
      <section className="settings-section"><div className="settings-section-title"><span className="settings-icon"><Target size={20} /></span><div><h2>复习节奏</h2><p>少一点压力，多一点积累。</p></div></div><div className="setting-row"><div><strong>每日学习目标</strong><p>每天想复习多少个词条</p></div><div className="number-with-unit"><input aria-label="每日学习目标" type="number" min="1" max="100" value={form.dailyGoal} onChange={event => patch('dailyGoal', Number(event.target.value))} /><span>个 / 天</span></div></div><div className="setting-row"><div><strong>自动掌握归档</strong><p>连续选择「记得」后自动归档</p></div><select aria-label="连续答对归档次数" value={form.masteryTarget} onChange={event => patch('masteryTarget', Number(event.target.value))}>{[3, 4, 5, 6].map(value => <option key={value} value={value}>连续 {value} 次</option>)}</select></div></section>
      <div className="save-settings"><span>{isExtension ? '新标签页已设为词境复习页' : '浏览器预览 · 数据仅保存在此预览中'}</span><button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{busy ? '保存中…' : '保存设置'}</button></div>
    </form>
    <section className="settings-section backup-section"><div className="settings-section-title"><span className="settings-icon"><ArrowDownToLine size={20} /></span><div><h2>数据与备份</h2><p>{state.entries.length} 个词条 · {state.reviews.length} 次复习记录</p></div></div><div className="backup-actions"><button className="button secondary" onClick={() => exportJson(state)}><FileJson size={16} />导出 JSON</button><button className="button secondary" onClick={() => exportCsv(state.entries)}><ArrowDownToLine size={16} />导出 CSV</button><button className="button secondary" onClick={() => input.current?.click()}><Upload size={16} />导入备份</button><input className="visually-hidden" ref={input} type="file" accept=".json,application/json" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></div><p className="backup-note">JSON 保留词条和学习进度，导入时合并已有数据。CSV 适合在表格中查看。</p></section>
  </>;
}
function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><button type="button" role="switch" aria-label={title} aria-checked={checked} className={`toggle ${checked ? 'checked' : ''}`} onClick={() => onChange(!checked)}><span /></button></div>;
}
