# 2026-06-28 LINE 匯入顯示名稱修正

這版修正從 LINE 聊天室丟行程、由機器人整理成日記時，新增者顯示為「LINE 使用者」的問題。

## 修正內容

- LINE webhook 收到訊息時，會用 LINE Messaging API 依來源抓取傳訊者的 displayName。
- 個人聊天室使用 `/v2/bot/profile/{userId}`。
- 群組使用 `/v2/bot/group/{groupId}/member/{userId}`。
- 聊天室使用 `/v2/bot/room/{roomId}/member/{userId}`。
- 抓不到名稱時仍可正常運作，不會中斷機器人回覆。
- 匯入行程、建立日記、AI 整理行程時，createdBy / updatedBy 會優先寫入 LINE 暱稱。
- 當某位成員後來取得真正顯示名稱時，會自動把同一個 LINE userId 之前留下的「LINE 使用者」「guest」「尚未設定名稱」等技術名稱更新成較友善的顯示名稱。

## 注意

- 這只會影響新版部署後的 LINE 匯入流程。
- 舊資料如果同一個 LINE userId 後續有修改、加入或新增動作，會順便被修正顯示名稱。
- 前端仍保留「手動設定顯示名稱」功能，方便家人使用媽媽、爸爸、小慈、阿嬤等稱呼。
