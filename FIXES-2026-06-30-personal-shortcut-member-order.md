# 2026-06-30 個人日記捷徑與同行成員排序

## 修正內容

1. 單本日記捷徑改為個人捷徑：
   - 捷徑連結會帶入目前使用者的顯示名稱與專屬捷徑碼。
   - 從手機桌面開啟同一本日記時，不會再要求重新輸入名字。
   - 每位家人應各自建立自己的日記捷徑。

2. Manifest start_url 支援個人捷徑參數：
   - `trip`
   - `invite`
   - `memberName`
   - `memberKey`

3. 同行成員可調整排序：
   - 同行成員清單新增上移 / 下移箭頭。
   - 排序會儲存在日記資料裡。
   - 結算時會依照同行成員的顯示順序配對，若需要拆帳，順序會可預期。

## GitHub Desktop Summary

```text
add personal diary shortcut and member order
```
