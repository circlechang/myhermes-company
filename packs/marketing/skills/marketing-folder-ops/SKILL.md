---
name: marketing-folder-ops
description: 行銷套件主題資料夾的讀寫慣例（topic.md / brief.md / copy/ / assets/ / publish.md / analytics.md）。
---
# 行銷主題資料夾慣例

每個主題是一個資料夾 `marketing/<YYYYMMDD>_<slug>/`，提示裡會給絕對路徑。

- 用 `read_file` 讀輸入，用 `write_file` **整檔覆寫**輸出；不要只回文字不寫檔。
- 檔案都是 Markdown，UTF-8；標題層級照提示給的 `##` 結構。
- `status.json` 由系統維護，不要動。
- 事實與推論分開；沒有來源就寫「待確認」，不編造價格、數字、見證。
- 寫完只回一行「已寫入 <檔名>」，不要把整份內容再貼一次。
