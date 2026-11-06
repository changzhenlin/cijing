import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, BookOpen, Layers3, LoaderCircle, Settings2, Sparkles } from 'lucide-react';
import { rpc } from '../shared/bridge';
import type { AppState } from '../shared/types';
import { dueEntries, todayCount } from '../app/utils';
import './style.css';

function Popup() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { rpc({ type: 'GET_STATE' }).then(setState).catch(cause => setError(cause.message)); }, []);
  const open = (page: string) => { void rpc({ type: 'OPEN_APP', page }).catch(cause => setError(cause.message)); };
  const toggle = async () => {
    if (!state || busy) return;
    setBusy(true);
    try { setState(await rpc({ type: 'SAVE_SETTINGS', settings: { ...state.settings, enabled: !state.settings.enabled } })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <div className="popup">
    <header><img src="./brand.svg" alt="" /><div><h1>词境 <span>WordNest</span></h1><p>在语境中，慢慢记住。</p></div><button title="偏好设置" aria-label="偏好设置" onClick={() => open('settings')}><Settings2 size={18} /></button></header>
    {error && <p className="error">{error}</p>}
    {!state ? <div className="loading"><LoaderCircle size={20} /></div> : <>
      <section className="popup-stats"><div><span>待复习</span><strong>{dueEntries(state).length}</strong></div><div><span>今日已学</span><strong>{todayCount(state)}</strong></div><div><span>已收藏</span><strong>{state.entries.length}</strong></div></section>
      <button className="review" onClick={() => open('review')}><Layers3 size={17} />开始今日复习<ArrowRight size={16} /></button>
      <div className="links"><button onClick={() => open('library')}><BookOpen size={16} />我的生词本<ArrowRight size={13} /></button><button onClick={() => open('story')}><Sparkles size={16} />每日故事<ArrowRight size={13} /></button></div>
      <div className="toggle-row"><span><i className={state.settings.enabled ? 'on' : ''} />网页划词{state.settings.enabled ? '已开启' : '已暂停'}</span><button className={`toggle ${state.settings.enabled ? 'checked' : ''}`} role="switch" aria-label="网页划词" aria-checked={state.settings.enabled} disabled={busy} onClick={toggle}><span /></button></div>
      {!state.settings.apiKey && <button className="connect" onClick={() => open('settings')}>连接翻译服务<ArrowRight size={13} /></button>}
    </>}
    <footer><i />数据保存在本机<span>v1.0</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Popup />);
