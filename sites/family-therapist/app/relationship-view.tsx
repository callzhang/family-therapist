"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type Thread = { thread_id: string; title: string; status: "pending" | "active" | "settled"; summary: string };
type Message = { message_id: string; kind: string; actor_id: string; body: unknown; created_at: string };
type Agreement = { agreement_id: string; thread_id: string | null; version: number; text: string };
type TherapistTask = { message_id: string; status: "queued" | "running" | "failed" | "obsolete" | "completed"; last_error_code: string | null; created_at: string } | null;
type ViewData = { threads: Thread[]; selected: Thread | null; messages: Message[]; has_earlier: boolean; understanding: unknown; therapist_task: TherapistTask; agreements: Agreement[]; refreshed_at: string; role: string; viewer_id: string; members: { user_id: string; role: string }[]; snapshot_seq: number };
type ViewError = { code?: string; error?: string };

function bodyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.text === "string") return body.text;
  if (typeof body.reply === "string") return body.reply;
  if (Array.isArray(body.sections)) return body.sections.map((value) => {
    if (!value || typeof value !== "object") return JSON.stringify(value);
    const section = value as Record<string, unknown>;
    return `${typeof section.heading === "string" ? `${section.heading}\n` : ""}${typeof section.text === "string" ? section.text : ""}`;
  }).join("\n\n");
  return null;
}
function roleName(role: string | undefined) {
  if (role === "husband") return "丈夫";
  if (role === "wife") return "妻子";
  if (role === "member") return "共同空间成员";
  if (role === "therapist") return "AI 咨询师";
  return role ?? "共同空间成员";
}
function date(value: string) { return new Date(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }); }
function statusName(status: string) { return status === "settled" ? "已结束" : status === "pending" ? "待讨论" : "进行中"; }
function therapistTaskMessage(status: NonNullable<TherapistTask>["status"] | undefined) {
  if (status === "queued") return "表达已保存，等待咨询处理。";
  if (status === "running") return "咨询正在处理这次表达。";
  if (status === "failed") return "这次咨询未能完成，尚未发布回复。";
  if (status === "obsolete") return "议题或共同原则已变化，本次没有发布回复。";
  if (status === "completed") return "这次咨询已完成。";
  return null;
}

