"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Thread = { thread_id: string; title: string; status: "pending" | "active" | "settled"; summary: string };
type Message = { message_id: string; kind: string; actor_id: string; body: unknown; created_at: string };
type Agreement = { agreement_id: string; thread_id: string | null; version: number; text: string };
type ViewData = { threads: Thread[]; selected: Thread | null; messages: Message[]; has_earlier: boolean; understanding: unknown; agreements: Agreement[]; refreshed_at: string; role: string; viewer_id: string; members: { user_id: string; role: string }[]; snapshot_seq: number };

function bodyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.text === "string") return body.text;
  if (typeof body.reply === "string") return body.reply;
  if (Array.isArray(body.sections)) return body.sections.map((item) => {
    if (!item || typeof item !== "object") return JSON.stringify(item);
    const section = item as Record<string, unknown>;
    return `${typeof section.heading === "string" ? `${section.heading}\n` : ""}${typeof section.text === "string" ? section.text : ""}`;
  }).join("\n\n");
  return null;
}
function date(value: string) { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function statusName(status: string) { return status === "settled" ? "Settled" : status === "pending" ? "Gathering thoughts" : "In progress"; }

export function RelationshipView() {
  const [data, setData] = useState<ViewData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [threadId, setThreadId] = useState("");
  const [section, setSection] = useState<"consultation" | "principles" | "archives">("consultation");
  const load = useCallback(async (id = threadId, quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const response = await fetch(`/api/view${id ? `?thread=${encodeURIComponent(id)}` : ""}`, { cache: "no-store" });
      const json = await response.json() as ViewData & { error?: string };
      if (!response.ok) throw new Error(json.error || "Could not load the shared space.");
      setData(json); setError("");
      if (json.selected?.thread_id) setThreadId(json.selected.thread_id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the shared space."); }
    finally { setLoading(false); setRefreshing(false); }
  }, [threadId]);
  useEffect(() => { void load("", false); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(threadId, true); }, 30000);
    return () => window.clearInterval(timer);
  }, [load, threadId]);

  const active = data?.threads.filter((item) => item.status !== "settled") ?? [];
  const archives = data?.threads.filter((item) => item.status === "settled") ?? [];
  const understanding = data?.understanding as Record<string, unknown> | null;
  const groups = useMemo(() => [
    { key: "common_points", title: "Where you meet", accent: "sage" },
    { key: "differences", title: "Where it feels different", accent: "clay" },
    { key: "hypotheses", title: "Questions to keep open", accent: "gold" },
  ].map((group) => ({ ...group, items: Array.isArray(understanding?.[group.key]) ? understanding?.[group.key] as Record<string, unknown>[] : [] })), [understanding]);

  return <main className="min-h-screen bg-[#f7f6f1] text-[#25332f]">
    <header className="sticky top-0 z-10 flex h-[68px] items-center justify-between border-b border-[#e4e5dc] bg-[#fbfaf6]/95 px-5 backdrop-blur md:px-9">
      <a className="flex items-center gap-3" href="#home" onClick={() => setSection("consultation")}><span className="grid h-9 w-9 place-items-center rounded-full bg-[#e5ece2] text-[#536a57]">✳</span><span><strong className="block text-[15px] tracking-tight">Between Us</strong><span className="text-[11px] text-[#7b8278]">A shared space for understanding</span></span></a>
      <div className="flex items-center gap-3"><span className="hidden rounded-full border border-[#e5e5dc] bg-white px-3 py-1.5 text-xs text-[#727b70] sm:inline">Private · shared with your space</span><button onClick={() => void load(threadId, true)} className="rounded-full border border-[#dfe2d7] px-3 py-2 text-xs hover:bg-white">{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    </header>
    <div className="mx-auto grid max-w-[1500px] gap-0 lg:grid-cols-[220px_minmax(0,1fr)_320px]">
      <aside className="border-b border-[#e4e5dc] p-4 lg:min-h-[calc(100vh-68px)] lg:border-b-0 lg:border-r lg:p-6">
        <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-[#91968b]">Your space</p>
        <nav className="grid grid-cols-3 gap-1 lg:grid-cols-1">
          {([ ["consultation", "Current conversations", "◷"], ["principles", "Shared understanding", "◇"], ["archives", "Past conversations", "⌁"] ] as const).map(([id, name, icon]) => <button key={id} onClick={() => setSection(id)} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] ${section === id ? "bg-[#e9eee5] font-medium text-[#405847]" : "text-[#71796f] hover:bg-white"}`}><span className="text-base">{icon}</span><span className="hidden sm:inline lg:inline">{name}</span></button>)}
        </nav>
        {section !== "principles" && <><p className="mb-3 mt-8 hidden px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-[#91968b] lg:block">{section === "archives" ? "Settled" : "In progress"}</p><div className="hidden space-y-1 lg:block">{(section === "archives" ? archives : active).map((thread) => <button key={thread.thread_id} onClick={() => { setThreadId(thread.thread_id); setSection(section === "archives" ? "archives" : "consultation"); void load(thread.thread_id); }} className={`w-full rounded-xl px-3 py-3 text-left ${thread.thread_id === threadId ? "bg-white shadow-sm" : "hover:bg-white/70"}`}><span className="block truncate text-[13px] font-medium">{thread.title}</span><span className="mt-1 block text-[11px] text-[#899087]">{statusName(thread.status)}</span></button>)}</div></>}
        <div className="mt-8 hidden rounded-2xl bg-[#edf0e9] p-4 lg:block"><span className="text-lg">☼</span><p className="mt-2 text-[12px] font-medium">A gentle reminder</p><p className="mt-1 text-[11px] leading-relaxed text-[#788074]">This space helps you notice what you are learning together, at your own pace.</p></div>
      </aside>
      <section className="min-w-0 px-5 py-7 md:px-10 md:py-10">
        {error && <div role="alert" className="mb-5 flex items-center justify-between rounded-xl border border-[#ebd4c9] bg-[#fff8f4] p-4 text-sm text-[#815340]"><span>{error}</span><button onClick={() => void load(threadId)} className="font-medium underline">Try again</button></div>}
        {loading && !data ? <div className="py-24 text-center text-sm text-[#7c8479]">Opening your shared space…</div> : section === "principles" ? <>
          <p className="text-xs font-medium uppercase tracking-[.15em] text-[#90968b]">A shared space to return to</p><h1 className="mt-2 font-serif text-3xl text-[#34423a] md:text-4xl">Shared understanding</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#768076]">These are the principles and conclusions you have formally confirmed together.</p>
          <div className="mt-8 space-y-3">{data?.agreements.map((item) => <article key={item.agreement_id} className="rounded-2xl border border-[#e7e7dd] bg-white p-5 md:p-6"><p className="mb-3 text-[10px] font-semibold uppercase tracking-[.14em] text-[#788a73]">{item.thread_id ? "Conversation conclusion" : "Shared principle"}</p><p className="whitespace-pre-wrap break-words font-serif text-lg leading-7">{item.text}</p><p className="mt-4 text-[11px] text-[#92988e]">Confirmed version {item.version}</p></article>)}{!data?.agreements.length && <Empty />}</div>
        </> : section === "archives" ? <><p className="text-xs font-medium uppercase tracking-[.15em] text-[#90968b]">Past conversations</p><h1 className="mt-2 font-serif text-3xl text-[#34423a] md:text-4xl">A record of what you’ve worked through</h1><div className="mt-8 space-y-3">{archives.map((item) => <article key={item.thread_id} className="rounded-2xl border border-[#e7e7dd] bg-white p-5"><button className="text-left" onClick={() => { setThreadId(item.thread_id); void load(item.thread_id); }}><span className="block font-serif text-xl">{item.title}</span><span className="mt-1 block text-xs text-[#838b80]">Settled · {item.summary}</span></button><div className="mt-4 flex gap-2"><a className="rounded-full bg-[#edf1e9] px-3 py-2 text-xs font-medium text-[#536b54]" href={`/api/archives/${encodeURIComponent(item.thread_id)}?format=md`}>Download Markdown</a><a className="rounded-full border border-[#e5e6dd] px-3 py-2 text-xs text-[#697368]" href={`/api/archives/${encodeURIComponent(item.thread_id)}?format=jsonl`}>Download JSONL</a></div></article>)}{!archives.length && <Empty />}</div></> : <>
          <p className="text-xs font-medium uppercase tracking-[.15em] text-[#90968b]">A conversation in progress</p><h1 className="mt-2 font-serif text-3xl leading-tight text-[#34423a] md:text-4xl">{data?.selected?.title ?? "Make room for both of you"}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#768076]">{data?.selected?.summary ?? "A quiet place to read what has been shared and notice what may be becoming clearer."}</p>
          <div className="mt-7 flex items-center justify-between border-b border-[#e5e5dc] pb-3"><span className="text-xs text-[#838a80]">{data?.selected ? statusName(data.selected.status) : "Waiting for your first conversation"}</span><span className="text-[11px] text-[#999e95]">{data?.refreshed_at ? `Updated ${date(data.refreshed_at)}` : ""}{error && data ? " · showing last saved view" : ""}</span></div>
          {data?.has_earlier && <p className="my-4 rounded-lg bg-[#ecefe8] px-4 py-3 text-xs text-[#687667]">Earlier messages are available in the complete archive download.</p>}
          <div className="space-y-5 py-5">{data?.messages.map((message) => { const content = bodyText(message.body); const member = message.kind === "user_message"; return <article id={message.message_id} key={message.message_id} className={`rounded-2xl border p-5 md:p-6 ${member ? "border-[#e7e3d8] bg-white" : "border-[#e0e8de] bg-[#f0f4ed]"}`}><div className="mb-3 flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-[.12em] text-[#758174]">{member ? (message.actor_id === data?.viewer_id ? "Your expression" : data?.members.find((person) => person.user_id === message.actor_id)?.role ?? "Partner expression") : message.kind === "assistant_message" ? "Therapist response" : message.kind.replaceAll("_", " ")}</span><time className="text-[11px] text-[#a0a49c]">{date(message.created_at)}</time></div>{content !== null ? <p className="whitespace-pre-wrap break-words font-serif text-[16px] leading-7 text-[#3a443d]">{content}</p> : <details><summary className="cursor-pointer text-sm text-[#687667]">Structured record</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(message.body, null, 2)}</pre></details>}</article>; })}{!data?.messages.length && <Empty />}</div>
        </>}
      </section>
      {section !== "archives" && <aside className="border-t border-[#e4e5dc] bg-[#f3f3ed] px-5 py-7 md:px-8 lg:min-h-[calc(100vh-68px)] lg:border-l lg:border-t-0 lg:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#8c9388]">A reflection, not a verdict</p><h2 className="mt-2 font-serif text-2xl text-[#3a4940]">What’s taking shape</h2>
        {understanding && !("unsupported" in understanding) ? <div className="mt-5 space-y-5">{groups.map((group) => <section key={group.key}><h3 className="mb-2 text-xs font-semibold text-[#5b6a5b]">{group.title}</h3>{group.items.map((item, index) => { const txt = typeof item.text === "string" ? item.text : ""; const sourceIds = Array.isArray(item.source_message_ids) ? item.source_message_ids.filter((id): id is string => typeof id === "string") : []; const valid = sourceIds.filter((id) => data?.messages.some((m) => m.message_id === id)); return <article key={`${group.key}-${index}`} className="mb-2 rounded-xl border border-[#e5e6dc] bg-white/85 p-3.5"><p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-[#596259]">{txt}</p>{valid.length > 0 && <p className="mt-2 text-[10px] text-[#92998f]">From {valid.map((id) => <a key={id} className="mr-2 underline" href={`#${id}`}>{id.slice(0, 8)}</a>)}</p>}</article>; })}{!group.items.length && <p className="text-xs text-[#989e94]">Nothing recorded here yet.</p>}</section>)}</div> : <div className="mt-5 rounded-xl border border-[#e4e5dc] bg-white/80 p-4 text-xs leading-5 text-[#7e867b]">{understanding ? "The latest shared reflection is preserved in the full archive." : "Shared reflections will appear here when they have been recorded."}</div>}
        <div className="mt-6"><h3 className="mb-2 text-xs font-semibold text-[#5b6a5b]">Confirmed agreements</h3>{(data?.agreements ?? []).filter((item) => !item.thread_id || item.thread_id === data?.selected?.thread_id).map((item) => <article key={item.agreement_id} className="mb-2 rounded-xl border border-[#dfe7da] bg-[#eaf0e6] p-3.5"><p className="mb-1 text-[9px] font-semibold uppercase tracking-[.13em] text-[#788a73]">{item.thread_id ? "For this conversation" : "Shared principle"}</p><p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-[#536352]">{item.text}</p></article>)}</div>
        <p className="mt-6 border-t border-[#e0e2d9] pt-4 text-[10px] leading-4 text-[#969c91]">This page reflects what has been recorded. Only confirmed agreements are shown as settled.</p>
      </aside>}
    </div>
  </main>;
}
function Empty() { return <div className="rounded-2xl border border-dashed border-[#dfe2d7] bg-white/50 px-6 py-12 text-center"><span className="text-2xl text-[#a2ac9a]">✳</span><p className="mt-3 font-serif text-xl text-[#4c5d50]">Nothing here just yet</p><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#879085]">When either of you starts a consultation through your own Codex, shared messages and understanding will appear here.</p></div>; }
