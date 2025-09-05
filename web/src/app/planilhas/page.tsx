"use client";

import React, { useEffect, useRef, useState } from "react";

type UploadSlot = { file?: File | null; alias: string; sheet?: string };

type RunSummary = {
  detected_action: string;
  destination: string;
  source: string;
  key: string;
  added_columns: string[];
  fill_missing: string | null;
  rows_total: number;
  rows_unmatched: number;
  sort_order?: "asc" | "desc";
};

type RunResponse = {
  session_id: string;
  summary: RunSummary;
  artifacts: { result_url: string; unmatched_url?: string | null; log_url?: string | null };
};

type ChatMessage =
  | { role: "user"; text: string; when: string }
  | { role: "assistant"; summary: RunSummary; artifacts: RunResponse["artifacts"]; when: string };

const API = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
const ALLOWED_EXTS = [".csv", ".xlsx"];

// -------- helpers --------
function summarize(s: RunSummary) {
  if (s.detected_action === "SORT") {
    const order = s.sort_order === "desc" ? "decrescente" : "crescente";
    return `Planilha "${s.destination}" ordenada por "${s.key}" em ordem ${order}. Total de linhas: ${s.rows_total}.`;
  }
  const cols = s.added_columns?.length ? s.added_columns.join(", ") : "colunas selecionadas";
  const fill = s.fill_missing ? ` Ausentes preenchidos com "${s.fill_missing}".` : "";
  const unmatched = ` Sem correspondência: ${s.rows_unmatched}.`;
  return `Mesclagem concluída: colunas ${cols} copiadas de "${s.source}" para "${s.destination}" usando a chave "${s.key}". Total de linhas: ${s.rows_total}.${unmatched}${fill}`;
}

function useLocalStore<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : initial;
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);
  return [state, setState] as const;
}

type ToastT = { id: number; text: string };
function useToasts() {
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const push = (text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };
  return { toasts, push };
}

