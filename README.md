# Daywell 個人行程與任務管理系統

Daywell 是單頁 Web App，使用 Firebase Authentication 進行 Google 登入、Cloud Firestore 儲存個人行程與任務，並提供 Firebase AI Logic 行程助理。

## 資料與存取方式

- 登入者的資料放在 `users/{Firebase Auth UID}/items/{itemId}`。
- Firestore Rules 限制每位登入者只能讀寫自己的資料，並檢查欄位、日期格式、時間與預估分鐘數。
- 第一次登入時，若該帳號的 Firestore 資料是空的，會把目前瀏覽器的本機行程匯入雲端；已有雲端資料時則以雲端為準。
- 本機也會按 UID 保留快取，登出後回到訪客本機資料。
- 已同步的雲端快照會保存在本機作為離線編輯比對基準；網路中斷時新增或變更的項目會在重新連線後補同步。
- AI 助理送出問題時會一併傳送今天的行程，以及逾期和未來七天內到期的未完成任務摘要。對話不會寫入 Firestore。

## Firebase 初次設定

1. 在 Firebase Console 確認 Cloud Firestore 使用 `(default)` 資料庫，並啟用 Google Authentication。
2. 到 Authentication 的「已授權網域」加入 GitHub Pages 網域，例如 `roger4654.github.io`。
3. 在本專案資料夾執行一次 Firebase CLI 登入：

   ```powershell
   pnpm dlx firebase-tools@latest login
   ```

4. 部署 Firestore 安全規則：

   ```powershell
   pnpm dlx firebase-tools@latest deploy --only firestore:rules
   ```

5. 在 Firebase Console 啟用 Firebase AI Logic；若 Console 要求 CLI 初始化，執行：

   ```powershell
   pnpm dlx firebase-tools@latest init ailogic --project my-web-app-b1606
   ```

6. 在 Firebase Console 的 App Check 將 Web App 註冊為 reCAPTCHA Enterprise，複製公開的 Site Key，貼到 `firebase-app.js` 的 `RECAPTCHA_ENTERPRISE_SITE_KEY`。確認測試／正式網域已列在 reCAPTCHA Enterprise 金鑰允許的網域中，再依 Firebase Console 指示啟用 Firebase AI Logic 的 App Check。
7. 將變更推送到 GitHub，等待 GitHub Pages 更新後，以 `https://` 網址測試。`file://` 直接開啟無法載入 Firebase ES Modules。

部署前的本機 Firebase 專案 ID 已記在 `.firebaserc`，Firestore 規則與索引設定分別在 `firestore.rules` 和 `firestore.indexes.json`。

## 功能驗收清單

- [ ] Google 登入、登出、重新整理後恢復登入狀態。
- [ ] 新增行程或任務後，狀態顯示「已同步至雲端」；重新整理後資料仍存在。
- [ ] 在另一個瀏覽器工作階段登入同一帳號，確認新增或完成狀態會同步。
- [ ] 使用另一個 Google 帳號登入，確認看不到前一帳號的行程。
- [ ] 在 Firestore Console 確認文件位於 `users/{UID}/items`，且沒有寫入其他人的資料。
- [ ] AI App Check 設定完成後，詢問「哪些任務已逾期或即將到期？」並確認回覆符合實際行程。
- [ ] 撤銷瀏覽器通知權限或離線時確認 APP 顯示可理解的提示，且本機資料仍可操作。

## 瀏覽器通知

通知權限由使用者點擊 APP 的通知按鈕後授權。瀏覽器頁面需保持開啟，瀏覽器通知不能在頁面關閉時代替伺服器推播。