export function RelationshipView() {
  const [data, setData] = useState<ViewData | null>(null);
  const [error, setError] = useState<ViewError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [threadId, setThreadId] = useState("");
  const [section, setSection] = useState<"consultation" | "principles" | "archives">("consultation");
  const [connectionCode, setConnectionCode] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("");
  const latestRequest = useRef(0);
  const load = useCallback(async (id: string, quiet = false) => {
    const requestId = ++latestRequest.current;
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const response = await fetch(`/api/view${id ? `?thread=${encodeURIComponent(id)}` : ""}`, { cache: "no-store" });
      const json = await response.json() as ViewData & ViewError;
      if (!response.ok) throw json;
      if (requestId !== latestRequest.current) return;
      setData(json); setError(null);
      if (json.selected?.thread_id) setThreadId(json.selected.thread_id);
    } catch (cause) {
      if (requestId !== latestRequest.current) return;
      const nextError = typeof cause === "object" && cause !== null ? cause as ViewError : { error: "暂时无法读取共同空间，请稍后重试。" };
      if (nextError.code === "requires_member_token") { setData(null); setThreadId(""); setSection("consultation"); }
      setError(nextError);
    } finally {
      if (requestId === latestRequest.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  const connectWithCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = connectionCode.trim();
    setConnectionCode("");
    setSessionMessage("");
    if (!token) { setSessionMessage("请输入个人连接码。"); return; }
    setConnecting(true);
    try {
      const response = await fetch("/api/member-session", { method: "POST", headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const result = await response.json() as ViewError;
      if (!response.ok) { setSessionMessage(result.error ?? "无法建立会话，请检查连接码后重试。"); return; }
      setData(null); setError(null); setThreadId(""); setSection("consultation");
      await load("");
    } catch {
      setSessionMessage("暂时无法建立会话，请稍后重试。");
    } finally {
      setConnectionCode("");
      setConnecting(false);
    }
  };

  const exitMemberSession = async () => {
    setSessionMessage("");
    try {
      const response = await fetch("/api/member-session", { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error("session_clear_failed");
      latestRequest.current += 1;
      setData(null); setThreadId(""); setSection("consultation");
      setError({ code: "requires_member_token", error: "请输入你的个人连接码以进入共同空间。" });
    } catch {
      setSessionMessage("暂时无法退出，请稍后重试。");
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(""), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(threadId, true); }, 30000);
    return () => window.clearInterval(timer);
  }, [load, threadId]);
  const chooseThread = (id: string, fromArchive = false) => {
    setThreadId(id);
    setSection(fromArchive ? "consultation" : section);
    void load(id);
  };

  const threads = data?.threads ?? [];
  const selected = data?.selected ?? null;
  const agreements = data?.agreements ?? [];
  const understanding = data?.understanding as Record<string, unknown> | null;
  const taskMessage = therapistTaskMessage(data?.therapist_task?.status);
  const groups = useMemo(() => [
    { key: "common_points", title: "你们的共同点" },
    { key: "differences", title: "仍有不同的感受" },
    { key: "hypotheses", title: "可以继续探索的问题" },
  ].map((group) => ({ ...group, items: Array.isArray(understanding?.[group.key]) ? understanding[group.key] as Record<string, unknown>[] : [] })), [understanding]);

  const needsMemberToken = Boolean(error && !data && error.code === "requires_member_token");
  return <main className="min-h-screen bg-[#f7f6f1] text-[#25332f]">
    <header className="sticky top-0 z-10 flex h-[68px] items-center justify-between border-b border-[#e4e5dc] bg-[#fbfaf6]/95 px-4 backdrop-blur sm:px-6 md:px-9">
      <a className="flex items-center gap-3" href="#home" onClick={() => setSection("consultation")}><span className="grid h-9 w-9 place-items-center rounded-full bg-[#e5ece2] text-[#536a57]">✳</span><span><strong className="block text-[15px] tracking-tight">我们之间</strong><span className="text-[11px] text-[#7b8278]">关系咨询 · 共同理解</span></span></a>
      <div className="flex items-center gap-2"><span className="hidden rounded-full border border-[#e5e5dc] bg-white px-3 py-1.5 text-xs text-[#727b70] sm:inline">仅共同空间成员可见</span>{data && <><span className="hidden text-xs text-[#727b70] sm:inline">{roleName(data.role)}</span>{sessionMessage && <span role="status" className="text-xs text-[#815340]">{sessionMessage}</span>}<button onClick={() => void exitMemberSession()} className="rounded-full border border-[#dfe2d7] px-3 py-2 text-xs hover:bg-white">退出</button></>}{!needsMemberToken && <button onClick={() => void load(threadId, true)} className="rounded-full border border-[#dfe2d7] px-3 py-2 text-xs hover:bg-white">{refreshing ? "正在更新…" : "刷新"}</button>}</div>
    </header>
    <div className="mx-auto grid max-w-[1500px] gap-0 lg:grid-cols-[220px_minmax(0,1fr)_320px]">
      <aside className="border-b border-[#e4e5dc] p-3 sm:p-4 lg:min-h-[calc(100vh-68px)] lg:border-b-0 lg:border-r lg:p-6">
        <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[.16em] text-[#91968b] sm:px-3">共同空间</p>
        <nav aria-label="页面导航" className="grid grid-cols-3 gap-1 lg:grid-cols-1">
          {([ ["consultation", "当前对话", "◷"], ["principles", "共同理解", "◇"], ["archives", "历史记录", "⌁"] ] as const).map(([id, name, icon]) => <button key={id} onClick={() => setSection(id)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-2 py-2 text-center text-[11px] sm:text-xs lg:justify-start lg:px-3 lg:text-[13px] ${section === id ? "bg-[#e9eee5] font-medium text-[#405847]" : "text-[#71796f] hover:bg-white"}`}><span className="text-base" aria-hidden="true">{icon}</span><span>{name}</span></button>)}
        </nav>
        {section !== "principles" && <div className="mt-4 lg:mt-8">
          <label htmlFor="thread-picker" className="mb-2 block px-1 text-[10px] font-semibold uppercase tracking-[.16em] text-[#91968b]">{section === "archives" ? "全部议题" : "选择对话"}</label>
          <select id="thread-picker" value={threadId || selected?.thread_id || ""} onChange={(event) => chooseThread(event.target.value, section === "archives")} className="w-full rounded-xl border border-[#dfe2d7] bg-white px-3 py-2.5 text-sm text-[#46544a] outline-none focus:ring-2 focus:ring-[#9eae98]">
            {!threads.length && <option value="">还没有对话</option>}
            {threads.map((thread) => <option key={thread.thread_id} value={thread.thread_id}>{thread.title} · {statusName(thread.status)}</option>)}
          </select>
          <div className="mt-3 hidden space-y-1 lg:block">{threads.map((thread) => <button key={thread.thread_id} onClick={() => chooseThread(thread.thread_id)} className={`w-full rounded-xl px-3 py-3 text-left ${thread.thread_id === selected?.thread_id ? "bg-white shadow-sm" : "hover:bg-white/70"}`}><span className="block truncate text-[13px] font-medium">{thread.title}</span><span className="mt-1 block text-[11px] text-[#899087]">{statusName(thread.status)}</span></button>)}</div>
        </div>}
        <div className="mt-8 hidden rounded-2xl bg-[#edf0e9] p-4 lg:block"><span className="text-lg">☼</span><p className="mt-2 text-[12px] font-medium">给彼此一点空间</p><p className="mt-1 text-[11px] leading-relaxed text-[#788074]">慢慢理解彼此的经历，不必急着得出结论。</p></div>
      </aside>
      <section className="min-w-0 px-4 py-7 sm:px-6 md:px-10 md:py-10">
        {threadId && selected && threadId !== selected.thread_id && loading && <div role="status" className="mb-4 rounded-xl bg-[#edf0e9] px-4 py-3 text-xs text-[#687667]">正在打开所选对话；下方仍是上次完整读取的内容。</div>}
        {error && data && <div role="status" className="mb-5 flex items-center justify-between rounded-xl border border-[#ebd4c9] bg-[#fff8f4] p-4 text-sm text-[#815340]"><span>{error.error ?? "更新失败，当前显示上次读取的内容。"} 当前显示上次读取的内容。</span><button onClick={() => void load(threadId)} className="font-medium underline">重试</button></div>}
        {error && !data ? <div role="alert" className="mx-auto mt-12 max-w-lg rounded-2xl border border-[#e5e6dd] bg-white p-6 text-center"><p className="font-serif text-2xl text-[#405247]">{needsMemberToken ? "进入共同空间" : "暂时无法打开共同空间"}</p><p className="mt-3 text-sm leading-6 text-[#788074]">{needsMemberToken ? "请输入你自己的个人连接码。此连接码只用于当前浏览器会话。" : error.error ?? "请稍后重试。"}</p>{needsMemberToken ? <form className="mt-5 text-left" onSubmit={connectWithCode}><label className="mb-2 block text-sm font-medium text-[#526153]" htmlFor="member-connection-code">个人连接码</label><input id="member-connection-code" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={connectionCode} onChange={(event) => setConnectionCode(event.target.value)} className="w-full rounded-xl border border-[#dfe2d7] bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[#9eae98]" aria-describedby="connection-code-message"/><button disabled={connecting} className="mt-3 w-full rounded-full bg-[#62785f] px-5 py-3 text-sm font-medium text-white hover:bg-[#52684f] disabled:opacity-60">{connecting ? "正在进入…" : "进入共同空间"}</button>{sessionMessage && <p id="connection-code-message" className="mt-3 text-center text-sm text-[#815340]">{sessionMessage}</p>}</form> : <button onClick={() => void load("")} className="mt-5 rounded-full border border-[#dfe2d7] px-5 py-2.5 text-sm">重试</button>}</div>
        : loading && !data ? <div className="py-24 text-center text-sm text-[#7c8479]">正在打开共同空间…</div> : section === "principles" ? <>
          <p className="text-xs font-medium uppercase tracking-[.15em] text-[#90968b]">共同空间中已确认的内容</p><h1 className="mt-2 font-serif text-3xl text-[#34423a] md:text-4xl">共同理解</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#768076]">这些是你们共同确认的相处原则和议题结论。</p>
          <div className="mt-5 flex flex-wrap gap-2"><ArchiveDownload href="/api/archives/agreements?format=md" className="rounded-full bg-[#edf1e9] px-4 py-2.5 text-xs font-medium text-[#536b54]">下载共同原则与结论 · Markdown</ArchiveDownload><ArchiveDownload href="/api/archives/agreements?format=jsonl" className="rounded-full border border-[#e5e6dd] bg-white px-4 py-2.5 text-xs text-[#697368]">下载共同原则与结论 · JSONL</ArchiveDownload></div>
          <div className="mt-8 space-y-3">{agreements.map((item) => <article key={item.agreement_id} className="rounded-2xl border border-[#e7e7dd] bg-white p-5 md:p-6"><p className="mb-3 text-[10px] font-semibold uppercase tracking-[.14em] text-[#788a73]">{item.thread_id ? "具体议题结论" : "共同相处原则"}</p><p className="whitespace-pre-wrap break-words font-serif text-lg leading-7">{item.text}</p><p className="mt-4 text-[11px] text-[#92988e]">已确认版本 {item.version}</p></article>)}{!agreements.length && <Empty />}</div>
        </> : section === "archives" ? <><p className="text-xs font-medium uppercase tracking-[.15em] text-[#90968b]">所有议题</p><h1 className="mt-2 font-serif text-3xl text-[#34423a] md:text-4xl">对话与记录</h1><p className="mt-3 text-sm leading-6 text-[#768076]">查看各议题状态，打开对话可阅读内容。历史浏览不会改变议题状态。</p><div className="mt-8 space-y-3">{threads.map((item) => <article key={item.thread_id} className="rounded-2xl border border-[#e7e7dd] bg-white p-5"><button className="text-left" onClick={() => chooseThread(item.thread_id, true)}><span className="block font-serif text-xl">{item.title}</span><span className="mt-1 block text-xs text-[#838b80]">{statusName(item.status)} · {item.summary}</span></button><div className="mt-4 flex flex-wrap gap-2"><a className="rounded-full bg-[#edf1e9] px-3 py-2 text-xs font-medium text-[#536b54]" href={`/api/archives/${encodeURIComponent(item.thread_id)}?format=md`}>下载 Markdown</a><a className="rounded-full border border-[#e5e6dd] px-3 py-2 text-xs text-[#697368]" href={`/api/archives/${encodeURIComponent(item.thread_id)}?format=jsonl`}>下载 JSONL</a></div></article>)}{!threads.length && <Empty />}</div></> : <>
          <p className="text-xs font-medium uppercase tracking-[.15em] text-[#90968b]">{selected?.status === "settled" ? "已结束 · 仅供查阅" : "共同探索中"}</p><h1 className="mt-2 font-serif text-3xl leading-tight text-[#34423a] md:text-4xl">{selected?.title ?? "为彼此留出理解的空间"}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#768076]">{selected?.summary ?? "在这里阅读已经分享的表达，也留意正在逐渐清晰的部分。"}</p>
          <div className="mt-7 flex items-center justify-between border-b border-[#e5e5dc] pb-3"><span className="text-xs text-[#838a80]">{selected ? statusName(selected.status) : "等待第一次对话"}</span><span className="text-[11px] text-[#999e95]">{data?.refreshed_at ? `更新于 ${date(data.refreshed_at)}` : ""}</span></div>{selected?.status === "settled" && <p className="mt-3 rounded-xl bg-[#edf0e9] px-4 py-3 text-xs leading-5 text-[#687667]">本议题已结束，这里仅供回顾当时的记录。浏览不会改变状态；如需重开，须双方共同同意。</p>}
          {taskMessage && <p role="status" className="mt-4 rounded-xl border border-[#e2e6dc] bg-white/80 px-4 py-3 text-xs leading-5 text-[#687667]">最近一次已确认表达：{taskMessage}</p>}
          {data?.has_earlier && <div className="my-4 rounded-lg bg-[#ecefe8] px-4 py-3 text-xs text-[#687667]">更早的表达未在此页展开，可下载完整对话记录。<span className="mt-2 flex gap-3"><a className="underline" href={`/api/archives/${encodeURIComponent(selected!.thread_id)}?format=md`}>下载 Markdown</a><a className="underline" href={`/api/archives/${encodeURIComponent(selected!.thread_id)}?format=jsonl`}>下载 JSONL</a></span></div>}
          <div className="space-y-5 py-5">{data?.messages.filter((message) => message.kind === "member_expression" || message.kind === "therapist_reply").map((message) => { const content = bodyText(message.body); const memberExpression = message.kind === "member_expression"; const speaker = memberExpression ? (message.actor_id === data.viewer_id ? "你" : roleName(data.members.find((person) => person.user_id === message.actor_id)?.role)) : "AI 咨询师回复"; return <article id={message.message_id} key={message.message_id} className={`rounded-2xl border p-5 md:p-6 ${memberExpression ? "border-[#e7e3d8] bg-white" : "border-[#e0e8de] bg-[#f0f4ed]"}`}><div className="mb-3 flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-[.12em] text-[#758174]">{speaker}</span><time className="text-[11px] text-[#a0a49c]">{date(message.created_at)}</time></div>{content !== null ? <p className="whitespace-pre-wrap break-words font-serif text-[16px] leading-7 text-[#3a443d]">{content}</p> : <div className="rounded-xl bg-[#f4f2ec] p-4 text-sm leading-6 text-[#697368]">这条表达的正文格式暂不支持在网页中展开。可下载 JSONL 档案查看完整原始记录。<a className="ml-1 underline" href={`/api/archives/${encodeURIComponent(selected!.thread_id)}?format=jsonl`}>下载 JSONL</a></div>}</article>; })}{!data?.messages.some((message) => message.kind === "member_expression" || message.kind === "therapist_reply") && <Empty />}</div>
        </>}
      </section>
      {section !== "archives" && <aside className="border-t border-[#e4e5dc] bg-[#f3f3ed] px-4 py-7 sm:px-6 md:px-8 lg:min-h-[calc(100vh-68px)] lg:border-l lg:border-t-0 lg:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#8c9388]">自动整理 · 供共同参考</p><h2 className="mt-2 font-serif text-2xl text-[#3a4940]">{selected?.status === "settled" ? "当时的共同理解" : "正在形成的理解"}</h2>{selected?.status === "settled" && <p className="mt-2 text-xs leading-5 text-[#7e867b]">历史记录仅供查阅；重开议题须双方共同同意。</p>}
        {understanding ? <div className="mt-5 space-y-5">{groups.map((group) => <section key={group.key}><h3 className="mb-2 text-xs font-semibold text-[#5b6a5b]">{group.title}</h3>{group.items.map((item, index) => { const txt = typeof item.text === "string" ? item.text : ""; const sourceIds = Array.isArray(item.source_message_ids) ? item.source_message_ids.filter((id): id is string => typeof id === "string") : []; const valid = sourceIds.map((id) => data?.messages.find((message) => message.message_id === id)).filter((message): message is Message => Boolean(message)); return <article key={`${group.key}-${index}`} className="mb-2 rounded-xl border border-[#e5e6dc] bg-white/85 p-3.5"><p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-[#596259]">{txt}</p>{valid.length > 0 && <p className="mt-2 flex flex-wrap gap-x-2 text-[10px] text-[#92998f]">依据：{valid.map((message) => <a key={message.message_id} className="underline" href={`#${message.message_id}`}>{message.actor_id === data?.viewer_id ? "你" : roleName(data?.members.find((person) => person.user_id === message.actor_id)?.role)}</a>)}</p>}</article>; })}{!group.items.length && <p className="text-xs text-[#989e94]">暂未记录</p>}</section>)}</div> : <div className="mt-5 rounded-xl border border-[#e4e5dc] bg-white/80 p-4 text-xs leading-5 text-[#7e867b]">已有共同理解时，会在这里显示共同点、差异和仍可探索的问题。</div>}
        <div className="mt-6"><h3 className="mb-2 text-xs font-semibold text-[#5b6a5b]">已确认的共识</h3>{agreements.filter((item) => !item.thread_id || item.thread_id === selected?.thread_id).map((item) => <article key={item.agreement_id} className="mb-2 rounded-xl border border-[#dfe7da] bg-[#eaf0e6] p-3.5"><p className="mb-1 text-[9px] font-semibold uppercase tracking-[.13em] text-[#788a73]">{item.thread_id ? "本议题结论" : "共同相处原则"}</p><p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-[#536352]">{item.text}</p></article>)}</div>
        <p className="mt-6 border-t border-[#e0e2d9] pt-4 text-[10px] leading-4 text-[#969c91]">自动整理仅供参考；只有共同确认的内容才会显示为正式共识。</p>
      </aside>}
    </div>
  </main>;
}
function Empty() { return <div className="rounded-2xl border border-dashed border-[#dfe2d7] bg-white/50 px-6 py-12 text-center"><span className="text-2xl text-[#a2ac9a]">✳</span><p className="mt-3 font-serif text-xl text-[#4c5d50]">这里暂时还没有内容</p><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#879085]">任何一方通过自己的 Codex 开始咨询后，已分享的表达和共同理解会显示在这里。</p></div>; }
function ArchiveDownload({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  return <a href={href} className={className}>{children}</a>;
}
