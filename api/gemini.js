// ===== GEMINI =====
// Model ưu tiên: Gemini
const PRIMARY_MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

// Model Gemini thứ 2 (nhanh, quota tính RIÊNG): dùng khi model chính hết lượt.
// Đổi tên bằng biến môi trường GEMINI_MODEL_2 trên Vercel nếu muốn model khác.
const SECOND_MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/' +
  (process.env.GEMINI_MODEL_2 || 'gemini-2.5-flash-lite') +
  ':generateContent';

// ===== GROQ =====
// Chỉ dùng khi TOÀN BỘ key của 2 model Gemini đều lỗi
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b'
];

// ===== GEMMA (dự phòng cuối cùng) =====
// Chỉ dùng khi Gemini và Groq đều lỗi
const FALLBACK_MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent';

// Client (index.html) tự hủy request sau 8 giây, nên server phải trả lời trước mốc đó.
const TOTAL_BUDGET_MS = 7500;

// Đọc key Gemini từ biến môi trường: GEMINI_API_KEY_1 ... GEMINI_API_KEY_7
// (vẫn nhận GEMINI_API_KEY cũ nếu chưa đổi tên).
const MAX_KEYS = 7;

function loadKeys() {
  const keys = [];
  const single = process.env.GEMINI_API_KEY;
  if (single && single.trim()) keys.push(single.trim());
  for (let i = 1; i <= MAX_KEYS; i++) {
    const k = process.env['GEMINI_API_KEY_' + i];
    if (k && k.trim()) keys.push(k.trim());
  }
  return [...new Set(keys)];
}

// Đọc key Groq từ biến môi trường: GROQ_API_KEY_1 ... GROQ_API_KEY_5
function loadGroqKeys() {
  const keys = [];
  const single = process.env.GROQ_API_KEY;
  if (single && single.trim()) keys.push(single.trim());
  for (let i = 1; i <= 5; i++) {
    const k = process.env['GROQ_API_KEY_' + i];
    if (k && k.trim()) keys.push(k.trim());
  }
  return [...new Set(keys)];
}

const KEYS = loadKeys();
const GROQ_KEYS = loadGroqKeys();
console.log(`Gemini: đã nạp ${KEYS.length} API key`);
console.log(`Groq: đã nạp ${GROQ_KEYS.length} API key`);
console.log(`[GEMINI CONFIG] primary=${PRIMARY_MODEL_URL} second=${SECOND_MODEL_URL} fallback=${FALLBACK_MODEL_URL} keys=${KEYS.length}`);

// Trạng thái lưu trong bộ nhớ của instance đang chạy (best-effort trên serverless)
// Mỗi model Gemini có con trỏ xoay vòng và bảng cooldown riêng (quota tính riêng theo model).
const state = {
  [PRIMARY_MODEL_URL]: { cursor: 0, cooldownUntil: new Array(KEYS.length).fill(0) },
  [SECOND_MODEL_URL]: { cursor: 0, cooldownUntil: new Array(KEYS.length).fill(0) },
  [FALLBACK_MODEL_URL]: { cursor: 0, cooldownUntil: new Array(KEYS.length).fill(0) }
};

// Lỗi nào thì đổi sang key khác
function shouldRotate(status, data) {
  if (status === 429 || status === 401 || status === 403 || status >= 500) return true;
  if (status === 400) {
    // 400 do key sai thì đổi key, 400 do request sai thì trả về luôn
    return /api key/i.test(String(data?.error?.message || ''));
  }
  return false;
}

// Khi TẤT CẢ key Gemini đều 429 (hết quota ngày), tạm bỏ qua Gemini 30 phút.
const PRIMARY_SKIP_MS = 30 * 60 * 1000;
let primarySkipUntil = 0;
let secondSkipUntil = 0;

function cooldownFor(status) {
  if (status === 429) return 60 * 1000; // hết lượt/phút
  if (status === 400 || status === 401 || status === 403) return 5 * 60 * 1000; // key hỏng
  return 5 * 1000; // lỗi tạm thời
}

