# 2026-06-28：補上釜山附近景點推薦

## 修正

- `src/recommendations.js` 新增釜山 / Busan / 부산 / 海雲台 / 廣安里 / 西面 / 南浦 / 甘川等關鍵字匹配。
- 當日記地區輸入「釜山」「韓國釜山」「Busan」「부산」時，附近景點會回傳釜山推薦資料，而不是通用 fallback。
- 補上釜山景點、餐飲與行程路線建議。
- 地區匹配改成大小寫不敏感，英文 `busan` / `Busan` 都可辨識。

## 驗證

```bash
node --check src/recommendations.js
```

並以 `釜山`、`韓國釜山`、`Busan`、`부산`、`海雲台` 測試，皆回傳 `key: busan`。
