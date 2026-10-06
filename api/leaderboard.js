// ===== TRỐN SẾP TAN CA — LEADERBOARD API =====
// Dùng Supabase REST API để không cần thêm npm package.
// Vercel Environment Variables cần có:
// SUPABASE_URL
// SUPABASE_ANON_KEY
// SUPABASE_SERVICE_ROLE_KEY  (CHỈ backend, không đưa vào frontend)

const cleanName = value => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);

const json = (res, status, data) => {
  res.status(status).setHeader('Cache-Control', 'no-store');
  return res.json(data);
};

const supabase = () => {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw new Error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY');
  return { url, key };
};

const headers = key => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json'
});

async function sbFetch(path, options = {}) {
  const { url, key } = supabase();
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers(key), ...(options.headers || {}) }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) {
    const message = data?.message || data?.error || text || `Supabase ${r.status}`;
    throw new Error(message);
  }
  return { response: r, data };
}

function validInput(body) {
  const player_id = String(body?.player_id || '').trim();
  const nickname = cleanName(body?.nickname);
  const level = Number(body?.level);
  const time_ms = Number(body?.time_ms);

  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(player_id)) throw new Error('player_id không hợp lệ');
  if (nickname.length < 3 || nickname.length > 16) throw new Error('Nickname phải từ 3–16 ký tự');
  if (!Number.isInteger(level) || level < 1 || level > 200) throw new Error('Màn không hợp lệ');
  // Chặn các kỷ lục phi thực tế. Game hiện tại dùng giây, nên <2s gần như chắc chắn là gian lận.
  if (!Number.isInteger(time_ms) || time_ms < 2000 || time_ms > 15 * 60 * 1000) throw new Error('Thời gian không hợp lệ');

  return { player_id, nickname, level, time_ms };
}

async function getTop(level) {
  const q = `leaderboard?select=player_id,nickname,level,time_ms,updated_at&level=eq.${encodeURIComponent(level)}&order=time_ms.asc&limit=50`;
  const { data } = await sbFetch(q);
  return Array.isArray(data) ? data : [];
}

async function getRank(level, time_ms) {
  const q = `leaderboard?select=player_id&level=eq.${encodeURIComponent(level)}&time_ms=lt.${encodeURIComponent(time_ms)}`;
  const { response } = await sbFetch(q, {
    headers: {
      Prefer: 'count=exact',
      Range: '0-0'
    }
  });
  const range = response.headers.get('content-range') || '';
  const m = range.match(/\/(\d+|\*)$/);
  const faster = m && m[1] !== '*' ? Number(m[1]) : 0;
  const rank = faster + 1;

  const countQ = `leaderboard?select=player_id&level=eq.${encodeURIComponent(level)}`;
  const { response: countResponse } = await sbFetch(countQ, {
    headers: { Prefer: 'count=exact', Range: '0-0' }
  });
  const countRange = countResponse.headers.get('content-range') || '';
  const cm = countRange.match(/\/(\d+|\*)$/);
  const total = cm && cm[1] !== '*' ? Number(cm[1]) : Math.max(rank, 1);
  const percentile = total > 1 ? Math.max(0, Math.min(99, Math.round((1 - rank / total) * 100))) : 0;
  return { rank, total, percentile };
}

module.exports = async (req, res) => {
  try {
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      if (String(req.query?.config || '') === '1') {
        const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
        const anonKey = String(process.env.SUPABASE_ANON_KEY || '');
        if (!url || !anonKey) return json(res, 503, { error: 'Supabase chưa được cấu hình' });
        return json(res, 200, { url, anonKey });
      }

      const level = Number(req.query?.level);
      if (!Number.isInteger(level) || level < 1 || level > 200) {
        return json(res, 400, { error: 'level không hợp lệ' });
      }

      const items = await getTop(level);
      return json(res, 200, { level, items, rank: null });
    }

    if (method === 'POST') {
      const input = validInput(req.body || {});
      const { player_id, nickname, level, time_ms } = input;

      // Chỉ lưu nếu người chơi nhanh hơn kỷ lục hiện tại của chính họ.
      const existingQ = `leaderboard?select=id,player_id,nickname,level,time_ms&player_id=eq.${encodeURIComponent(player_id)}&level=eq.${encodeURIComponent(level)}&limit=1`;
      const { data: existing } = await sbFetch(existingQ);
      const old = Array.isArray(existing) ? existing[0] : null;

      if (old && Number(old.time_ms) <= time_ms) {
        const rankInfo = await getRank(level, Number(old.time_ms));
        const top = await getTop(level);
        return json(res, 200, { saved: false, rank: rankInfo.rank, total: rankInfo.total, percentile: rankInfo.percentile, top, time_ms: Number(old.time_ms) });
      }

      if (old) {
        await sbFetch(`leaderboard?id=eq.${encodeURIComponent(old.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ nickname, time_ms, updated_at: new Date().toISOString() })
        });
      } else {
        await sbFetch('leaderboard', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ player_id, nickname, level, time_ms })
        });
      }

      const rankInfo = await getRank(level, time_ms);
      const top = await getTop(level);
      return json(res, 200, { saved: true, rank: rankInfo.rank, total: rankInfo.total, percentile: rankInfo.percentile, top, time_ms });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('[LEADERBOARD]', error);
    return json(res, 500, { error: 'Leaderboard error', detail: String(error?.message || error) });
  }
};
