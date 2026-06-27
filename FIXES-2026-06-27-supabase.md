# 2026-06-27 Supabase 儲存版

這版把日記與照片改成可使用 Supabase 免費方案保存，適合「Render Free 跑服務 + Supabase Free 存資料」。

## 改動

1. 新增 Supabase 儲存後端：
   - `STORAGE_BACKEND=supabase`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_STATE_TABLE=xuebot_state`
   - `SUPABASE_STATE_ID=default`
   - `SUPABASE_STORAGE_BUCKET=xuebot-photos`
2. 日記資料改可存到 Supabase Postgres 的 `xuebot_state` 表格。
3. 封面照與行程照片改可存到 Supabase Storage 的 `xuebot-photos` bucket。
4. 沒有設定 Supabase 時，仍會退回本機 `data/trips.json`，方便本機測試。
5. `/health` 會回傳目前儲存模式：`storage: "supabase"` 或 `storage: "json"`。
6. README 補上 Supabase SQL 與 Render 環境變數設定。

## Supabase SQL

在 Supabase SQL Editor 執行：

```sql
create table if not exists public.xuebot_state (
  id text primary key,
  data jsonb not null default '{"version":3,"trips":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.xuebot_state enable row level security;

insert into public.xuebot_state (id, data)
values ('default', '{"version":3,"trips":[]}'::jsonb)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('xuebot-photos', 'xuebot-photos', true)
on conflict (id) do update set public = true;
```

## Render 環境變數

```text
STORAGE_BACKEND=supabase
SUPABASE_URL=https://你的-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=你的 service_role key
SUPABASE_STATE_TABLE=xuebot_state
SUPABASE_STATE_ID=default
SUPABASE_STORAGE_BUCKET=xuebot-photos
```

`SUPABASE_SERVICE_ROLE_KEY` 只能放 Render Environment，不要放 GitHub。
