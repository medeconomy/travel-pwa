# Travel PWA

離線可用的旅程資訊 App，資料來源是 Obsidian vault 的 `AIObsi/Travel/` 資料夾。
不改變任何寫筆記的習慣：在 Obsidian 照常維護 `Travel/YYYYMM_旅名/*.md`，跑一次 `build.py` 就把所有筆記、附件打包成 App。

```
build.py        # 讀 vault → app/data/trips.json + app/data/att/（附件）+ 更新 sw.js 版本
publish.sh      # build + git commit + push（推上去後 GitHub Actions 自動部署到 Pages）
app/            # 靜態 PWA（純 HTML/CSS/JS，無框架、無相依套件）
  index.html, app.js, md.js (Obsidian 風格 Markdown 渲染), styles.css, sw.js, manifest.webmanifest, icons/
```

## App 功能
- 首頁：進行中 / 即將出發（倒數 D-n）/ 通用資訊 / 過去旅程
- 旅程頁：每則筆記一個分頁（行程、航班、住宿、行李清單、記帳…），右上 ☰ 目錄跳段落
- 旅程進行中自動跳到今天的 `D3｜` / `Day 3｜` 段落並標黃
- Markdown：標題、表格、callout（`> [!warning]`）、checkbox、wikilink 互連、圖片、PDF 附件
- 行李清單 checkbox 可以在手機上勾，存在手機本機（筆記在 Obsidian 改過後會重設，以筆記為準）
- 全文搜尋所有旅程
- 完整離線：安裝後所有筆記與附件都在手機上；有網路時自動抓最新資料、有新版本會跳「更新」

## 資料約定（都是既有習慣，只列出 build 會讀的部分）
- 旅程資料夾：`Travel/YYYYMM_旅名/`，裡面每個 `.md` 都變成一個分頁，依檔名排序（`01 …`、`01.1 …`）
- `Travel/` 根目錄的 `.md`（記帳流程、貴賓室）→「通用資訊」
- 出發/回程日期：任一筆記 frontmatter 的 `depart:` / `return:`（或 `start_date:` / `end_date:`）
  沒有的話會從筆記內容推定（顯示「推定」）；要修正就加 frontmatter
- 預設開啟的分頁：frontmatter `type: itinerary` 的筆記，否則檔名含「行程」者
- 附件：`![[xxx.pdf]]` / `[[Attachments/xxx.pdf|名稱]]` 會一起打包（單檔 > 8 MB 略過，可用 `--max-attach-mb` 調）

## 本機預覽
```bash
python3 build.py "YYYYMM_旅名" && python3 -m http.server 8765 --directory app
```
開 http://localhost:8765 。（Service worker 只在 localhost 或 HTTPS 生效，所以手機安裝要走下面的部署。）

## 發佈到 GitHub Pages（已設定好）
- Repo：`medeconomy/travel-pwa`（public）→ 網址 **https://medeconomy.github.io/travel-pwa/**
- 更新：在 Mac 終端機 `~/Projects/travel-pwa/publish.sh` → build → commit → push → GitHub Actions 約 1 分鐘部署完成
- iPhone：Safari 開網址 → 分享 → 加入主畫面；之後離線可用，有網路時會提示「有新版本 → 更新」

## 隱私：哪些筆記會上線（網站是公開的）
**預設不公開（opt-in）**：只有 frontmatter 寫了 `pwa: true` 的筆記才會打包上線，其他一律留在本機。

```yaml
---
pwa: true     # 上線
# pwa: false  # 永遠不上線（不寫 = 不上線）
---
```

- 連到未公開筆記的 `[[連結]]` 會變成純文字 🔒；未公開筆記的附件不會被複製
- `publish.json`（會上傳）：`redact` = 一般性規則（例：`ICS20\\d\\d-I/\\d+` 註冊編號）
- `publish.local.json`（**只在這台 Mac，不會上傳**）：`trips` = 不帶參數時打包哪些旅程（旅程名稱本身也算行程資訊，所以放這裡）；`password`；要遮掉的具體代碼，例如訂位代號、兌換碼 → 發佈版顯示 `‹已隱藏›`
- 每次 build 會列出 `🔒 kept private (...)`，發佈前看一下

## 🔐 密碼保護
GitHub 上的 `app/data/trips.json` 是**加密過的**（AES-256 + PBKDF2，見 `seal.py`，純 Python 標準函式庫，不用另外安裝）。
任何人都看得到網站和程式碼，但沒有密碼讀不到內容；附件（PDF、圖片）也包在加密資料裡。

- 密碼放在 `publish.local.json` 的 `"password"`（只在這台 Mac，不會上傳）；`"salt"` 第一次 build 自動產生，不要刪
- 手機第一次打開會要求密碼；之後記在手機裡、可離線使用。首頁底部「🔒 鎖定此裝置」可清除
- 換密碼：改 `password` → `./publish.sh` → 所有手機要重新輸入新密碼
- `publish.local.json` 沒有 `password` 時，build 會警告並輸出**未加密**資料