// Bỏ các phần "suy nghĩ" (thought) của model để client không hiện phân tích nội bộ.
function stripThoughts(data) {
  try {
    for (const c of data?.candidates || []) {
      if (Array.isArray(c?.content?.parts)) {
        c.content.parts = c.content.parts.filter((p) => !p?.thought);
        if (!c.content.parts.some((p) => p?.text)) {
          console.warn('Model trả về rỗng. finishReason=' + c.finishReason + ' usage=' + JSON.stringify(data?.usageMetadata || {}));
        }
      }
    }
  } catch {}
  return data;
}

// Gemma hay viết phân tích tiếng Anh trước khi trả lời -> dặn thêm vào system prompt.
const NO_ANALYSIS =
  'QUAN TRỌNG: Chỉ viết đúng câu trả lời cuối cùng bằng tiếng Việt. Tuyệt đối không phân tích, không liệt kê gạch đầu dòng, không viết tiếng Anh, không nhắc lại vai/bối cảnh/yêu cầu.';

let gemmaThinkRejected = false; // nhớ nếu Gemma không nhận lệnh tắt suy nghĩ

function forFallback(body, noThink) {
  const b = JSON.parse(JSON.stringify(body || {}));
  const parts = b.systemInstruction?.parts;
  if (Array.isArray(parts)) parts.push({ text: NO_ANALYSIS });
  else b.systemInstruction = { parts: [{ text: NO_ANALYSIS }] };
  // Gemma "nghĩ" trước khi trả lời và phần nghĩ cũng tốn token. Nới trần để còn chỗ cho câu trả lời.
  const gc = (b.generationConfig = b.generationConfig || {});
  const orig = gc.maxOutputTokens || 180;
  if (noThink) {
    gc.thinkingConfig = { thinkingBudget: 0 };
    gc.maxOutputTokens = Math.max(orig * 2, 360);
  } else {
    gc.maxOutputTokens = Math.min(1500, Math.max(900, orig * 4));
  }
  return b;
}

// Đổi request dạng Gemini sang dạng OpenAI (Groq dùng dạng này)
function geminiToGroq(body, model) {
  const messages = [];
  const sys = (body.systemInstruction?.parts || [])
    .map((p) => p?.text || '')
    .join('\n')
    .trim();
  if (sys) messages.push({ role: 'system', content: sys });

  for (const c of body.contents || []) {
    const text = (c.parts || [])
      .filter((p) => !p?.thought)
      .map((p) => p?.text || '')
      .join('');
    messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: text });
  }

  const gc = body.generationConfig || {};
  return {
    model,
    messages,
    max_tokens: gc.maxOutputTokens || 1024,
    temperature: gc.temperature ?? 0.7
  };
}

// Đổi kết quả Groq về dạng Gemini để client (index.html) không phải sửa gì
function groqToGemini(data) {
  const choice = data?.choices?.[0];
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: choice?.message?.content || '' }] },
        finishReason: choice?.finish_reason || 'STOP'
      }
    ]
  };
}

