// Model ưu tiên: Gemini
const PRIMARY_MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

// Model dự phòng: chỉ dùng khi TẤT CẢ key Gemini ở trên đều lỗi
const FALLBACK_MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent';

// Client (index.html) tự hủy request sau 8 giây, nên server phải trả lời trước mốc đó.
const TOTAL_BUDGET_MS = 7500;

// Đọc key từ biến môi trường: GEMINI_API_KEY_1 ... GEMINI_API_KEY_7
// (vẫn nhận GEMINI_API_KEY cũ để không bị lỗi nếu chưa đổi tên).
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

const KEYS = loadKeys();
console.log(`Gemini: đã nạp ${KEYS.length} API key`);
console.log(`[GEMINI CONFIG] primary=${PRIMARY_MODEL_URL} fallback=${FALLBACK_MODEL_URL} keys=${KEYS.length}`);

// Trạng thái lưu trong bộ nhớ của instance đang chạy (best-effort trên serverless)
// Mỗi model có con trỏ xoay vòng và bảng cooldown riêng (vì quota tính riêng theo từng model).
const state = {
  [PRIMARY_MODEL_URL]: { cursor: 0, cooldownUntil: new Array(KEYS.length).fill(0) },
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

// Khi TẤT CẢ key Gemini đều 429 (hết quota ngày), tạm bỏ qua Gemini và chạy thẳng Gemma.
// Sau thời gian này mới thử lại Gemini một lần.
const PRIMARY_SKIP_MS = 30 * 60 * 1000;
let primarySkipUntil = 0;

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

// Model dự phòng (Gemma) hay viết phân tích tiếng Anh trước khi trả lời -> dặn thêm vào system prompt.
const NO_ANALYSIS =
  'QUAN TRỌNG: Chỉ viết đúng câu trả lời cuối cùng bằng tiếng Việt. Tuyệt đối không phân tích, không liệt kê gạch đầu dòng, không viết tiếng Anh, không nhắc lại vai/bối cảnh/yêu cầu.';

let gemmaThinkRejected = false; // nhớ nếu Gemma không nhận lệnh tắt suy nghĩ

function forFallback(body, noThink) {
  const b = JSON.parse(JSON.stringify(body || {}));
  const parts = b.systemInstruction?.parts;
  if (Array.isArray(parts)) parts.push({ text: NO_ANALYSIS });
  else b.systemInstruction = { parts: [{ text: NO_ANALYSIS }] };
  // Gemma "nghĩ" trước khi trả lời và phần nghĩ cũng tốn token. Nếu giới hạn quá nhỏ (vd 180)
  // thì hết token trước khi tới câu trả lời -> client nhận rỗng. Nới trần để còn chỗ cho câu trả lời.
  const gc = (b.generationConfig = b.generationConfig || {});
  const orig = gc.maxOutputTokens || 180;
  if (noThink) {
    // Thử tắt "suy nghĩ" cho nhanh (Gemma suy nghĩ lâu dễ quá 8 giây).
    gc.thinkingConfig = { thinkingBudget: 0 };
    gc.maxOutputTokens = Math.max(orig * 2, 360);
  } else {
    gc.maxOutputTokens = Math.min(1500, Math.max(900, orig * 4));
  }
  return b;
}

// Xoay vòng qua toàn bộ key của MỘT model.
// Trả về:
//   { done: true, status, data }                       -> có kết quả để trả cho client
//   { done: false, lastStatus, lastData, saw429 }      -> tất cả key của model này đều lỗi
async function tryModel(modelUrl, raw, start) {
  const n = KEYS.length;
  const st = state[modelUrl];

  // Xoay vòng: mỗi request bắt đầu từ key tiếp theo, hết key cuối thì quay lại key đầu
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

      // DEBUG CHI TIẾT: ghi lại nguyên nhân Gemini trả lỗi nhưng KHÔNG ghi API key.
      // Hữu ích để xác định 429 là RPM / TPM / RPD / RESOURCE_EXHAUSTED / quota khác.
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

      console.error(
        '[GEMINI DEBUG]',
        JSON.stringify(debugInfo, null, 2)
      );

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

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  if (!KEYS.length) {
    return res.status(500).json({
      error: {
        message:
          'Chưa cấu hình GEMINI_API_KEY_1 ... GEMINI_API_KEY_7 trên Vercel.'
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

    // Bước 1: ưu tiên Gemini, xoay vòng qua các key
    let primary = { done: false, saw429: false };
    if (Date.now() >= primarySkipUntil) {
      primary = await tryModel(PRIMARY_MODEL_URL, raw, start);
      if (primary.done) {
        primarySkipUntil = 0;
        return res.status(primary.status).json(primary.data);
      }
      if (primary.n429 >= KEYS.length) {
        primarySkipUntil = Date.now() + PRIMARY_SKIP_MS;
        console.warn('Cả ' + KEYS.length + ' key Gemini đều hết quota, bỏ qua Gemini 30 phút và chạy thẳng Gemma.');
      }
    }

    // Bước 2: tất cả key Gemini đều lỗi -> mới chuyển sang Gemma
    console.warn('Tất cả key Gemini đều lỗi, chuyển sang gemma-4-26b-a4b-it.');
    let fallback = await tryModel(FALLBACK_MODEL_URL, JSON.stringify(forFallback(body, !gemmaThinkRejected)), start);
    if (
      fallback.done && fallback.status === 400 && !gemmaThinkRejected &&
      /think/i.test(String(fallback.data?.error?.message || ''))
    ) {
      // Gemma không nhận lệnh tắt suy nghĩ -> nhớ lại và gửi lại bản không có lệnh đó
      gemmaThinkRejected = true;
      console.warn('Gemma không hỗ trợ thinkingConfig, gửi lại không có.');
      fallback = await tryModel(FALLBACK_MODEL_URL, JSON.stringify(forFallback(body, false)), start);
    }
    if (fallback.done) {
      return res.status(fallback.status).json(fallback.data);
    }

    // Cả Gemini lẫn Gemma đều lỗi: trả 429 nếu có key bị giới hạn để game hiện đúng thông báo
    const saw429 = primary.saw429 || fallback.saw429;
    return res
      .status(saw429 ? 429 : fallback.lastStatus)
      .json(fallback.lastData);
  } catch (error) {
    return res.status(500).json({
      error: {
        message: 'Không thể kết nối Gemini.',
        detail: String(error?.message || error)
      }
    });
  }
}
