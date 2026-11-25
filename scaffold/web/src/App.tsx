import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Workspace = { id: string; role: string };
type Conversation = { workspace: string; contact: string; assignee: string | null; closed: boolean; lastActivityAt?: string };
type Message = { _id?: string; direction: string; text: string; status: string; createdAt: string; occurredAt?: string; author?: string };
type Note = { _id?: string; text: string; author: string; createdAt: string };

const shell: React.CSSProperties = { minHeight: '100vh', background: '#f4f6f8', color: '#182230', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' };
const button: React.CSSProperties = { border: '1px solid #d7dee7', background: '#fff', borderRadius: 8, padding: '9px 12px', cursor: 'pointer', color: '#263445', fontWeight: 600 };
const field: React.CSSProperties = { border: '1px solid #d7dee7', borderRadius: 8, padding: 11, font: 'inherit', width: '100%', boxSizing: 'border-box' };

async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  if (response.status === 401) { window.location.href = '/auth/login'; throw new Error('Please sign in'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const time = (value?: string) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export function App() {
  const [user, setUser] = useState<{sub:string;workspaces:Workspace[]}|null>(null);
  const [workspace, setWorkspace] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [tab, setTab] = useState<'messages'|'notes'>('messages');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => conversations.find(c => c.contact === selected), [conversations, selected]);

  const refreshList = useCallback(async () => {
    if (!workspace) return;
    const result = await api(`/api/conversations?workspace=${encodeURIComponent(workspace)}`);
    setConversations(result.data);
    setSelected(current => current || result.data[0]?.contact || '');
  }, [workspace]);
  const refreshThread = useCallback(async () => {
    if (!workspace || !selected) { setMessages([]); setNotes([]); return; }
    const [m,n] = await Promise.all([
      api(`/api/conversations/${encodeURIComponent(selected)}/messages?workspace=${encodeURIComponent(workspace)}`),
      api(`/api/conversations/${encodeURIComponent(selected)}/notes?workspace=${encodeURIComponent(workspace)}`)
    ]);
    setMessages(m.data); setNotes(n.data);
  }, [workspace, selected]);

  const selectedRef = useRef(selected);
  const refreshThreadRef = useRef(refreshThread);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { refreshThreadRef.current = refreshThread; }, [refreshThread]);

  useEffect(() => {
    api('/api/me').then(data => { setUser(data); setWorkspace(data.workspaces[0]?.id || ''); }).catch(e => setError(e.message));
  }, []);
  useEffect(() => { refreshList().catch(e => setError(e.message)); }, [refreshList]);
  useEffect(() => { refreshThread().catch(e => setError(e.message)); }, [refreshThread]);
  useEffect(() => {
    if (!workspace) return;
    let socket: WebSocket | undefined;
    let retry: number;
    let lastSeq = 0;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}&after=${lastSeq}`);
      socket.onmessage = event => {
        const item = JSON.parse(event.data);
        lastSeq = Math.max(lastSeq, item.seq || 0);
        refreshList().catch(() => {});
        if (item.contact === selectedRef.current) refreshThreadRef.current().catch(() => {});
      };
      socket.onclose = () => { retry = window.setTimeout(connect, 1200); };
    };
    connect();
    return () => { window.clearTimeout(retry); socket?.close(); };
  }, [workspace, refreshList]);

  async function claim() {
    if (!selected) return;
    setBusy(true); setError('');
    try { await api(`/api/conversations/${encodeURIComponent(selected)}/claim`, { method:'POST', body:JSON.stringify({workspace}) }); await refreshList(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function toggleClosed() {
    if (!selected) return;
    setBusy(true);
    try { await api(`/api/conversations/${encodeURIComponent(selected)}/${active?.closed ? 'reopen' : 'close'}`, { method:'POST', body:JSON.stringify({workspace}) }); await refreshList(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function sendReply(e: React.FormEvent) {
    e.preventDefault(); if (!draft.trim() || !selected) return;
    setBusy(true); setError('');
    try {
      const client_ref = `web_${crypto.randomUUID()}`;
      await api('/api/reply', { method:'POST', body:JSON.stringify({workspace,contact:selected,text:draft.trim(),client_ref}) });
      setDraft(''); await refreshThread();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function addNote(e: React.FormEvent) {
    e.preventDefault(); if (!noteDraft.trim() || !selected) return;
    setBusy(true);
    try { await api(`/api/conversations/${encodeURIComponent(selected)}/notes`, {method:'POST',body:JSON.stringify({workspace,text:noteDraft.trim()})}); setNoteDraft(''); await refreshThread(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!user) return <main style={{...shell,display:'grid',placeItems:'center'}}><section style={{background:'#fff',padding:32,borderRadius:16,width:320,boxShadow:'0 12px 40px #172b4d12'}}><h1>Switchboard</h1><p>Shared team inbox</p>{error && <p style={{color:'#b42318'}}>{error}</p>}<a href="/auth/login">Sign in</a></section></main>;

  return <main style={shell}>
    <header style={{height:64,background:'#fff',borderBottom:'1px solid #e3e8ef',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px'}}>
      <div style={{display:'flex',alignItems:'center',gap:12}}><div style={{background:'#2449a6',color:'#fff',borderRadius:9,padding:8,fontWeight:800}}>S</div><strong style={{fontSize:18}}>Switchboard</strong><span style={{color:'#8994a3',fontSize:13}}>Team inbox</span></div>
      <div style={{display:'flex',alignItems:'center',gap:14}}><select style={{...field,width:180}} value={workspace} onChange={e=>{setWorkspace(e.target.value);setSelected('');}}>{user.workspaces.map(w=><option key={w.id} value={w.id}>{w.id} · {w.role}</option>)}</select><span style={{fontSize:13,color:'#667085'}}>{user.sub}</span><a href="/auth/login" style={{color:'#3859a8',fontSize:13}}>Switch user</a></div>
    </header>
    {error && <div style={{padding:'10px 24px',background:'#fff0ed',color:'#b42318'}}>{error}<button onClick={()=>setError('')} style={{...button,marginLeft:12,padding:'3px 8px'}}>Dismiss</button></div>}
    <section style={{display:'grid',gridTemplateColumns:'320px minmax(0,1fr)',height:'calc(100vh - 65px)',maxWidth:1440,margin:'0 auto'}}>
      <aside style={{background:'#fff',borderRight:'1px solid #e3e8ef',overflowY:'auto'}}>
        <div style={{padding:'22px 20px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}><div><h2 style={{fontSize:18,margin:0}}>Inbox</h2><p style={{fontSize:12,color:'#8792a2',margin:'5px 0 0'}}>{conversations.length} conversations</p></div><span style={{fontSize:11,background:'#edf2ff',color:'#3555a2',padding:'5px 8px',borderRadius:20}}>LIVE</span></div>
        {conversations.map(c=><button key={c.contact} onClick={()=>setSelected(c.contact)} style={{width:'100%',textAlign:'left',border:0,borderTop:'1px solid #f0f2f5',background:selected===c.contact?'#f0f4ff':'#fff',padding:'16px 20px',cursor:'pointer'}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:8}}><strong>{c.contact}</strong><span style={{fontSize:11,color:'#8994a3'}}>{time(c.lastActivityAt)}</span></div>
          <div style={{display:'flex',justifyContent:'space-between',marginTop:8,fontSize:12,color:'#778292'}}><span>{c.assignee ? `Assigned · ${c.assignee}` : 'Unassigned'}</span><span>{c.closed?'Closed':'Open'}</span></div>
        </button>)}
        {!conversations.length && <p style={{padding:20,color:'#8792a2'}}>No conversations yet. Incoming messages will appear here.</p>}
      </aside>
      <section style={{display:'flex',flexDirection:'column',minWidth:0}}>
        {active ? <>
          <div style={{background:'#fff',borderBottom:'1px solid #e3e8ef',padding:'18px 24px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div><h2 style={{fontSize:18,margin:0}}>{active.contact}</h2><p style={{fontSize:12,color:'#7c8796',margin:'5px 0 0'}}>{active.assignee ? `Assigned to ${active.assignee}` : 'Unassigned'} · {active.closed?'Closed':'Open'}</p></div>
            <div style={{display:'flex',gap:8}}><button disabled={busy} onClick={claim} style={button}>Claim</button><button disabled={busy} onClick={toggleClosed} style={button}>{active.closed?'Reopen':'Close'}</button></div>
          </div>
          <div style={{padding:'12px 24px',background:'#fff',borderBottom:'1px solid #edf0f4',display:'flex',gap:8}}><button onClick={()=>setTab('messages')} style={{...button,background:tab==='messages'?'#edf2ff':'#fff',borderColor:tab==='messages'?'#cbd7fa':'#fff'}}>Messages</button><button onClick={()=>setTab('notes')} style={{...button,background:tab==='notes'?'#fff5dc':'#fff',borderColor:tab==='notes'?'#f3d58a':'#fff'}}>Private notes ({notes.length})</button></div>
          {tab==='messages' ? <>
            <div style={{flex:1,overflowY:'auto',padding:24,display:'flex',flexDirection:'column',gap:12}}>
              {messages.map((m,i)=><div key={m._id||i} style={{alignSelf:m.direction==='outbound'?'flex-end':'flex-start',maxWidth:'72%',background:m.direction==='outbound'?'#eaf0ff':'#fff',border:'1px solid #e5eaf1',borderRadius:13,padding:'11px 14px'}}>
                <div style={{whiteSpace:'pre-wrap',lineHeight:1.5}}>{m.text}</div><div style={{fontSize:10,color:'#7d8795',marginTop:7,textAlign:'right'}}>{time(m.occurredAt||m.createdAt)} {m.direction==='outbound'?`· ${m.status}`:''}</div>
              </div>)}
              {!messages.length && <p style={{color:'#8792a2',textAlign:'center'}}>No messages yet.</p>}
            </div>
            <form onSubmit={sendReply} style={{background:'#fff',borderTop:'1px solid #e3e8ef',padding:18,display:'flex',gap:10}}><input value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Write a reply…" style={field}/><button disabled={busy||!draft.trim()} style={{...button,background:'#2449a6',color:'#fff',borderColor:'#2449a6'}}>Send</button></form>
          </> : <>
            <div style={{flex:1,overflowY:'auto',padding:24,display:'flex',flexDirection:'column',gap:12}}>
              {notes.map((n,i)=><article key={n._id||i} style={{background:'#fff7e6',border:'1px solid #f4dfad',borderRadius:12,padding:14}}><p style={{margin:'0 0 8px',whiteSpace:'pre-wrap'}}>{n.text}</p><small style={{color:'#8b6b2b'}}>{n.author} · {time(n.createdAt)}</small></article>)}
              {!notes.length && <p style={{color:'#8792a2',textAlign:'center'}}>No private notes yet.</p>}
            </div>
            <form onSubmit={addNote} style={{background:'#fff',borderTop:'1px solid #e3e8ef',padding:18,display:'flex',gap:10}}><input value={noteDraft} onChange={e=>setNoteDraft(e.target.value)} placeholder="Add a private note for your team…" style={field}/><button disabled={busy||!noteDraft.trim()} style={{...button,background:'#8b6415',color:'#fff',borderColor:'#8b6415'}}>Add note</button></form>
          </>}
        </> : <div style={{flex:1,display:'grid',placeItems:'center',color:'#8994a3'}}><div style={{textAlign:'center'}}><div style={{fontSize:38,marginBottom:12}}>✉</div><strong>Select a conversation</strong><p style={{fontSize:13}}>Choose a customer from your inbox to view the thread.</p></div></div>}
      </section>
    </section>
  </main>;
}