// Xoay vòng qua toàn bộ key của MỘT model Gemini.
// Trả về:
//   { done: true, status, data }                        -> có kết quả để trả cho client
//   { done: false, lastStatus, lastData, saw429, n429 } -> tất cả key của model này đều lỗi
async function tryModel(modelUrl, raw, start) {
  const n = KEYS.length;
  const st = state[modelUrl];

  // Xoay vòng: mỗi request bắt đầu từ key tiếp theo
  const first = st.cursor % n;
  st.cursor = (st.cursor + 1) % n;

  const order = [];
  for (let j = 0; j < n; j++) order.push((first + j) % n);

  // Ưu tiên key đang khỏe, key đang nghỉ thì thử sau cùng
  const now = Date.now();
  const ready = order.filter((i) => st.cooldownUntil[i] <= now);
  const cooling = order.filter((i) => st.cooldownUntil[i] > now);
  const tryOrder = [...ready, ...cooling];

  let lastStatus = 502;
  let lastData = { error: { message: 'Không thể kết nối Gemini.' } };
  let saw429 = false;
  let n429 = 0;

  for (const i of tryOrder) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - start);
    if (remaining < 300) break;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), remaining);

    try {
      const response = await fetch(modelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': KEYS[i]
        },
        body: raw,
        signal: ctl.signal
      });

      const text = await response.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: { message: text || 'Gemini trả về dữ liệu không hợp lệ.' } };
      }

      if (response.ok || !shouldRotate(response.status, data)) {
        return { done: true, status: response.status, data: stripThoughts(data) };
      }

      // DEBUG: ghi nguyên nhân lỗi nhưng KHÔNG ghi API key
      const retryAfter = response.headers.get('retry-after');
      const quotaProject = data?.error?.details?.find?.(
        (d) => d?.['@type']?.includes?.('QuotaFailure')
      );
      const quotaViolations = quotaProject?.violations || [];
      const errorInfo = data?.error?.details?.find?.(
        (d) => d?.['@type']?.includes?.('ErrorInfo')
      );
      const debugInfo = {
        key: `#${i + 1}/${n}`,
        httpStatus: response.status,
        status: data?.error?.status || null,
        message: data?.error?.message || null,
        retryAfter: retryAfter || null,
        errorInfo: errorInfo || null,
        quotaViolations: quotaViolations,
        details: data?.error?.details || [],
        model: modelUrl
      };

      console.error('[GEMINI DEBUG]', JSON.stringify(debugInfo, null, 2));

      if (response.status === 429) { saw429 = true; n429++; }
      st.cooldownUntil[i] = Date.now() + cooldownFor(response.status);
      lastStatus = response.status;
      lastData = data;

      console.warn(
        `Gemini key #${i + 1}/${n} lỗi HTTP ${response.status}. ` +
        `status=${data?.error?.status || 'unknown'} ` +
        `retryAfter=${retryAfter || 'none'} ` +
        `message=${data?.error?.message || 'unknown'}`
      );
    } catch (error) {
      st.cooldownUntil[i] = Date.now() + cooldownFor(500);
      lastStatus = error?.name === 'AbortError' ? 504 : 500;
      lastData = {
        error: {
          message: 'Không thể kết nối Gemini.',
          detail: String(error?.message || error)
        }
      };
      console.warn(`Gemini key #${i + 1}/${n} lỗi kết nối: ${String(error?.message || error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { done: false, lastStatus, lastData, saw429, n429 };
}

// Thử Groq: xoay qua các key, đổi model khi model đó lỗi
async function tryGroq(body, start) {
  let lastStatus = 502;
  let lastData = { error: { message: 'Không thể kết nối Groq.' } };

  if (!GROQ_KEYS.length) {
    return { done: false, lastStatus, lastData };
  }

  for (const model of GROQ_MODELS) {
    for (let i = 0; i < GROQ_KEYS.length; i++) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - start);
      if (remaining < 300) return { done: false, lastStatus, lastData };

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), remaining);
      try {
        const response = await fetch(GROQ_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + GROQ_KEYS[i]
          },
          body: JSON.stringify(geminiToGroq(body, model)),
          signal: ctl.signal
        });

        const data = await response.json().catch(() => ({}));

        if (response.ok) {
          return { done: true, status: 200, data: groqToGemini(data) };
        }

        lastStatus = response.status;
        lastData = { error: { message: data?.error?.message || 'Groq lỗi.' } };
        console.warn(`Groq ${model} key #${i + 1}/${GROQ_KEYS.length} lỗi HTTP ${response.status}: ${lastData.error.message}`);

        // 400/404 là lỗi do request hoặc model không tồn tại -> bỏ model này, thử model kế tiếp
        if (response.status === 400 || response.status === 404) break;
      } catch (error) {
        lastStatus = error?.name === 'AbortError' ? 504 : 500;
        lastData = {
          error: {
            message: 'Không thể kết nối Groq.',
            detail: String(error?.message || error)
          }
        };
        console.warn(`Groq ${model} key #${i + 1} lỗi kết nối: ${String(error?.message || error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return { done: false, lastStatus, lastData };
}

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  if (!KEYS.length && !GROQ_KEYS.length) {
    return res.status(500).json({
      error: {
        message: 'Chưa cấu hình GEMINI_API_KEY_1 ... GEMINI_API_KEY_7 hoặc GROQ_API_KEY_1 trên Vercel.'
      }
    });
  }

  try {
    const body = req.body || {};
    const raw = JSON.stringify(body);

    if (raw.length > 120000) {
      return res.status(413).json({ error: { message: 'Request quá lớn.' } });
    }

    const start = Date.now();

    // Bước 1: Gemini chính, xoay qua 7 key
    let primary = { done: false, saw429: false, n429: 0 };
    if (KEYS.length && Date.now() >= primarySkipUntil) {
      primary = await tryModel(PRIMARY_MODEL_URL, raw, start);
      if (primary.done) {
        primarySkipUntil = 0;
        return res.status(primary.status).json(primary.data);
      }
      if (primary.n429 >= KEYS.length) {
        primarySkipUntil = Date.now() + PRIMARY_SKIP_MS;
        console.warn('Cả ' + KEYS.length + ' key Gemini chính đều hết quota, bỏ qua 30 phút.');
      }
    }

    // Bước 2: Gemini thứ 2, xoay qua 7 key
    let second = { done: false, saw429: false, n429: 0 };
    if (KEYS.length && Date.now() >= secondSkipUntil) {
      second = await tryModel(SECOND_MODEL_URL, raw, start);
      if (second.done && (second.status === 404 || second.status === 400)) {
        secondSkipUntil = Date.now() + 60 * 60 * 1000; // tên model sai -> bỏ qua 1 giờ
        console.warn('Model Gemini thứ 2 không dùng được (HTTP ' + second.status + ').');
      } else if (second.done) {
        secondSkipUntil = 0;
        return res.status(second.status).json(second.data);
      } else if (second.n429 >= KEYS.length) {
        secondSkipUntil = Date.now() + PRIMARY_SKIP_MS;
      }
    }

    // Bước 3: toàn bộ Gemini đều lỗi -> thử Groq
    console.warn('Gemini lỗi toàn bộ, chuyển sang Groq.');
    const groq = await tryGroq(body, start);
    if (groq.done) {
      return res.status(groq.status).json(groq.data);
    }

    // Bước 4: Groq cũng lỗi -> Gemma là dự phòng cuối cùng
    console.warn('Groq cũng lỗi, chuyển sang Gemma.');
    let fallback = { done: false, saw429: false };
    if (KEYS.length) {
      fallback = await tryModel(FALLBACK_MODEL_URL, JSON.stringify(forFallback(body, !gemmaThinkRejected)), start);
      if (
        fallback.done && fallback.status === 400 && !gemmaThinkRejected &&
        /think/i.test(String(fallback.data?.error?.message || ''))
      ) {
        gemmaThinkRejected = true;
        console.warn('Gemma không hỗ trợ thinkingConfig, gửi lại không có.');
        fallback = await tryModel(FALLBACK_MODEL_URL, JSON.stringify(forFallback(body, false)), start);
      }
      if (fallback.done) {
        return res.status(fallback.status).json(fallback.data);
      }
    }

    // Tất cả đều lỗi: trả 429 nếu có key bị giới hạn để client hiện đúng thông báo
    const saw429 = primary.saw429 || second.saw429 || fallback.saw429;
    const finalStatus = saw429 ? 429 : (fallback.lastStatus || groq.lastStatus || 502);
    const finalData = fallback.lastData || groq.lastData || { error: { message: 'Không thể kết nối AI.' } };
    return res.status(finalStatus).json(finalData);
  } catch (error) {
    return res.status(500).json({
      error: {
        message: 'Không thể kết nối AI.',
        detail: String(error?.message || error)
      }
    });
  }
}
