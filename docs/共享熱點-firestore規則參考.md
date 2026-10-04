# 共享找客熱點 / 車隊 — Firestore 安全規則參考（Phase 1 車隊 ＋ Phase 2 全體）

> ✅ **整理好、可整份貼上的完整規則在 repo 根目錄 `firestore.rules`**（含記帳者＋Phase 1＋Phase 2，
> 一次貼進 Firebase 主控台就好）。本文是**逐段說明＋測試清單**。
>
> ⚠️ **這份規則我（開發端）無法在這裡實測**——規則部署在 Firebase console，不在 repo。
> **務必先用 Rules Playground ＋第二組真實帳號驗證再發佈**。JS 這層（`sync.js`）完全信任規則正確；
> 「只有隊員能讀寫該隊 grid、全體池 count 只增、格子只存去識別化熱度」的界線**只由規則保證**。

## 資料模型（`js/sync.js` 車隊段實際用到的路徑）

- `groups/{gid}`　　　　　　　`{ name, ownerUid, createdAt, memberCount }`
- `groups/{gid}/members/{uid}`　`{ name, joinedAt }`（一個 uid 一份；加入即建、退出即刪）
- `groups/{gid}/grid/{cellId}`　`{ gLat, gLng, dayType, bucket, count, updatedAt }`
  - **去識別化**：無 uid、無精確座標、無車資、無實際時間點。`cellId = g3(lat)_g3(lng)_dayType_bucket`（300m 網格）
  - `count` 只增不減（貢獻 +1、回填 +delta）
- `groupInvites/{CODE}`　　　`{ groupId, groupName, by, createdAt, exp }`（隊員產生；比照記帳者邀請碼）
- `users/{uid}/meta/prefs`　　`{ shareHotspots, groupId, groupName }`（**只本人**；已被既有 meta 規則涵蓋：write 只本人）

> `meta/prefs` 不需另寫規則——沿用記帳者參考裡的 `match /meta/{doc}`（write 只本人；prefs 非 profile，記帳者也讀不到）。

## Phase 2：全體去識別化池（`hotspotGrid`）

- 資料路徑：`hotspotGrid/{cellId}`，欄位與車隊 grid **完全相同** `{ gLat, gLng, dayType, bucket, count, updatedAt }`。
- 偏好：`users/{uid}/meta/prefs.shareGlobal`（bool，只本人；與車隊 `groupId` 獨立，兩池可同時開）。
- 權限：**任何登入者可讀可寫**（本來就是要給大家看/貢獻）、`count` 只增不減、不可刪。
- **k-匿名門檻更高＝5**（車隊 2）：在前端 `hotspot-share.globalCells` 過濾（`GLOBAL_MIN_COUNT=5`），規則不管門檻。
- 貢獻：司機完成一趟載客時，車隊（若在隊＋開分享）與全體（若開 `shareGlobal`）**各自都 +1**（同一趟前端去重一次、共用每日上限 300）。

## 需要的複合索引（**務必先建兩個，否則讀取查詢會被 Firestore 擋**）

讀 grid 的查詢是「兩個等值 + 一個範圍」，車隊與全體各需一個索引：
```
groups/{gid}/grid  where dayType == …  where bucket == …  where gLat >= …  where gLat <= …   → 索引①
hotspotGrid        where dayType == …  where bucket == …  where gLat >= …  where gLat <= …   → 索引②
```
→ 各需 **集合（Collection）索引**，欄位順序 `dayType (ASC)`、`bucket (ASC)`、`gLat (ASC)`。
第一次查詢失敗時，Firestore 主控台會回一個「建立索引」的直接連結，點下去建即可（約 1–2 分鐘生效）。
（車隊 grid 是子集合，若要跨多隊查可改建「集合群組 Collection group」索引；本專案只查自己那一隊，一般集合索引即可。）