// -------- page --------
export default function PlanilhasIA() {
  // efêmero
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  useEffect(() => {
    setSessionId(crypto.randomUUID().replace(/-/g, ""));
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("planilhas.chat."))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
  }, []);

  // ui
  const [slots, setSlots] = useLocalStore<UploadSlot[]>("planilhas.slots", [
    { alias: "usuarios_id" },
    { alias: "usuarios_cpf" },
  ]);
  const [totalSlots, setTotalSlots] = useLocalStore<number>("planilhas.totalSlots", 2);
  const [autoDownload, setAutoDownload] = useLocalStore<boolean>("planilhas.autoDownload", true);
  const [prompt, setPrompt] = useLocalStore<string>(
    "planilhas.prompt",
    'Leia as duas planilhas; pegue os CPFs da usuarios_cpf e adicione na usuarios_id pelos respectivos nomes. Caso algum usuário de usuarios_id não tenha correspondência, preencha o CPF com "SEM CPF".'
  );

  useEffect(() => {
    const clamped = Math.min(5, Math.max(1, totalSlots || 1));
    if (slots.length < clamped) {
      setSlots((prev) => [...prev, ...Array(clamped - prev.length).fill({ alias: "" })]);
    } else if (slots.length > clamped) {
      setSlots((prev) => prev.slice(0, clamped));
    }
  }, [totalSlots, slots.length, setSlots]);

  const [loading, setLoading] = useState(false);
  const { toasts, push } = useToasts();
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages, loading]);

  const updateSlot = (i: number, patch: Partial<UploadSlot>) =>
    setSlots((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const isAllowed = (file?: File | null) => file && ALLOWED_EXTS.some((ext) => file.name.toLowerCase().endsWith(ext));

  const handlePick = (i: number, f?: File | null) => {
    if (!f) return updateSlot(i, { file: null });
    if (!isAllowed(f)) {
      push(`Tipo não suportado (${f.name.split(".").pop() || "desconhecido"}). Use CSV ou XLSX.`);
      return;
    }
    updateSlot(i, { file: f });
  };

  const downloadBlob = (res: Response, blob: Blob) => {
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename="?([^"]+)"?/i);
    const filename =
      m?.[1] ||
      (res.headers.get("content-type")?.includes("csv") ? "planilhanova.csv" : "planilhanova.xlsx");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleSubmit = async () => {
    const used = slots.filter((s) => s.file);
    if (used.length < 1) {
      push("Envie pelo menos 1 arquivo (CSV/XLSX).");
      return;
    }

    // captura o prompt atual e limpa o campo imediatamente
    const currentPrompt = prompt;
    setPrompt(""); // <- LIMPA o campo de digitação sempre que envia

    setLoading(true);
    try {
      setMessages((prev) => [...prev, { role: "user", text: currentPrompt, when: new Date().toISOString() }]);

      const form = new FormData();
      const aliases: Record<string, string> = {};
      const sheets: Record<string, string> = {};
      used.forEach((s, idx) => {
        form.append(`file${idx + 1}`, s.file!);
        aliases[`file${idx + 1}`] = s.alias?.trim() || `planilha_${idx + 1}`;
        if (s.sheet) sheets[`file${idx + 1}`] = s.sheet;
      });
      form.append("aliases", JSON.stringify(aliases));
      if (Object.keys(sheets).length) form.append("sheets", JSON.stringify(sheets));
      form.append("prompt", currentPrompt);
      form.append("session_id", sessionId);
      form.append("download", autoDownload ? "1" : "0");
      form.append("out_format", "xlsx");

      const res = await fetch(`${API}/process`, { method: "POST", body: form });

      if (!res.ok) {
        let detail = "Erro ao processar.";
        try {
          const j = await res.json();
          detail = j?.detail || detail;
        } catch {}
        push(detail);
        return;
      }

      const ctype = res.headers.get("content-type") || "";

      // (A) arquivo direto
      if (
        ctype.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") ||
        ctype.includes("text/csv")
      ) {
        const summaryHeader = res.headers.get("X-Run-Summary");
        const summary: RunSummary | null = summaryHeader ? JSON.parse(summaryHeader) : null;
        const blob = await res.blob();
        downloadBlob(res, blob);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            summary:
              summary || {
                detected_action: "PROCESS",
                destination: "(arquivo gerado)",
                source: "",
                key: "",
                added_columns: [],
                fill_missing: null,
                rows_total: 0,
                rows_unmatched: 0,
              },
            artifacts: { result_url: "", unmatched_url: "", log_url: "" },
            when: new Date().toISOString(),
          },
        ]);
        return;
      }

      // (B) json
      const data = (await res.json()) as RunResponse;
      if (data?.session_id && data.session_id !== sessionId) setSessionId(data.session_id);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          summary: data.summary,
          artifacts: data.artifacts,
          when: new Date().toISOString(),
        },
      ]);
    } catch (e: unknown) {
      if (e instanceof Error) push(e.message);
      else push("Erro desconhecido ao processar.");
    } finally {
      setLoading(false);
    }
  };

  const newChat = () => {
    setSessionId(crypto.randomUUID().replace(/-/g, ""));
    setMessages([]);
  };

  // -------- UI --------
  return (
    <div className="min-h-screen bg-black text-white">
      {/* Topbar */}
      <div className="border-b border-white/10 bg-black">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            <span className="text-[#0dcba9]">IA</span> de Planilhas
          </h1>
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-[#0dcba9] w-4 h-4"
                checked={autoDownload}
                onChange={(e) => setAutoDownload(e.target.checked)}
              />
              <span className="hidden sm:inline">Baixar automaticamente</span>
              <span className="sm:hidden">Auto</span>
            </label>
            <button
              onClick={newChat}
              className="rounded-xl bg-[#0dcba9] text-black px-3 py-1.5 font-medium shadow hover:brightness-95 transition cursor-pointer hover:opacity-80"
            >
              Nova conversa
            </button>
          </div>
        </div>
      </div>

      {/* Toasts */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-black/90 text-white rounded-xl px-4 py-2 shadow-lg ring-1 ring-[#0dcba9]/40"
            role="status"
          >
            {t.text}
          </div>
        ))}
      </div>

      {/* Main */}
      <div className="mx-auto max-w-6xl p-6 space-y-8">
        {/* Quantidade */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium">Quantidade de campos de arquivo</label>
          <select
            value={totalSlots}
            onChange={(e) => setTotalSlots(parseInt(e.target.value, 10))}
            className="rounded-xl border border-white/20 bg-black px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0dcba9]"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="text-xs text-white/60">
            Máximo 5. (Mínimo 1 arquivo.)
          </span>
        </div>

        {/* Uploads */}
        <section className="grid gap-4">
          {slots.map((slot, i) => (
            <div
              key={i}
              className="rounded-2xl border border-white/50 p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id={`file-${i}`}
                  type="file"
                  accept=".csv,.xlsx"
                  className="hidden"
                  onChange={(e) => handlePick(i, e.target.files?.[0] || null)}
                />
                <label
                  htmlFor={`file-${i}`}
                  className="cursor-pointer rounded-xl border border-white bg-black px-3 py-2 text-sm font-medium hover:border-black hover:text-black hover:bg-white transition text-white"
                >
                  {slot.file ? `Selecionado: ${slot.file.name}` : "Escolher arquivo"}
                </label>

                <input
                  type="text"
                  placeholder="apelido (ex.: usuarios_id)"
                  value={slot.alias}
                  onChange={(e) => updateSlot(i, { alias: e.target.value })}
                  className="rounded-xl border border-white bg-black px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 text-white"
                />
              </div>
              <small className="mt-2 block text-black/70">
                Tipos suportados: <b>CSV/XLSX</b>. Use o <b>apelido</b> no prompt (ex.:{" "}
                <i>usuarios_id, usuarios_cpf</i>).
              </small>
            </div>
          ))}
        </section>

        {/* Chat */}
        <section className="rounded-2xl border border-white/10 bg-black p-4 shadow-sm">
          <div className="space-y-4 max-h-[50vh] overflow-auto pr-2">
            {messages.map((m, idx) =>
              m.role === "user" ? (
                <div key={idx} className="flex justify-end">
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[#0dcba9] px-4 py-2 text-black shadow">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={idx} className="flex justify-start">
                  <div className="max-w-[80%] rounded-2xl border border-white/10 bg-white px-4 py-3 shadow-sm text-black">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#0dcba9]" />
                      <span className="font-semibold">Feito</span>
                    </div>
                    <p className="text-sm text-black/80 whitespace-pre-wrap">
                      {summarize(m.summary)}
                    </p>
                    <div className="mt-2 flex gap-4 text-sm">
                      {m.artifacts.result_url && (
                        <a
                          className="text-black font-bold underline hover:opacity-80"
                          href={`${API}${m.artifacts.result_url}`}
                          target="_blank"
                        >
                          Baixar resultado
                        </a>
                      )}
                      {m.artifacts.unmatched_url && (
                        <a
                          className="text-[#0dcba9] underline hover:opacity-80"
                          href={`${API}${m.artifacts.unmatched_url}`}
                          target="_blank"
                        >
                          Baixar sem correspondência
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )
            )}
            <div ref={endRef} />
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <textarea
              className="min-h-[100px] rounded-2xl border border-white/20 bg-black p-4 text-sm text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0dcba9]"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Digite sua instrução… (ex.: Ordene a planilha usuarios_id por nome de A a Z)"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="rounded-xl bg-white text-black px-5 py-2 font-medium shadow hover:opacity-80 disabled:opacity-50 transition cursor-pointer"
              >
                {loading ? "Processando..." : "Enviar"}
              </button>
              <span className="text-xs text-white/60">
                Sessão: <span className="text-[#0dcba9]">{sessionId.slice(0, 8)}…</span>
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
