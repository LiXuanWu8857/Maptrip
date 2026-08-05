# 火車到站提醒 — 用一把金鑰服務所有使用者（Cloudflare Worker 代理）

**目標**：把你的 TDX 金鑰藏在一台免費伺服器（Cloudflare Worker）上，讓**所有使用者的 App
不用各自申請金鑰、打開就有火車提醒**，而你的金鑰**永遠不外流**、免費額度也不會爆。

> 預計時間：約 10 分鐘，一次性設定。完成後把 Worker 網址給我，我改 App 收尾。

---

## 一、為什麼要這樣做（重要觀念）

- App 網頁是**公開**部署在 GitHub Pages。**金鑰絕對不能寫進前端程式碼**——任何人看原始碼就抓得到，
  會把你的額度打爆、甚至害你的 TDX 帳號被停權。
- 正解是**代理（Proxy）**：金鑰只放在伺服器，App 打伺服器、伺服器再去打 TDX。

```
使用者的 App  ──►  你的 Cloudflare Worker（藏金鑰＋快取）  ──►  TDX
                         金鑰永不外流、回應共用快取
```

- **為什麼額度不會爆**：同一個車站的時刻表對所有人都一樣。Worker 會把 TDX 回應**快取**起來，
  100 個使用者共用同一份，實際打 TDX 的次數極少 → 一把免費金鑰就夠。

---

## 二、步驟

### 步驟 A：註冊 Cloudflare（免費）
1. 到 <https://dash.cloudflare.com/sign-up> 用 Email 註冊，驗證信箱。
2. 登入後不需要買任何方案、不需要綁網域。

### 步驟 B：建立 Worker
1. 左側選單 **Workers & Pages** → **Create application** → **Create Worker**。
2. 取名例如 `maptrip-tdx`（網址會變成 `https://maptrip-tdx.<你的帳號>.workers.dev`）。
3. 按 **Deploy**（先用預設範本部署一次，等一下再貼我們的程式碼）。
4. 進去後點 **Edit code**，把編輯器內容**全部刪掉**，貼上「**四、Worker 程式碼**」那一整段，再按 **Deploy**。

### 步驟 C：設定金鑰（用環境變數，不要寫進程式碼）
1. 在該 Worker 頁面 → **Settings** → **Variables and Secrets**（或 Variables）。
2. 新增兩個變數，型別選 **Secret（加密）**：
   - `TDX_ID`＝你的 TDX Client Id
   - `TDX_SECRET`＝你的 TDX Client Secret
3. 按 **Save / Deploy**。

> 這樣金鑰只存在 Cloudflare 加密變數裡，程式碼裡看不到、GitHub 上也沒有。

### 步驟 D：測試 Worker 有沒有活
在瀏覽器打開（把網址換成你的）：
```
https://maptrip-tdx.<你的帳號>.workers.dev/v3/Rail/TRA/StationLiveBoard/Station/1000
```
- 看到一串 JSON（台北車站即時到離站）＝**成功** 🎉
- 看到 `token error` ＝金鑰變數沒設好，回步驟 C 檢查。
- 看到 `forbidden path` ＝網址打錯（只允許指定的台鐵端點）。

### 步驟 E：把網址給我
把你的 Worker 網址（`https://maptrip-tdx.<你的帳號>.workers.dev`）貼給我，我會：
1. 把 App 改成打你的 Worker（不再需要每支手機各自輸入金鑰）。
2. 讓火車提醒**對所有使用者預設開啟**。
3. 保留「設定」面板，讓進階使用者仍可改用自己的金鑰或關閉。

---

## 三、額度與安全備註
- **Cloudflare 免費**：每天 10 萬次請求，這功能遠用不到。
- **TDX 免費額度**：靠 Worker 快取（站點清單快取 1 天、時刻表 5 分鐘、即時看板 30 秒），
  多人共用也只會產生少量實際 TDX 呼叫。
- **只轉發台鐵指定端點**：Worker 內建白名單，不會變成被人濫用的開放代理。
- **金鑰外洩風險**：金鑰只在 Cloudflare 加密變數，App 端完全看不到。
- **每年提醒**：TDX 免費金鑰長期有效；若哪天要換金鑰，只改 Cloudflare 變數即可，App 不用動。

---

## 四、Worker 程式碼（整段複製貼上）

```js
// Maptrip 火車提醒 — TDX 代理 Worker
// 設定：Settings → Variables and Secrets 加兩個 Secret：TDX_ID、TDX_SECRET
const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_BASE = 'https://tdx.transportdata.tw/api/basic';

// 只允許轉發這些台鐵端點（避免變成開放代理）
const ALLOW = [
  /^\/v3\/Rail\/TRA\/Station$/,
  /^\/v3\/Rail\/TRA\/DailyStationTimetable\/Today\/[^/]+$/,
  /^\/v3\/Rail\/TRA\/StationLiveBoard\/Station\/[^/]+$/,
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let tokenCache = { tok: null, exp: 0 }; // 同一 isolate 內快取 token（省呼叫）

async function getToken(env) {
  const now = Date.now();
  if (tokenCache.tok && tokenCache.exp > now + 60000) return tokenCache.tok;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TDX_ID,
    client_secret: env.TDX_SECRET,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('token ' + r.status);
  const j = await r.json();
  tokenCache = { tok: j.access_token, exp: now + (j.expires_in || 86400) * 1000 };
  return tokenCache.tok;
}

function ttlFor(pathname) {
  if (pathname === '/v3/Rail/TRA/Station') return 86400;        // 站點清單：1 天
  if (pathname.includes('StationLiveBoard')) return 30;         // 即時看板：30 秒
  return 300;                                                   // 時刻表：5 分鐘
}

function withCors(resp) {
  const r = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (!ALLOW.some((re) => re.test(url.pathname))) {
      return new Response('forbidden path', { status: 403, headers: CORS });
    }

    // 邊快取：同一 URL 全體使用者共用一份，大幅降低 TDX 呼叫
    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit);

    let token;
    try {
      token = await getToken(env);
    } catch (e) {
      return new Response('token error', { status: 502, headers: CORS });
    }

    const upstream = TDX_BASE + url.pathname + url.search;
    const r = await fetch(upstream, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    });

    const resp = new Response(r.body, r);
    resp.headers.set('Cache-Control', `public, max-age=${ttlFor(url.pathname)}`);
    for (const [k, v] of Object.entries(CORS)) resp.headers.set(k, v);
    if (r.ok) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
```

---

## 五、今晚只要做到這裡
做完 **步驟 A～D**，確認「步驟 D 測試」看到 JSON，就把 **Worker 網址**貼給我。
App 端的接線（步驟 E）我來改、測試、部署，你不用動 code。

> 有任何一步卡住（例如變數設定、部署按鈕找不到），把畫面截圖給我，我帶你過。
