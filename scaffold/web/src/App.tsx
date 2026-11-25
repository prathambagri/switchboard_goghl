import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Workspace = { id: string; role: string };
type Conversation = {
  workspace: string;
  contact: string;
  assignee: string | null;
  closed: boolean;
  lastActivityAt?: string;
};
type Message = {
  _id?: string;
  direction: string;
  text: string;
  status: string;
  createdAt: string;
  occurredAt?: string;
  author?: string;
};
type Note = { _id?: string; text: string; author: string; createdAt: string };

async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });

  if (response.status === 401) {
    window.location.href = "/auth/login";
    throw new Error("Please sign in");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

const time = (value?: string) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const shortName = (value?: string | null) => {
  if (!value) return "?";
  const clean = value.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
};

const phoneLabel = (value: string) =>
  value.replace(/^(\+?\d{1,3})(\d{3})(\d{3})(\d{4})$/, "$1 $2 $3 $4");

const frontendStyles = `
  .sb-app {
    min-height: 100vh;
    color: #17212b;
    background: #f5f7f8;
    font-family: 'DM Sans', Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .sb-app *, .sb-app *::before, .sb-app *::after { box-sizing: border-box; }
  .sb-app button, .sb-app input, .sb-app select, .sb-app textarea { font: inherit; }
  .sb-app button { -webkit-tap-highlight-color: transparent; }

  .sb-loading {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background:
      radial-gradient(circle at 15% 10%, rgba(20,125,105,.10), transparent 30%),
      radial-gradient(circle at 90% 90%, rgba(20,125,105,.08), transparent 32%),
      #f5f7f8;
  }

  .sb-auth-card {
    width: min(380px, 100%);
    padding: 34px;
    border: 1px solid #e5ebe8;
    border-radius: 24px;
    background: rgba(255,255,255,.96);
    box-shadow: 0 24px 70px rgba(27,47,42,.12);
  }

  .sb-brand-mark {
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border-radius: 13px;
    background: linear-gradient(145deg, #168a73, #106c5a);
    color: #fff;
    font-family: Manrope, sans-serif;
    font-size: 20px;
    font-weight: 800;
    box-shadow: 0 8px 20px rgba(20,125,105,.22);
  }

  .sb-auth-card h1 { margin: 18px 0 7px; font: 800 26px/1.1 Manrope, sans-serif; letter-spacing: -.04em; }
  .sb-auth-card p { margin: 0 0 22px; color: #75818b; font-size: 14px; }
  .sb-auth-card a { color: #147d69; font-weight: 700; text-decoration: none; }

  .sb-topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 0 clamp(16px, 3vw, 40px);
    background: rgba(255,255,255,.94);
    border-bottom: 1px solid #e8eceb;
    backdrop-filter: blur(16px);
  }

  .sb-brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .sb-brand-copy { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .sb-brand-copy strong { font: 800 18px/1 Manrope, sans-serif; letter-spacing: -.035em; white-space: nowrap; }
  .sb-brand-copy span { color: #8a9693; font-size: 12px; white-space: nowrap; }

  .sb-top-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
  .sb-workspace-select {
    min-width: 175px;
    height: 42px;
    padding: 0 34px 0 12px;
    border: 1px solid #e1e8e5;
    border-radius: 11px;
    outline: none;
    color: #273b35;
    background: #fff;
    font-weight: 600;
  }
  .sb-user-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 180px;
    padding: 7px 10px;
    border: 1px solid #edf1ef;
    border-radius: 999px;
    background: #fafcfb;
    color: #65736e;
    font-size: 12px;
  }
  .sb-user-avatar, .sb-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    border-radius: 50%;
    background: #e8f4f0;
    color: #147d69;
    font-weight: 800;
  }
  .sb-user-avatar { width: 27px; height: 27px; font-size: 10px; }
  .sb-user-pill span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-switch { color: #147d69; font-size: 12px; font-weight: 700; text-decoration: none; white-space: nowrap; }

  .sb-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 24px;
    border-bottom: 1px solid #f2c8c0;
    background: #fff2ef;
    color: #a93627;
    font-size: 13px;
  }
  .sb-error button { border: 0; background: transparent; color: inherit; font-weight: 700; cursor: pointer; }

  .sb-layout {
    width: 100%;
    max-width: 1600px;
    height: calc(100vh - 72px);
    min-height: 520px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(300px, 350px) minmax(0, 1fr);
    overflow: hidden;
    background: #fff;
    border-left: 1px solid #e8eceb;
    border-right: 1px solid #e8eceb;
    box-shadow: 0 12px 40px rgba(29,49,45,.035);
  }

  .sb-sidebar { min-width: 0; overflow-y: auto; background: #fff; border-right: 1px solid #e8eceb; }
  .sb-sidebar-head {
    position: sticky;
    top: 0;
    z-index: 4;
    padding: 22px 20px 14px;
    background: rgba(255,255,255,.96);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid #f0f2f1;
  }
  .sb-sidebar-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .sb-sidebar-title-row h2 { margin: 0; font: 800 19px/1.1 Manrope, sans-serif; letter-spacing: -.04em; }
  .sb-sidebar-title-row p { margin: 6px 0 0; color: #899690; font-size: 12px; }
  .sb-live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 9px;
    border: 1px solid #cce9df;
    border-radius: 999px;
    background: #effaf6;
    color: #147d69;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .06em;
  }
  .sb-live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #18a77f; box-shadow: 0 0 0 3px rgba(24,167,127,.12); }
  .sb-search {
    width: 100%;
    height: 40px;
    margin-top: 15px;
    padding: 0 12px;
    border: 1px solid #e5ebe8;
    border-radius: 11px;
    outline: none;
    background: #f8faf9;
    color: #17212b;
  }
  .sb-search:focus { border-color: #75b9a6; box-shadow: 0 0 0 3px rgba(20,125,105,.09); background: #fff; }

  .sb-conversation {
    position: relative;
    width: 100%;
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr);
    gap: 11px;
    padding: 15px 18px;
    border: 0;
    border-bottom: 1px solid #f0f2f1;
    background: #fff;
    text-align: left;
    cursor: pointer;
    transition: background .16s ease, box-shadow .16s ease;
  }
  .sb-conversation:hover { background: #f7faf9; }
  .sb-conversation.active { background: #eaf5f1; box-shadow: inset 3px 0 #147d69; }
  .sb-avatar { width: 38px; height: 38px; font-size: 11px; }
  .sb-conversation-main { min-width: 0; }
  .sb-conversation-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .sb-contact { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #20302c; font-size: 13px; font-weight: 800; }
  .sb-time { flex: 0 0 auto; color: #97a19d; font-size: 10px; }
  .sb-preview { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #78847f; font-size: 11px; }
  .sb-conversation-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
  .sb-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #82908a; font-size: 10px; }
  .sb-status { padding: 4px 7px; border-radius: 999px; background: #f0f4f2; color: #71807a; font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
  .sb-status.open { background: #e8f4f0; color: #147d69; }
  .sb-empty { padding: 28px 20px; color: #899690; font-size: 13px; line-height: 1.5; }

  .sb-thread { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #f7f9f8; }
  .sb-thread-head {
    min-height: 82px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px clamp(16px, 2.4vw, 32px);
    background: #fff;
    border-bottom: 1px solid #e8eceb;
  }
  .sb-thread-title { min-width: 0; }
  .sb-thread-title-row { display: flex; align-items: center; gap: 10px; }
  .sb-thread-title h2 { margin: 0; overflow-wrap: anywhere; font: 800 18px/1.2 Manrope, sans-serif; letter-spacing: -.035em; }
  .sb-thread-title p { margin: 6px 0 0; color: #7b8882; font-size: 12px; }
  .sb-open-dot { width: 8px; height: 8px; border-radius: 50%; background: #19a57e; box-shadow: 0 0 0 4px rgba(25,165,126,.10); }
  .sb-closed-dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa5a1; }
  .sb-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .sb-button {
    min-height: 38px;
    padding: 0 13px;
    border: 1px solid #e0e8e4;
    border-radius: 10px;
    background: #fff;
    color: #34443f;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    transition: transform .15s ease, box-shadow .15s ease, background .15s ease, border-color .15s ease;
  }
  .sb-button:hover:not(:disabled) { transform: translateY(-1px); border-color: #b7d8ce; background: #f3faf7; box-shadow: 0 5px 14px rgba(20,125,105,.08); }
  .sb-button:disabled { opacity: .55; cursor: not-allowed; }
  .sb-button.primary { border-color: #147d69; background: #147d69; color: #fff; box-shadow: 0 5px 12px rgba(20,125,105,.16); }
  .sb-button.primary:hover:not(:disabled) { background: #106b5a; }
  .sb-button.danger:hover:not(:disabled) { border-color: #edc8c1; background: #fff6f4; color: #a93627; }

  .sb-tabs { display: flex; gap: 4px; padding: 10px clamp(16px, 2.4vw, 32px); background: #fff; border-bottom: 1px solid #e8eceb; }
  .sb-tab { min-height: 36px; padding: 0 12px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #75817c; cursor: pointer; font-size: 12px; font-weight: 700; }
  .sb-tab:hover { background: #f4f7f6; }
  .sb-tab.active { border-color: #d2e9e1; background: #e8f4f0; color: #126d5b; }
  .sb-tab.note.active { border-color: #f2dbab; background: #fff6df; color: #8b6415; }

  .sb-transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 28px;
    display: flex;
    flex-direction: column;
    gap: 13px;
    background-color: #f7f9f8;
    background-image: radial-gradient(#e9eeec .65px, transparent .65px);
    background-size: 18px 18px;
  }
  .sb-message-row { display: flex; gap: 9px; align-items: flex-end; }
  .sb-message-row.outbound { justify-content: flex-end; }
  .sb-message-row.inbound { justify-content: flex-start; }
  .sb-message-avatar { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: #e2ebe7; color: #5d7069; font-size: 8px; font-weight: 800; flex: 0 0 auto; }
  .sb-message-row.outbound .sb-message-avatar { order: 2; background: #d3eae2; color: #147d69; }
  .sb-message { max-width: min(72%, 620px); padding: 12px 15px; border: 1px solid #e6ebe9; border-radius: 16px; background: #fff; box-shadow: 0 3px 10px rgba(24,43,38,.035); }
  .sb-message.outbound { border-color: #d3eae2; border-bottom-right-radius: 5px; background: #e8f4f0; }
  .sb-message.inbound { border-bottom-left-radius: 5px; }
  .sb-message-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; color: #25342f; font-size: 13px; }
  .sb-message-meta { margin-top: 7px; color: #7d8984; font-size: 9px; text-align: right; }
  .sb-note { padding: 14px; border: 1px solid #f1dfb7; border-radius: 14px; background: #fff7e6; box-shadow: 0 3px 10px rgba(139,100,21,.04); }
  .sb-note p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; color: #493b20; line-height: 1.5; font-size: 13px; }
  .sb-note small { color: #8b6b2b; font-size: 10px; }
  .sb-thread-empty { margin: auto; padding: 30px; text-align: center; color: #899690; }
  .sb-thread-empty-icon { width: 52px; height: 52px; display: grid; place-items: center; margin: 0 auto 13px; border: 1px solid #dce7e2; border-radius: 16px; background: #fff; color: #147d69; font-size: 22px; box-shadow: 0 7px 20px rgba(29,49,45,.05); }
  .sb-thread-empty strong { display: block; color: #4c5b56; font-size: 14px; }
  .sb-thread-empty p { margin: 7px 0 0; font-size: 12px; }

  .sb-composer { display: flex; align-items: center; gap: 10px; padding: 14px clamp(16px, 2.4vw, 32px); background: #fff; border-top: 1px solid #e8eceb; }
  .sb-composer-input { min-width: 0; flex: 1; min-height: 44px; padding: 0 13px; border: 1px solid #e3e9e6; border-radius: 11px; outline: none; background: #fbfcfc; color: #17212b; }
  .sb-composer-input:focus { border-color: #75b9a6; box-shadow: 0 0 0 3px rgba(20,125,105,.10); background: #fff; }
  .sb-composer .sb-button { min-height: 44px; padding: 0 17px; }

  @media (max-width: 760px) {
    .sb-topbar { height: 64px; }
    .sb-brand-copy span { display: none; }
    .sb-user-pill { display: none; }
    .sb-layout { height: calc(100dvh - 64px); min-height: 0; grid-template-columns: minmax(118px, 34%) minmax(0, 1fr); }
    .sb-sidebar-head { padding: 17px 12px 12px; }
    .sb-search { display: none; }
    .sb-conversation { grid-template-columns: 30px minmax(0, 1fr); gap: 7px; padding: 13px 10px; }
    .sb-avatar { width: 30px; height: 30px; font-size: 9px; }
    .sb-contact { font-size: 10px; }
    .sb-time, .sb-preview { font-size: 9px; }
    .sb-meta, .sb-status { font-size: 8px; }
    .sb-thread-head { align-items: flex-start; gap: 10px; }
    .sb-thread-title h2 { font-size: 15px; }
    .sb-actions { flex-wrap: wrap; justify-content: flex-end; }
    .sb-button { min-height: 34px; padding: 0 9px; font-size: 10px; }
    .sb-transcript { padding: 16px; }
    .sb-message { max-width: 90%; }
    .sb-message-avatar { display: none; }
    .sb-composer { gap: 7px; padding: 11px; }
    .sb-composer .sb-button { padding: 0 11px; }
  }

  @media (max-width: 420px) {
    .sb-topbar { padding: 0 12px; }
    .sb-brand-copy strong { font-size: 15px; }
    .sb-workspace-select { min-width: 0; max-width: 135px; height: 38px; font-size: 10px; }
    .sb-switch { font-size: 10px; }
    .sb-layout { grid-template-columns: 105px minmax(0, 1fr); }
    .sb-sidebar-title-row h2 { font-size: 15px; }
    .sb-live { padding: 5px 6px; font-size: 8px; }
    .sb-conversation { padding: 11px 7px; }
    .sb-avatar { display: none; }
    .sb-conversation { grid-template-columns: minmax(0, 1fr); }
    .sb-conversation-bottom { display: block; }
    .sb-status { display: inline-block; margin-top: 4px; }
    .sb-thread-head { flex-direction: column; }
    .sb-actions { width: 100%; justify-content: flex-start; }
    .sb-message { max-width: 92%; }
  }
`;

export function App() {
  const [user, setUser] = useState<{
    sub: string;
    workspaces: Workspace[];
  } | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [tab, setTab] = useState<"messages" | "notes">("messages");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useMemo(
    () => conversations.find((c) => c.contact === selected),
    [conversations, selected],
  );

  const visibleConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((c) =>
      [c.contact, c.assignee || "", c.closed ? "closed" : "open"].some(
        (value) => value.toLowerCase().includes(query),
      ),
    );
  }, [conversations, search]);

  const refreshList = useCallback(async () => {
    if (!workspace) return;
    const result = await api(
      `/api/conversations?workspace=${encodeURIComponent(workspace)}`,
    );
    setConversations(result.data);
    setSelected((current) => current || result.data[0]?.contact || "");
  }, [workspace]);

  const refreshThread = useCallback(async () => {
    if (!workspace || !selected) {
      setMessages([]);
      setNotes([]);
      return;
    }

    const [m, n] = await Promise.all([
      api(
        `/api/conversations/${encodeURIComponent(selected)}/messages?workspace=${encodeURIComponent(workspace)}`,
      ),
      api(
        `/api/conversations/${encodeURIComponent(selected)}/notes?workspace=${encodeURIComponent(workspace)}`,
      ),
    ]);
    setMessages(m.data);
    setNotes(n.data);
  }, [workspace, selected]);

  const selectedRef = useRef(selected);
  const refreshThreadRef = useRef(refreshThread);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    refreshThreadRef.current = refreshThread;
  }, [refreshThread]);

  useEffect(() => {
    api("/api/me")
      .then((data) => {
        setUser(data);
        setWorkspace(data.workspaces[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refreshList().catch((e) => setError(e.message));
  }, [refreshList]);

  useEffect(() => {
    refreshThread().catch((e) => setError(e.message));
  }, [refreshThread]);

  useEffect(() => {
    if (!workspace) return;
    let socket: WebSocket | undefined;
    let retry: number;
    let lastSeq = 0;

    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}&after=${lastSeq}`,
      );

      socket.onmessage = (event) => {
        const item = JSON.parse(event.data);
        lastSeq = Math.max(lastSeq, item.seq || 0);
        refreshList().catch(() => {});
        if (item.contact === selectedRef.current)
          refreshThreadRef.current().catch(() => {});
      };

      socket.onclose = () => {
        retry = window.setTimeout(connect, 1200);
      };
    };

    connect();
    return () => {
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [workspace, refreshList]);

  async function claim() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/conversations/${encodeURIComponent(selected)}/claim`, {
        method: "POST",
        body: JSON.stringify({ workspace }),
      });
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleClosed() {
    if (!selected) return;
    setBusy(true);
    try {
      await api(
        `/api/conversations/${encodeURIComponent(selected)}/${active?.closed ? "reopen" : "close"}`,
        {
          method: "POST",
          body: JSON.stringify({ workspace }),
        },
      );
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !selected) return;
    setBusy(true);
    setError("");
    try {
      const client_ref = `web_${crypto.randomUUID()}`;
      await api("/api/reply", {
        method: "POST",
        body: JSON.stringify({
          workspace,
          contact: selected,
          text: draft.trim(),
          client_ref,
        }),
      });
      setDraft("");
      await refreshThread();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteDraft.trim() || !selected) return;
    setBusy(true);
    try {
      await api(`/api/conversations/${encodeURIComponent(selected)}/notes`, {
        method: "POST",
        body: JSON.stringify({ workspace, text: noteDraft.trim() }),
      });
      setNoteDraft("");
      await refreshThread();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <main className="sb-loading">
        <style>{frontendStyles}</style>
        <section className="sb-auth-card">
          <div className="sb-brand-mark">S</div>
          <h1>Switchboard</h1>
          <p>Shared team inbox for fast, organized customer support.</p>
          {error && <p style={{ color: "#b42318" }}>{error}</p>}
          <a href="/auth/login">Sign in to continue →</a>
        </section>
      </main>
    );
  }

  return (
    <main className="sb-app">
      <style>{frontendStyles}</style>

      <header className="sb-topbar">
        <div className="sb-brand">
          <div className="sb-brand-mark">S</div>
          <div className="sb-brand-copy">
            <strong>Switchboard</strong>
            <span>Team inbox</span>
          </div>
        </div>

        <div className="sb-top-actions">
          <select
            className="sb-workspace-select"
            value={workspace}
            aria-label="Workspace"
            onChange={(e) => {
              setWorkspace(e.target.value);
              setSelected("");
            }}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} · {w.role}
              </option>
            ))}
          </select>
          <div className="sb-user-pill">
            <span className="sb-user-avatar">{shortName(user.sub)}</span>
            <span>{user.sub}</span>
          </div>
          <a className="sb-switch" href="/auth/login">
            Switch user
          </a>
        </div>
      </header>

      {error && (
        <div className="sb-error">
          <span>{error}</span>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      <section className="sb-layout">
        <aside className="sb-sidebar">
          <div className="sb-sidebar-head">
            <div className="sb-sidebar-title-row">
              <div>
                <h2>Inbox</h2>
                <p>{conversations.length} conversations</p>
              </div>
              <span className="sb-live">LIVE</span>
            </div>
            <input
              className="sb-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              aria-label="Search conversations"
            />
          </div>

          {visibleConversations.map((c) => (
            <button
              key={c.contact}
              className={`sb-conversation ${selected === c.contact ? "active" : ""}`}
              onClick={() => {
                setSelected(c.contact);
                setTab("messages");
              }}
            >
              <span className="sb-avatar">{shortName(c.contact)}</span>
              <span className="sb-conversation-main">
                <span className="sb-conversation-top">
                  <span className="sb-contact">{phoneLabel(c.contact)}</span>
                  <span className="sb-time">{time(c.lastActivityAt)}</span>
                </span>
                <span className="sb-preview">Customer conversation</span>
                <span className="sb-conversation-bottom">
                  <span className="sb-meta">
                    {c.assignee ? `Assigned · ${c.assignee}` : "Unassigned"}
                  </span>
                  <span className={`sb-status ${c.closed ? "" : "open"}`}>
                    {c.closed ? "Closed" : "Open"}
                  </span>
                </span>
              </span>
            </button>
          ))}

          {!visibleConversations.length && (
            <div className="sb-empty">
              {search
                ? "No conversations match your search."
                : "No conversations yet. Incoming messages will appear here."}
            </div>
          )}
        </aside>

        <section className="sb-thread">
          {active ? (
            <>
              <div className="sb-thread-head">
                <div className="sb-thread-title">
                  <div className="sb-thread-title-row">
                    <span
                      className={
                        active.closed ? "sb-closed-dot" : "sb-open-dot"
                      }
                    />
                    <h2>{phoneLabel(active.contact)}</h2>
                  </div>
                  <p>
                    {active.assignee
                      ? `Assigned to ${active.assignee}`
                      : "Unassigned"}{" "}
                    · {active.closed ? "Closed" : "Open"}
                  </p>
                </div>

                <div className="sb-actions">
                  <button className="sb-button" disabled={busy} onClick={claim}>
                    Claim
                  </button>
                  <button
                    className="sb-button danger"
                    disabled={busy}
                    onClick={toggleClosed}
                  >
                    {active.closed ? "Reopen" : "Close"}
                  </button>
                </div>
              </div>

              <div className="sb-tabs">
                <button
                  className={`sb-tab ${tab === "messages" ? "active" : ""}`}
                  onClick={() => setTab("messages")}
                >
                  Messages
                </button>
                <button
                  className={`sb-tab note ${tab === "notes" ? "active" : ""}`}
                  onClick={() => setTab("notes")}
                >
                  Private notes ({notes.length})
                </button>
              </div>

              {tab === "messages" ? (
                <>
                  <div className="sb-transcript">
                    {messages.map((m, i) => {
                      const outbound = m.direction === "outbound";
                      return (
                        <div
                          key={m._id || i}
                          className={`sb-message-row ${outbound ? "outbound" : "inbound"}`}
                        >
                          <span className="sb-message-avatar">
                            {shortName(outbound ? user.sub : active.contact)}
                          </span>
                          <div
                            className={`sb-message ${outbound ? "outbound" : "inbound"}`}
                          >
                            <div className="sb-message-text">{m.text}</div>
                            <div className="sb-message-meta">
                              {time(m.occurredAt || m.createdAt)}{" "}
                              {outbound ? `· ${m.status}` : ""}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {!messages.length && (
                      <div className="sb-thread-empty">
                        <div className="sb-thread-empty-icon">✦</div>
                        <strong>No messages yet</strong>
                        <p>
                          New customer messages will appear in this
                          conversation.
                        </p>
                      </div>
                    )}
                  </div>

                  <form className="sb-composer" onSubmit={sendReply}>
                    <input
                      className="sb-composer-input"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Write a reply…"
                      aria-label="Reply"
                    />
                    <button
                      className="sb-button primary"
                      disabled={busy || !draft.trim()}
                    >
                      Send
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <div className="sb-transcript">
                    {notes.map((n, i) => (
                      <article className="sb-note" key={n._id || i}>
                        <p>{n.text}</p>
                        <small>
                          {n.author} · {time(n.createdAt)}
                        </small>
                      </article>
                    ))}
                    {!notes.length && (
                      <div className="sb-thread-empty">
                        <div className="sb-thread-empty-icon">✎</div>
                        <strong>No private notes yet</strong>
                        <p>Add an internal note for your support team.</p>
                      </div>
                    )}
                  </div>

                  <form className="sb-composer" onSubmit={addNote}>
                    <input
                      className="sb-composer-input"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="Add a private note for your team…"
                      aria-label="Private note"
                    />
                    <button
                      className="sb-button"
                      disabled={busy || !noteDraft.trim()}
                      style={{
                        background: "#8b6415",
                        borderColor: "#8b6415",
                        color: "#fff",
                      }}
                    >
                      Add note
                    </button>
                  </form>
                </>
              )}
            </>
          ) : (
            <div className="sb-thread-empty">
              <div className="sb-thread-empty-icon">✉</div>
              <strong>Select a conversation</strong>
              <p>Choose a customer from your inbox to view the thread.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
