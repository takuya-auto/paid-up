// Workers AI wrapper with a hard daily cap.
//
// The cap is a per-UTC-day counter kept in KV (binding CAP_KV). If KV is not
// bound, an in-memory counter is used (per isolate, best effort). When the cap
// is reached, `available()` returns false and the agent degrades to its
// deterministic plan + templated explanations. Nothing in the product breaks
// without the LLM; it just gets less chatty.

const memoryCounter = new Map(); // day -> count (fallback only)

export function createLLM(env, { now = () => new Date() } = {}) {
  const mode = (env.LLM_MODE || 'auto').toLowerCase();
  const model = env.LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const cap = Math.max(0, Number(env.LLM_DAILY_CAP ?? 150) || 0);
  const ai = env.AI;
  const kv = env.CAP_KV;
  const perRequestCap = Math.max(1, Number(env.LLM_PER_REQUEST_CAP ?? 12) || 12);
  let usedThisRequest = 0;
  let lastReason = null;

  const dayKey = () => `llm-calls:${now().toISOString().slice(0, 10)}`;

  async function readCount() {
    const key = dayKey();
    if (kv) {
      try {
        const v = await kv.get(key);
        return Number(v) || 0;
      } catch (e) {
        lastReason = `kv read failed: ${e.message}`;
      }
    }
    return memoryCounter.get(key) || 0;
  }

  async function bump() {
    const key = dayKey();
    const n = (await readCount()) + 1;
    if (kv) {
      try {
        await kv.put(key, String(n), { expirationTtl: 60 * 60 * 48 });
        return n;
      } catch (e) {
        lastReason = `kv write failed: ${e.message}`;
      }
    }
    memoryCounter.set(key, n);
    return n;
  }

  async function available() {
    if (mode === 'off') { lastReason = 'LLM_MODE=off'; return false; }
    if (!ai) { lastReason = 'no AI binding'; return false; }
    if (usedThisRequest >= perRequestCap) { lastReason = 'per-request cap reached'; return false; }
    const used = await readCount();
    if (used >= cap) { lastReason = `daily cap ${cap} reached`; return false; }
    return true;
  }

  /**
   * One chat completion. Returns { text, toolCalls:[{name, arguments}], raw }.
   * Throws if the LLM is unavailable or the call fails; callers must catch.
   */
  async function chat(messages, { tools, maxTokens = 700, temperature = 0.2 } = {}) {
    if (!(await available())) throw new Error(`LLM unavailable: ${lastReason}`);
    usedThisRequest++;
    await bump();
    const input = { messages, max_tokens: maxTokens, temperature };
    if (tools && tools.length) input.tools = tools;
    const raw = await ai.run(model, input);
    return normalize(raw);
  }

  async function status() {
    const used = await readCount();
    return { mode, model, cap, usedToday: used, remaining: Math.max(0, cap - used), bound: !!ai, kv: !!kv, lastReason };
  }

  return { chat, available, status, model, get lastReason() { return lastReason; } };
}

/** Normalize the various shapes Workers AI models return. */
export function normalize(raw) {
  if (raw == null) return { text: '', toolCalls: [], raw };
  if (typeof raw === 'string') return { text: raw, toolCalls: [], raw };
  // OpenAI-compatible shape
  if (Array.isArray(raw.choices) && raw.choices[0]?.message) {
    const msg = raw.choices[0].message;
    return { text: msg.content || '', toolCalls: parseToolCalls(msg.tool_calls), raw };
  }
  return { text: raw.response || raw.result?.response || '', toolCalls: parseToolCalls(raw.tool_calls), raw };
}

function parseToolCalls(list) {
  if (!Array.isArray(list)) return [];
  return list.map((tc) => {
    const fn = tc.function || tc;
    let args = fn.arguments ?? tc.arguments ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return { id: tc.id, name: fn.name || tc.name, arguments: args || {} };
  }).filter((tc) => tc.name);
}

/** Extract the first JSON object from model text (models often wrap it in prose/fences). */
export function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}
