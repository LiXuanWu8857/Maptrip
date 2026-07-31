# 記帳者模式 — Firestore 安全規則參考

> ⚠️ **這份規則我（開發端）無法在這裡實測**——規則部署在 Firebase console，不在這個 repo。
> 這是**依目前資料模型寫的起點**，**務必先用 Firebase 主控台的「規則測試工具（Rules Playground）」
> ＋一個真實的第二組帳號驗證過再正式發佈**。發佈錯誤的規則可能讓同步整個壞掉或過度開放。
>
> 為什麼重要：JS 這層（`sync.js`）完全信任規則正確。真正「記帳者只能讀行程、可寫抽成、
> 不能亂看別人」的界線**只由這份規則保證**。這是「記帳者」功能安全性的根。

## 資料模型（目前程式實際用到的路徑）

- `users/{driverUid}/days/{day}`　　行程（司機寫；記帳者讀）
- `users/{driverUid}/commissions/{tripId}`　抽成（司機寫；**記帳者可寫**；司機端訂閱回讀）
- `users/{driverUid}/expenses/{expId}`　支出（加油等；司機寫；**記帳者可讀可寫可刪**；雙向訂閱回讀）
- `users/{driverUid}/manualTrips/{tripId}`　手動紀錄（記帳者代補登；**記帳者可讀可寫可刪**；不寫進 days）
- `users/{driverUid}/meta/access`　`{ bookkeepers: {uid:name}, ... }` 授權清單（只司機自己）
- `users/{driverUid}/meta/profile`　`{ name }`（司機寫；記帳者讀，用來顯示司機名）
- `users/{driverUid}/meta/deleted`　刪除墓碑（只司機自己）
- `users/{bookkeeperUid}/linkedDrivers/{driverUid}`　記帳者自己的司機清單（只本人）
- `invites/{CODE}`　邀請碼（司機建立；記帳者兌換回填 claimedBy；司機撤銷時標 revoked）

## 參考規則（**未實測，先在 Playground 驗證**）

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // 是否為某司機已授權的記帳者（用 get() 讀 access 文件；rules 內 get 不受讀取規則限制）
    function isBookkeeper(driverUid) {
      return request.auth != null &&
        exists(/databases/$(database)/documents/users/$(driverUid)/meta/access) &&
        get(/databases/$(database)/documents/users/$(driverUid)/meta/access)
          .data.bookkeepers[request.auth.uid] != null;
    }
    function isOwner(uid) { return request.auth != null && request.auth.uid == uid; }

    match /users/{uid} {
      // 使用者本人可讀寫自己 user 文件（若有）
      allow read, write: if isOwner(uid);

      // 行程：本人讀寫；記帳者「只讀」
      match /days/{day} {
        allow read:  if isOwner(uid) || isBookkeeper(uid);
        allow write: if isOwner(uid);
      }

      // 抽成：本人讀寫；記帳者可讀可寫（這是記帳者的核心權限）
      match /commissions/{tripId} {
        allow read, write: if isOwner(uid) || isBookkeeper(uid);
      }

      // 支出：本人讀寫；記帳者可讀可寫可刪（記帳者報表要看淨利＝營收−抽成−支出）
      // 比照 commissions 同級待遇。若只想給記帳者「看」不給「改」，把下行 write 收回本人：
      //   allow read:  if isOwner(uid) || isBookkeeper(uid);
      //   allow write: if isOwner(uid);
      match /expenses/{expId} {
        allow read, write: if isOwner(uid) || isBookkeeper(uid);
      }

      // 手動紀錄：記帳者代司機補登當日路程（司機忘記按/現金單）。
      // 獨立子集合，不寫進 days（避免蓋掉司機 App 的 GPS 行程）；本人＋記帳者可讀寫刪。
      match /manualTrips/{tripId} {
        allow read, write: if isOwner(uid) || isBookkeeper(uid);
      }

      // meta：access / deleted 只本人；profile 記帳者可讀（顯示司機名）
      match /meta/{doc} {
        allow read:  if isOwner(uid) || (doc == 'profile' && isBookkeeper(uid));
        allow write: if isOwner(uid);
      }

      // 記帳者自己的「我協助的司機」清單：只本人
      match /linkedDrivers/{driverUid} {
        allow read, write: if isOwner(uid);
      }
    }

    // 邀請碼
    match /invites/{code} {
      // 讀：任何登入者（兌換前需先讀到；碼本身即秘密）
      allow read: if request.auth != null;
      // 建立：司機建立自己的碼
      allow create: if request.auth != null
        && request.resource.data.driverUid == request.auth.uid;
      // 更新：
      //  (a) 兌換者回填 claimedBy（尚未被別人兌換、且只能填自己）；不得改 driverUid
      //  (b) 司機標記 revoked（撤銷持久化）
      allow update: if request.auth != null && (
        ( (resource.data.claimedBy == null || resource.data.claimedBy == request.auth.uid)
          && request.resource.data.claimedBy == request.auth.uid
          && request.resource.data.driverUid == resource.data.driverUid )
        ||
        ( resource.data.driverUid == request.auth.uid )
      );
      allow delete: if request.auth != null && resource.data.driverUid == request.auth.uid;
    }
  }
}
```

## 一定要跑的測試（真實第二帳號）

1. **記帳者讀行程**：B 兌換 A 的碼、A 開一次 App（授權落地）→ B 能看到 A 的行程，改抽成能同步回 A。
2. **未授權者讀不到**：C（沒兌換）直接呼叫讀 A 的 days → **必須被拒**。
3. **一碼一用**：B 兌換後，C 再兌換同一碼 → 應被 `_claimBlock` 擋（「已被使用」）。
4. **撤銷持久**：A 撤銷 B → 邀請碼被標 revoked → A 重開面板/重登，B **不會**又被加回；B 端讀 A 行程被拒。
5. **記帳者不能改行程**：B 嘗試寫 A 的 `days` → 必須被拒（只能寫 commissions / expenses）。
6. **記帳者讀寫支出**：B 讀 A 的 `expenses` → 可讀；B 新增/刪一筆 A 的支出 → 可寫；A 端 `listenExpenses` 即時看到。
7. **未授權者碰不到支出**：C（沒兌換）讀或寫 A 的 `expenses` → **必須被拒**。
8. **撤銷後支出也讀不到**：A 撤銷 B 後，B 讀 A 的 `expenses` → **必須被拒**（`isBookkeeper` 已不成立）。

> ⚠️ 支出含加油等個人成本，開放記帳者讀寫＝把「看帳全貌」給了記帳者。發佈前想清楚這是你要的授權範圍；
> 若只想給「看」不給「改」，用規則裡註解的唯讀版本（read 給記帳者、write 收回本人）。

## 對應的程式端（已修，v262 之後）

- `sync.js`：`_claimBlock`（一碼一用）、`_shouldAuthorize`（跳過 revoked）、`removeBookkeeper` 撤銷時標 revoked。
  新增 `readExpenses` / `writeExpense` / `deleteExpense` / `listenExpenses`；`readDriverData` 一併回傳 `expenses`。
- `bookkeeper.js`：onclick 只帶 uid、名字查表（杜絕名字注入）；移除司機的提示講清楚「授權仍在」。
- `finance.js`：支出改雲端為主＋localStorage 快取；首次啟用遷移舊資料上雲；`listenExpenses` 即時同步；
  換帳號 `resetExpenseSync`（取消訂閱＋清支出快取，防跨帳號殘留）。
