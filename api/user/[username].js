// /api/user/[username].js – public, user‑details only

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    return res.status(200).end();
  }
  setCorsHeaders(res);

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Missing username' });

  try {
    const url = `https://www.tiktok.com/@${username}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: `TikTok returned ${response.status}` });
    }
    const html = await response.text();

    // Extract the main JSON blob
    let userDetail = null;
    const match = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s
    );
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        userDetail = data['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
      } catch (e) { /* ignore parse errors */ }
    }

    if (!userDetail) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Extract the largest avatar URL (if any)
    const user = userDetail?.userInfo?.user;
    const avatar =
      user?.avatarLarger ||
      user?.avatarMedium ||
      user?.avatarThumb ||
      user?.avatar ||
      null;

    // Build a clean, lightweight response
    const userData = {
      username: user?.uniqueId || username,
      nickname: user?.nickname || '',
      avatar: avatar,
      secUid: user?.secUid || null,
      bio: user?.signature || '',
      followerCount: user?.followerCount || 0,
      followingCount: user?.followingCount || 0,
    };

    res.status(200).json({ success: true, data: userData });
  } catch (err) {
    console.error('Error fetching user:', err.message);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
}