## 參考規則（**未實測，先在 Playground 驗證**；與記帳者規則並存，貼進同一個 `match /documents` 內）

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // …（記帳者那份的 users/{uid}、invites/{code} 規則照舊，見「記帳者-firestore規則參考.md」）…

    // ===== 共享熱點 / 車隊（Phase 1）=====
    function signedIn() { return request.auth != null; }
    // 是否為某隊隊員（存在該隊的 members/{我的uid} 文件）
    function isMember(gid) {
      return signedIn() &&
        exists(/databases/$(database)/documents/groups/$(gid)/members/$(request.auth.uid));
    }

    match /groups/{gid} {
      // 讀隊資訊：僅隊員
      allow read:   if isMember(gid);
      // 建隊：建立者把自己設為 ownerUid、memberCount 起始 1
      allow create: if signedIn()
        && request.resource.data.ownerUid == request.auth.uid
        && request.resource.data.memberCount == 1;
      // 更新：隊員可改（memberCount 加入/退出時 ±1）。刪整隊不開放。
      allow update: if isMember(gid);
      allow delete: if false;

      // 成員名冊：讀＝隊員；建立/刪除＝只能動「自己那一份」（doc id == 我的 uid）
      match /members/{muid} {
        allow read:   if isMember(gid);
        allow create: if signedIn() && muid == request.auth.uid;
        allow delete: if signedIn() && muid == request.auth.uid;   // 退隊
        allow update: if signedIn() && muid == request.auth.uid;
      }

      // 去識別化格子：隊員可讀可寫。count 只增不減（擋歸零/亂改）。
      match /grid/{cellId} {
        allow read:   if isMember(gid);
        allow create: if isMember(gid)
          && request.resource.data.count is number && request.resource.data.count >= 1;
        allow update: if isMember(gid)
          && request.resource.data.count > resource.data.count;   // 只准增加
        allow delete: if false;
      }
    }

    // 車隊邀請碼：讀＝任何登入者（兌換前需讀到；碼即秘密）；
    // 建立＝該隊隊員且 by==自己；刪除＝建立者。
    match /groupInvites/{code} {
      allow read:   if signedIn();
      allow create: if signedIn()
        && request.resource.data.by == request.auth.uid
        && isMember(request.resource.data.groupId);
      allow update: if signedIn() && resource.data.by == request.auth.uid;
      allow delete: if signedIn() && resource.data.by == request.auth.uid;
    }
  }
}
```

## 一定要跑的測試（真實第二帳號）

1. **建隊＋加入**：A 建隊（`createCarTeam`）→ 產生邀請碼 → B `joinCarTeam(code)`：B 應能建立自己的 `members/B`、
   `memberCount` 變 2、B 的 `prefs.groupId` 寫入成功。
2. **隊員可讀 grid**：A、B 完成幾趟載客（`contributeHotspot`）後，雙方 `readGroupGrid` 都讀得到彼此貢獻的格子。
3. **非隊員讀不到**：C（未加入）直接讀 `groups/{gid}/grid` 或 `members` → **必須被拒**。
4. **count 只增**：嘗試把某格 `count` 改小或設 0 → **必須被拒**；改大（+1/+delta）→ 可寫。
5. **grid 不含個資**：抽查任一格子文件，確認只有 `gLat/gLng/dayType/bucket/count/updatedAt`，**沒有 uid/精確座標/車資/時間點**。
6. **邀請碼**：非隊員 by≠自己 建立 groupInvites → 拒；隊員產生 → 可；30 天 `exp` 過期由前端 `_teamClaimBlock` 擋。
7. **退隊**：B `leaveCarTeam` → `members/B` 被刪、`memberCount` −1；退隊後 B 讀 grid → **必須被拒**。
8. **k-匿名（前端）**：只有 1 筆的格子在讀取端（`teamCells`，門檻 2）不顯示——這是隱私/雜訊防線，非規則層。
9. **全體池讀寫（Phase 2）**：登入者 D 開 `shareGlobal` → 完成載客後 `hotspotGrid` 對應格 +1；讀 `hotspotGrid` 拿得到附近格。
10. **全體池 count 只增**：把 `hotspotGrid` 某格 count 改小/設 0 → **必須被拒**。
11. **全體池 k-匿名（前端）**：count<5 的格在 `globalCells`（門檻 5）不顯示；同資料在車隊（門檻 2）才顯示。
12. **兩池獨立**：只開車隊沒開全體 → 不寫 `hotspotGrid`；只開全體沒在車隊 → 不寫任何 `groups`。同開 → 一趟兩池各 +1。

## 隱私與防濫用（設計備註）

- 格子文件本身**查不到個人**——就算整張網格外洩，也只是「哪裡需求高」的聚合熱度。
- k-匿名（讀取 count≥2 才顯示）避免單一司機的私房點被看見（在 `hotspot-share.js` 的 `teamCells`）。
- 貢獻**每人每日上限 300 次**（`sync.js._capTake`，localStorage 計數）＋**一趟只 +1**（前端去重）＋回填**單次上限 500 格**。
- 規則無法原生「限速每人每分鐘幾次」；`count 只增` + 前端去重/上限能擋大宗濫用，殘餘「慢慢刷」風險**接受為 Beta**（動機低、成本高）。

## 對應程式端

- `js/hotspot-share.js`（`MaptripHotspotShare`）：`cellFields`/`cellId`/`dayType`/`bucket`、`aggregateHistoryCells`（回填聚合）、
  `ownCellsNow`/`teamCells`（k-匿名/半徑過濾）/`mix`（自×2＋隊×1 排名）。純函式，測試 `hotspotshare.js` 23 項。
- `js/sync.js`：`myTeam`/`setShareHotspots`/`createCarTeam`/`createTeamInvite`/`joinCarTeam`/`leaveCarTeam`/
  `contributeHotspot`（貢獻＋去重＋每日上限）/`readGroupGrid`（複合查詢）/`backfillTeamGrid`（分批＋500 上限）。
  純函式 `_teamClaimBlock`/`_capTake` 測試 `hsteam.js` 21 項。
- `js/hotspots.js`：面板「🚕 車隊」鈕 → 建立/加入/邀請碼/回填/退出/分享開關；`run()` 秒出「我的」後再升級「混合」。
  接線測試 `hotspotpanel.js` 20 項。
- `js/recorder.js`：`finalizeSavedTrip` 完成一趟載客（有上車點、非「其他」）→ 呼叫 `contributeHotspot`（有加入車隊＋開分享才寫）。
