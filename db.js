// Supabase 설정
const supabaseUrl = 'https://rvevkkrubpecxfgjmsoj.supabase.co';
const supabaseKey = 'sb_publishable_4dM_R8kkT4RmG4eIJ-FyUw_YYTGhGP3';

// Supabase 클라이언트 초기화 (CDN 스크립트를 못 불러왔으면 null)
const db = window.supabase ? window.supabase.createClient(supabaseUrl, supabaseKey) : null;

// 로컬 큐 읽기 (처리 중에도 step5에서 새 기록이 추가될 수 있어 쓰기 직전마다 새로 읽음)
function readQueue() {
  try {
    const q = JSON.parse(localStorage.getItem('sync_queue') || '[]');
    return Array.isArray(q) ? q.filter(r => r && typeof r === 'object') : [];
  } catch (e) {
    return [];
  }
}

// 기록 구분용 키: step5에서 만든 local_id (예전 기록은 created_at)
function queueKey(r) {
  return r.local_id || r.created_at;
}

// 해당 기록만 큐에서 제거
function removeFromQueue(key) {
  localStorage.setItem('sync_queue', JSON.stringify(readQueue().filter(r => queueKey(r) !== key)));
}

// 다시 보내도 계속 실패할 기록은 'sync_dead'로 옮겨 보관 (지우지 않음)
function moveToDead(key, reason) {
  const q = readQueue();
  const rec = q.find(r => queueKey(r) === key);
  if (!rec) return;
  let dead;
  try {
    dead = JSON.parse(localStorage.getItem('sync_dead') || '[]');
  } catch (e) {
    dead = null;
  }
  if (!Array.isArray(dead)) return; // 보관함이 깨져 있으면 옮기지 않고 큐에 그대로 둠
  rec.sync_error = reason;
  dead.push(rec);
  localStorage.setItem('sync_dead', JSON.stringify(dead));
  localStorage.setItem('sync_queue', JSON.stringify(q.filter(r => queueKey(r) !== key)));
}

// 네트워크 끊김(0)·서버 오류(5xx)·시간 초과(408)·요청 과다(429)는 나중에 재시도.
// 키·권한(401/403)·테이블 없음(404)·컬럼 없음(PGRST204)·필수 컬럼 비어 있음(23502, 예: ai_summary가 NOT NULL) 같은
// 설정 문제도 모든 기록에 똑같이 생기므로 재시도 (설정을 고치면 다시 보내짐). 그 기록만의 문제(값 형식 오류 등)일 때만 'sync_dead'로 옮김
function isPermanentError(status, code) {
  if (!status || status >= 500 || [401, 403, 404, 408, 429].includes(status)) return false;
  if (['PGRST204', 'PGRST205', '42501', '42P01', '23502'].includes(code)) return false;
  return status >= 400;
}

// 백그라운드 동기화 큐 처리
async function processSyncQueue() {
  if (!db) return;
  // 시작할 때 있던 기록만 차례로 처리 (도중에 추가된 기록은 다음 실행 때 처리)
  const keys = readQueue().map(queueKey);
  if (keys.length === 0) return;
  console.log("processSyncQueue: queue length = ", keys.length);

  for (const key of keys) {
    // 매번 새로 읽음 (다른 탭·이전 실행에서 이미 보냈으면 건너뜀)
    const record = readQueue().find(r => queueKey(r) === key);
    if (!record) continue;
    console.log("processSyncQueue: processing record");

    // 레거시 호환성: 로컬 스토리지에 남아있는 구버전 큐 데이터 정리 (서버 AI 요약이 entries_json[0].allergies를 읽음)
    if (record.allergies !== undefined) {
      if (record.entries_json && record.entries_json.length > 0) {
        record.entries_json[0].allergies = record.allergies;
      }
      delete record.allergies;
    }
    delete record.student_name; // 이름은 더 이상 받지 않음 (구버전 기록에만 남아 있음)
    if (record.is_resolved === undefined) record.is_resolved = false;

    // DB에 저장 (local_id·sync_error는 surveys 컬럼이 아니므로 빼고 보냄)
    // AI 요약은 저장 뒤 서버(Database Webhook → generate-ai-summary)가 채움. 예전 큐 기록에 ai_summary가 있으면 그대로 보냄
    const { local_id, sync_error, ...row } = record;
    let res;
    try {
      console.log("processSyncQueue: inserting into DB");
      res = await db.from('surveys').insert([row]);
    } catch (e) {
      console.error("Supabase Sync Failed, will retry later:", e.message);
      break; // 실패 시 루프 중단 (다음에 다시 시도)
    }

    if (!res.error) {
      console.log("processSyncQueue: DB insert success");
      // DB 저장 성공 시 큐를 새로 읽어 이 기록만 제거 (처리 중에 추가된 기록이 지워지지 않게)
      removeFromQueue(key);
      continue;
    }

    console.error("Supabase Sync Failed:", res.status, res.error.code, res.error.message);
    if (isPermanentError(res.status, res.error.code)) {
      // 이 기록이 계속 실패해 뒤 기록까지 막지 않도록 'sync_dead'로 옮기고 다음 기록 진행
      moveToDead(key, `${res.status} ${res.error.code || ''} ${res.error.message || ''}`);
      continue;
    }
    break; // 네트워크·서버 오류: 나중에 다시 시도
  }
}

// 같은 탭에서 겹쳐 실행되지 않게, 다른 탭이 처리 중이면 건너뜀
let isSyncing = false;
async function runSync() {
  if (isSyncing || !db) return;
  isSyncing = true;
  try {
    if (navigator.locks) {
      await navigator.locks.request('sync_queue', { ifAvailable: true }, lock => lock ? processSyncQueue() : null);
    } else {
      await processSyncQueue();
    }
  } catch (e) {
    console.error("processSyncQueue error:", e.message);
  } finally {
    isSyncing = false;
  }
}

// 스크립트 로드 시 자동으로 큐 처리 시작, 네트워크가 돌아오면·1분마다 다시 시도
document.addEventListener('DOMContentLoaded', runSync);
window.addEventListener('online', runSync);
setInterval(runSync, 60000);
