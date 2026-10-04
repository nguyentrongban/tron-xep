const MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

// Client (index.html) tự hủy request sau 5 giây, nên server phải trả lời trước mốc đó.
const TOTAL_BUDGET_MS = 4700;

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

// Trạng thái lưu trong bộ nhớ của instance đang chạy (best-effort trên serverless)
let cursor = 0; // key sẽ bắt đầu ở request kế tiếp (xoay vòng)
const cooldownUntil = new Array(KEYS.length).fill(0); // key lỗi sẽ được nghỉ một lúc

// Lỗi nào thì đổi sang key khác
function shouldRotate(status, data) {
  if (status === 429 || status === 401 || status === 403 || status >= 500) return true;
  if (status === 400) {
    // 400 do key sai thì đổi key, 400 do request sai thì trả về luôn
    return /api key/i.test(String(data?.error?.message || ''));
  }
  return false;
}

function cooldownFor(status) {
  if (status === 429) return 60 * 1000; // hết lượt/phút
  if (status === 400 || status === 401 || status === 403) return 5 * 60 * 1000; // key hỏng
  return 5 * 1000; // lỗi tạm thời
}

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
    const n = KEYS.length;

    // Xoay vòng: mỗi request bắt đầu từ key tiếp theo, hết key cuối thì quay lại key đầu
    const first = cursor % n;
    cursor = (cursor + 1) % n;

    const order = [];
    for (let j = 0; j < n; j++) order.push((first + j) % n);

    // Ưu tiên key đang khỏe, key đang nghỉ thì thử sau cùng
    const now = Date.now();
    const ready = order.filter((i) => cooldownUntil[i] <= now);
    const cooling = order.filter((i) => cooldownUntil[i] > now);
    const tryOrder = [...ready, ...cooling];

    let lastStatus = 502;
    let lastData = { error: { message: 'Không thể kết nối Gemini.' } };
    let saw429 = false;

    for (const i of tryOrder) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - start);
      if (remaining < 300) break;

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), remaining);

      try {
        const response = await fetch(MODEL_URL, {
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
          return res.status(response.status).json(data);
        }

        // Key này lỗi -> ghi nhận rồi thử key kế tiếp
        if (response.status === 429) saw429 = true;
        cooldownUntil[i] = Date.now() + cooldownFor(response.status);
        lastStatus = response.status;
        lastData = data;
        console.warn(`Gemini key #${i + 1}/${n} lỗi HTTP ${response.status}, chuyển key tiếp theo`);
      } catch (error) {
        cooldownUntil[i] = Date.now() + cooldownFor(500);
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

    // Tất cả key đều lỗi: trả 429 nếu có key bị giới hạn để game hiện đúng thông báo
    return res.status(saw429 ? 429 : lastStatus).json(lastData);
  } catch (error) {
    return res.status(500).json({
      error: {
        message: 'Không thể kết nối Gemini.',
        detail: String(error?.message || error)
      }
    });
  }
}
