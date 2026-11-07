-- 그림 터치 문진표: surveys 테이블과 권한
-- Supabase Dashboard → SQL Editor에 전체를 붙여넣고 Run (여러 번 실행해도 안전)
--
-- 권한 요약
--   학생 태블릿(anon, publishable 키): 문진 기록 넣기만 가능, 읽기·수정·삭제 불가
--   보건교사(로그인 + nurses 표에 등록): 읽기, 확인 완료(is_resolved)만 수정
--   Edge Function(service role): AI 요약(ai_summary) 채우기

-- 1. 문진 기록 (방문 1번 = 1줄)
create table if not exists public.surveys (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  lang            text,
  grade           text,
  class_num       text,
  student_num     text,
  entries_json    jsonb not null default '[]'::jsonb,
  emergency_flags jsonb not null default '[]'::jsonb,
  ai_summary      text,                                  -- 저장 뒤 Edge Function이 채움
  is_resolved     boolean not null default false,
  constraint surveys_entries_is_array check (jsonb_typeof(entries_json) = 'array'),
  constraint surveys_flags_is_array   check (jsonb_typeof(emergency_flags) = 'array'),
  constraint surveys_entries_size     check (pg_column_size(entries_json) < 65536),
  constraint surveys_summary_size     check (ai_summary is null or length(ai_summary) <= 8000),
  constraint surveys_short_text check (
    coalesce(length(lang), 0) <= 10 and coalesce(length(grade), 0) <= 10 and
    coalesce(length(class_num), 0) <= 10 and coalesce(length(student_num), 0) <= 10
  )
);

-- 대시보드는 확인 안 된 기록을 최근 순으로 읽음
create index if not exists surveys_unresolved_idx
  on public.surveys (created_at desc) where is_resolved = false;

-- 2. 보건교사 명단 (여기 등록된 로그인 계정만 기록을 읽을 수 있음)
create table if not exists public.nurses (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.nurses enable row level security;     -- 정책 없음 = 브라우저에서 읽기·쓰기 불가
revoke all on table public.nurses from anon, authenticated;

create or replace function public.is_nurse()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.nurses where user_id = auth.uid());
$$;
revoke all on function public.is_nurse() from public, anon;
grant execute on function public.is_nurse() to authenticated;

-- 3. surveys 권한 (컬럼 단위로 필요한 것만 허용)
alter table public.surveys enable row level security;

revoke all on table public.surveys from anon, authenticated;
grant insert (lang, grade, class_num, student_num, entries_json, emergency_flags, created_at, ai_summary, is_resolved)
  on table public.surveys to anon, authenticated;
grant select on table public.surveys to authenticated;
grant update (is_resolved) on table public.surveys to authenticated;

drop policy if exists "students insert" on public.surveys;
create policy "students insert" on public.surveys
  for insert to anon, authenticated
  with check (is_resolved = false);

drop policy if exists "nurses read" on public.surveys;
create policy "nurses read" on public.surveys
  for select to authenticated
  using ((select public.is_nurse()));

drop policy if exists "nurses resolve" on public.surveys;
create policy "nurses resolve" on public.surveys
  for update to authenticated
  using ((select public.is_nurse()))
  with check ((select public.is_nurse()));

-- 4. 실시간 알림 (새 기록·확인 완료가 대시보드에 바로 반영)
do $$
begin
  alter publication supabase_realtime add table public.surveys;
exception when duplicate_object then null;
end $$;

-- 5. 보건교사 계정 등록
--    Authentication → Users → Add user 로 계정을 만든 뒤, 아래 이메일을 바꿔서 따로 실행
-- insert into public.nurses (user_id)
--   select id from auth.users where email = 'nurse@example.com'
--   on conflict do nothing;

-- 6. (선택) 보관 기간: Database → Extensions에서 pg_cron을 켠 뒤 실행하면 180일 지난 기록을 매일 새벽 3시(한국 시간) 삭제
--    pg_cron은 UTC 기준이라 '0 18 * * *' = 한국 시간 03:00
-- select cron.schedule('surveys-retention', '0 18 * * *',
--   $$delete from public.surveys where created_at < now() - interval '180 days'$$);

-- 7. AI 요약 (SQL이 아니라 대시보드에서): 새 프로젝트에는 함수·비밀값·웹훅이 따로 있어야 함
--    Edge Functions → generate-ai-summary 배포 (Verify JWT 끄기)
--    Edge Functions → Secrets: GEMINI_API_KEY, WEBHOOK_SECRET (legacy 키를 껐으면 SERVICE_KEY도)
--    Database → Webhooks: surveys / Insert → generate-ai-summary, 헤더 x-webhook-secret = WEBHOOK_SECRET 값, Timeout 5000ms
