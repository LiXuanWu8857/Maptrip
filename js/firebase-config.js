// ===== Firebase 設定 =====
// 到 Firebase Console（https://console.firebase.google.com）建立專案後，
// 在「專案設定 → 一般 → 你的應用程式」會看到一段 firebaseConfig，
// 把那幾個值貼進下面對應欄位即可。
//
// 注意：這些值不是機密（它們是「公開識別碼」，任何前端網頁都看得到），
// 真正的安全是由 Firestore 安全規則（只允許登入者讀寫自己的資料）控制。
window.FIREBASE_CONFIG = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT.firebaseapp.com",
  projectId: "PASTE_PROJECT",
  storageBucket: "PASTE_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};
