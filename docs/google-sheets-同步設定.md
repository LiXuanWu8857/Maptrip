# 記帳者「每日總結自動上傳 Google Sheets」— 設定教學

> 目的：記帳者在 App 裡把某一天的金額對好、按下「✓ 已完成紀錄」後，該日的總結會自動寫進
> 你自己的 Google 試算表。**結構：每位司機一個試算表（活頁簿）、每個月一個分頁、每天一列；
> 同一天重傳＝更新那一列，不會重複。**
>
> 這條路 **App 端完全不用登入、不存密碼**——秘密都在你自己的 Google Apps Script 裡。
> 只需一次性設定（約 5 分鐘），之後永久自動。

---

## A. 一次性設定步驟

### 1. 建一張「總表」試算表
1. 到 <https://sheets.google.com> 新建一張空白試算表，命名例如 **「Maptrip 收支總表」**。
   （這張只當「索引/入口」，各司機的實際資料會自動另開新檔。）

### 2. 開啟 Apps Script、貼上程式
1. 在那張試算表上方選單：**擴充功能 → Apps Script**。
2. 把預設的 `function myFunction(){}` 全部刪掉，貼上下方 **B 段完整程式碼**。
3. 把程式最上面的 `SECRET` 改成你自訂的一組密碼（英數字，等一下 App 也要填一樣的）。
4. 按 **儲存**（💾）。

### 3. 部署成網頁應用
1. 右上角 **部署 → 新增部署作業**。
2. 齒輪選 **網頁應用程式（Web app）**。
3. 設定：
   - 說明：隨意（例如 maptrip）
   - **執行身分：我（你自己）**
   - **誰可以存取：任何人（Anyone）**  ← 一定要選這個，App 才傳得進來
4. 按 **部署**，第一次會要你 **授權存取**：選你的 Google 帳號 →「進階」→「前往（不安全）」→ 允許。
   （因為是你自己寫的程式在動你自己的試算表，安全的。）
5. 複製出現的 **網頁應用程式網址**（長得像 `https://script.google.com/macros/s/AKfy.../exec`）。

### 4. 回到 App 填設定
1. 記帳者面板（電腦版）→「☁️ 每日上傳 Google Sheets」區。
2. 貼上剛剛的 **/exec 網址** 與 **同一組密碼**，開啟「自動上傳」開關。
3. 按 **測試連線**，看到「連線成功」就完成了。

之後：記帳者對好某天金額 → 按「✓ 已完成紀錄」→ 該日總結自動寫進對應司機的試算表。

---

## B. Apps Script 完整程式碼（貼進步驟 2）

```javascript
// ===== Maptrip → Google Sheets 每日總結接收器 =====
var SECRET = '請改成你自訂的密碼';   // 要和 App 裡填的一致

var HEADERS = ['日期', '星期', '趟數', '現金', '刷卡', '營收', '抽成', '叫車', '支出', '淨利'];
var WD = ['日', '一', '二', '三', '四', '五', '六'];

function doGet() {
  return _json({ ok: true, msg: 'Maptrip sheet sync is alive' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = {};
    try { body = JSON.parse(e.postData.contents); } catch (err) { return _json({ ok: false, error: 'bad json' }); }
    if (String(body.secret || '') !== SECRET) return _json({ ok: false, error: 'bad secret' });
    if (body.type === 'ping') return _json({ ok: true, pong: true });
    if (body.type !== 'daily') return _json({ ok: false, error: 'unknown type' });

    var ss = _driverBook(body.driverUid, body.driverName);   // 司機分活頁簿
    var sh = _monthSheet(ss, body.month);                    // 每月分頁
    _upsertDay(sh, body);                                    // 每日一列（同日更新）
    return _json({ ok: true, book: ss.getName(), url: ss.getUrl(), sheet: sh.getName() });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// 找/建「這位司機」的試算表；用總表的隱藏索引分頁記 driverUid → 檔案 id
function _driverBook(uid, name) {
  uid = String(uid || 'unknown');
  name = String(name || '司機');
  var home = SpreadsheetApp.getActiveSpreadsheet();
  var idx = home.getSheetByName('_index');
  if (!idx) { idx = home.insertSheet('_index'); idx.appendRow(['driverUid', 'name', 'fileId', 'url']); idx.hideSheet(); }
  var data = idx.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === uid) {
      try { return SpreadsheetApp.openById(String(data[i][2])); } catch (e) { break; }
    }
  }
  // 沒有 → 新開一個活頁簿（放在總表同一個資料夾）
  var book = SpreadsheetApp.create('Maptrip 收支 - ' + name);
  try {
    var homeFile = DriveApp.getFileById(home.getId());
    var parents = homeFile.getParents();
    if (parents.hasNext()) { var folder = parents.next(); folder.addFile(DriveApp.getFileById(book.getId())); }
  } catch (e3) {}
  idx.appendRow([uid, name, book.getId(), book.getUrl()]);
  return book;
}

// 找/建某月分頁（tab 名＝'2026-08'），第一列寫表頭
function _monthSheet(ss, month) {
  month = String(month || 'unknown');
  var sh = ss.getSheetByName(month);
  if (!sh) {
    sh = ss.insertSheet(month);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    // 若還留著預設的空白「工作表1」就刪掉
    var def = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
    if (def && ss.getSheets().length > 1) { try { ss.deleteSheet(def); } catch (e) {} }
  }
  return sh;
}

// 依日期 upsert 一列（同一天存在就更新、否則新增；新增後依日期排序）
function _upsertDay(sh, b) {
  var wd = WD[new Date(b.day + 'T00:00:00').getDay()] || '';
  var row = [b.day, wd, b.trips || 0, b.cash || 0, b.card || 0, b.revenue || 0,
             b.commission || 0, b.dispatch || 0, b.expense || 0, b.net || 0];
  var last = sh.getLastRow();
  var days = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  for (var i = 0; i < days.length; i++) {
    if (String(days[i][0]) === String(b.day)) {
      sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sh.appendRow(row);
  // 依日期排序（跳過表頭）
  var n = sh.getLastRow();
  if (n > 2) sh.getRange(2, 1, n - 1, HEADERS.length).sort({ column: 1, ascending: true });
}

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
```

---

## C. 常見問題

- **改了金額再按一次「已完成」會怎樣？** → 同一天那列會被**更新**成最新數字，不會多一列。
- **看不到某司機的檔案？** → 每位司機第一次上傳時會自動新開一個「Maptrip 收支 - 司機名」試算表，
  放在你總表所在的資料夾（或你的雲端硬碟根目錄）。總表的隱藏 `_index` 分頁記錄了每個檔案的網址。
- **要用 Excel 開？** → 在該試算表選 **檔案 → 下載 → Microsoft Excel (.xlsx)**。
- **改程式碼後沒生效？** → Apps Script 要**重新部署**（部署 → 管理部署作業 → 編輯 → 版本選「新版本」）。
- **安全性**：只有知道 `/exec` 網址「且」密碼一致的請求才會被寫入；密碼請別外流。
```
