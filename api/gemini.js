export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'GEMINI_API_KEY chưa được cấu hình trên Vercel.' }
    });
  }

  try {
    const body = req.body || {};
    const raw = JSON.stringify(body);

    if (raw.length > 120000) {
      return res.status(413).json({ error: { message: 'Request quá lớn.' } });
    }

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: raw
      }
    );

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: text || 'Gemini trả về dữ liệu không hợp lệ.' } };
    }

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: {
        message: 'Không thể kết nối Gemini.',
        detail: String(error?.message || error)
      }
    });
  }
}
