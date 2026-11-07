// 대시보드 에디터로 배포할 때: Edge Functions → Deploy a new function → Via Editor
//   이름 generate-ai-summary, 이 파일 전체를 붙여넣고 Deploy → 함수 설정에서 'Verify JWT' 끄기
//   🔑 비밀 키는 코드에 쓰지 말고 Edge Functions → Secrets에 GEMINI_API_KEY, WEBHOOK_SECRET 이름으로 넣기
// 수정할 때마다 다시 배포: supabase functions deploy generate-ai-summary --no-verify-jwt
//   (브라우저는 JWT가 아닌 publishable 키(sb_publishable_...)를 쓰므로 JWT 검사를 끔. 웹훅은 x-webhook-secret으로 확인)
// 비밀값: supabase secrets set WEBHOOK_SECRET=<임의의 긴 문자열> GEMINI_API_KEY=<Gemini API 키>
//   (선택) GEMINI_MODEL=<모델 이름>  기본값 gemini-2.5-flash-lite (무료 한도가 있는 모델 중 가장 쌈)
//   프로젝트에서 legacy 키를 껐다면 supabase secrets set SERVICE_KEY=<sb_secret_... 키> 도 설정
// AI 요약은 태블릿이 아니라 DB 저장 뒤 여기서 만듦. Database Webhook 설정:
//   Supabase Dashboard → Database → Webhooks → Create a new hook
//   1. Table: surveys / Events: Insert
//   2. Type: Supabase Edge Functions → generate-ai-summary (Method: POST)
//   3. HTTP Headers: Authorization(서비스 키, 'Add auth header with service key')은 그대로 두고
//      x-webhook-secret: <WEBHOOK_SECRET과 같은 값> 추가
//   4. Timeout: 5000ms 권장 (기본 1000ms는 함수가 처음 켜질 때 넘길 수 있음)
//   요약이 계속 안 채워지면 함수 로그나 net._http_response에서 401 Invalid JWT인지 확인:
//   Authorization에 legacy service_role JWT를 넣거나 --no-verify-jwt로 배포 (웹훅은 x-webhook-secret으로 확인함)
//   웹훅을 만들기 전에 저장된 기록은 요약이 채워지지 않음 (ai_summary가 비어 있는 행은 대시보드에서 직접 확인)
// step4_allergy.html의 음성 알레르기 추출(mode: 'allergy_extract')도 이 함수가 처리함
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 아무 글이나 AI에 넘기는 통로가 되지 않도록 정해진 두 가지 요청(웹훅 요약·음성 알레르기 추출)만, 크기를 제한해서 받음
const MAX_BODY_BYTES = 32 * 1024
const MAX_ENTRIES = 10
const MAX_ENTRIES_BYTES = 20 * 1024
const MAX_TRANSCRIPT_CHARS = 300
const MAX_FIELD_CHARS = 100
const MAX_TOKENS = 4096   // 최신 Flash 모델은 답하기 전 생각(thinking)에도 토큰을 써서 넉넉히 둠
const UPSTREAM_TIMEOUT_MS = 14000
const DB_TIMEOUT_MS = 10000
const LANGS = ['ko', 'en', 'zh', 'ru', 'vi', 'ja', 'tl', 'km', 'th', 'mn', 'uz', 'ar']

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Obj : {}
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).slice(0, MAX_FIELD_CHARS)
const byteLength = (s: string): number => new TextEncoder().encode(s).length

function json(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(body),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status },
  )
}

// 학생 기록을 줄글로 (AI 프롬프트와 기본 요약에 같이 씀)
function describeEntries(entries: unknown[]): { symptomsText: string, allergyText: string, medicationText: string } {
  const symptomsText = entries.map((item, i) => {
    const e = obj(item)
    const painLevels = obj(e.painLevels)
    const startTimes = obj(e.startTimes)
    const traumaCauses = obj(e.traumaCauses)
    const symptomParts = list(e.symptoms).map(sym => {
      const s = String(sym)
      const p = painLevels[s] ? painLevels[s] : (e.painLevel || 0)
      const t = startTimes[s] ? startTimes[s] : (e.startTime || "모름")
      const tc = traumaCauses[s] ? `, 원인:${str(traumaCauses[s])}` : ''
      return `${str(s)}(통증:${str(p)}/10, 발현:${str(t)}${tc})`
    })
    const sText = symptomParts.join(', ')
    const followupText = list(e.followups).map(f => str(obj(f).q) + ' ' + str(obj(f).a)).join(', ')
    return `[증상 ${i+1}] 부위: ${str(e.part)} ${str(e.partLabel || e.bellyPos || '')}, 증상 및 상태: ${sText}, 기타: ${followupText}`
  }).join('\n')

  const first = obj(entries[0])

  let allergyText = ""
  const allergies = list(first.allergies).filter((a): a is string => typeof a === 'string')
  if (allergies.length > 0 && !allergies.includes('allergy_none')) {
    const allergyMap: Record<string, string> = { "allergy_drug": "약", "allergy_peanut": "땅콩/견과류", "allergy_milk": "우유", "allergy_egg": "계란", "allergy_seafood": "해산물", "allergy_peach": "복숭아", "allergy_wheat": "밀가루", "allergy_idk": "잘 모르겠음(확인 필요)" }
    allergyText = `\n[알레르기 정보]: ${allergies.map(a => str(a.startsWith('custom_') ? a.substring(7) : (allergyMap[a] || a))).join(', ')}`
  }

  let medicationText = ""
  const medications = list(first.medications).filter((m): m is string => typeof m === 'string')
  if (medications.length > 0 && !medications.includes('med_none')) {
    const medMap: Record<string, string> = { "med_cold": "감기약", "med_pain": "진통제", "med_digest": "소화제", "med_hospital": "병원/처방약", "med_idk": "잘 모르겠음" }
    medicationText = `\n[복용 중인 약]: ${medications.map(m => str(medMap[m] || m)).join(', ')}`
  }

  return { symptomsText, allergyText, medicationText }
}

// 보건실 요약 프롬프트 (db.js에서 만들던 문구 그대로)
function buildSummaryPrompt(entries: unknown[]): string {
  const { symptomsText, allergyText, medicationText } = describeEntries(entries)
  // 과거 방문 기록은 AI 요약에 넣지 않습니다.
  // 이름을 받지 않으면 학년·반·번호만으로는 같은 학생인지 알 수 없어(다른 학교·작년 학생과 섞임) 연결 기능을 뺐습니다.
  return `학생이 선택한 다음 증상들을 바탕으로, 보건 교사가 한눈에 파악할 수 있는 한국어 요약 문장을 2~3줄로 작성해. 병명을 진단하지 말고 의심 조합 규칙에만 기반하여 사실적으로 작성해.${allergyText}${medicationText}\n${symptomsText}`
}

// AI가 실패했을 때 저장할 기본 요약 (예전 db.js의 기본 요약과 같은 줄 구성)
function buildFallbackSummary(entries: unknown[]): string {
  const { symptomsText, allergyText, medicationText } = describeEntries(entries)
  return `[기본 요약(AI 오류)]\n${symptomsText}${allergyText}${medicationText}`
}

// 음성 알레르기 추출 프롬프트 (step4_allergy.html에서 만들던 문구 그대로, 학생 말은 JSON 문자열 데이터로만 넣음)
function buildAllergyPrompt(transcript: string, lang: string): string {
  return `너는 학생의 말을 듣고 알레르기 원인 물질을 추출 및 번역하는 의료 어시스턴트야.
현재 학생이 사용하는 언어는 ${lang}야.
[규칙]
1. 학생의 음성 인식 결과에서 알레르기 원인 물질을 추출해.
2. 추출된 단어를 학생이 읽을 수 있는 'native'와 보건교사가 읽을 'ko'(한국어) 두 가지 버전으로 작성해.
3. 주의: 만약 학생의 언어(${lang})가 'ko'라면 'native'에도 억지로 외국어로 번역하지 말고 한국어 단어 그대로 똑같이 적어!
4. 반드시 아래와 같은 순수 JSON 배열(Array of Objects) 형태로만 반환해! 다른 말은 절대 쓰지 마. 알레르기 원인이 없으면 빈 배열 [] 반환.
[출력 예시]
- 학생 언어가 'ru'일 때: [{"native": "креветки", "ko": "새우"}]
- 학생 언어가 'ko'일 때: [{"native": "새우", "ko": "새우"}]
학생 말(데이터): ${JSON.stringify(transcript)}`
}

type AIResult = { content: string } | { error: string, status: number }

// AI 호출 (키 없음·시간 초과·네트워크 오류는 throw)
async function callAI(promptText: string): Promise<AIResult> {
  // 🔑 Secrets의 GEMINI_API_KEY (Google AI Studio에서 받은 Gemini API 키)
  const apiKey = Deno.env.get('GEMINI_API_KEY')
  // 모델 이름은 코드 수정 없이 GEMINI_MODEL 비밀값으로 바꿀 수 있음
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash-lite'

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing in environment variables.')
  }

  // Gemini의 OpenAI 호환 주소 (요청·응답 형식이 chat/completions와 같음)
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: promptText }],
      max_tokens: MAX_TOKENS
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  })

  // AI 서버 오류는 상태 코드만 그대로 전달 (응답 내용은 넘기지 않음)
  if (!response.ok) {
    console.error('Upstream error:', response.status)
    await response.body?.cancel()
    return { error: 'ai_error', status: response.status }
  }

  const data = await response.json().catch(() => null)
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    console.error('Upstream returned empty content')
    return { error: 'ai_empty', status: 502 }
  }
  return { content }
}

// 요약을 만들어 그 행에 저장 (오류는 서버 로그에만 남기고 throw하지 않음)
async function summarizeAndSave(id: string, entries: unknown[]): Promise<boolean> {
  try {
    let summary = ''
    try {
      // 예전 클라이언트 요청 때와 같은 입력 제한 (넘으면 AI 없이 기본 요약)
      if (entries.length === 0 || entries.length > MAX_ENTRIES || byteLength(JSON.stringify(entries)) > MAX_ENTRIES_BYTES) {
        throw new Error('bad_entries')
      }
      const ai = await callAI(buildSummaryPrompt(entries))
      if ('content' in ai) summary = ai.content
    } catch (error) {
      console.error('summary AI error:', error instanceof Error ? error.message : String(error))
    }
    // AI 실패·빈 응답이면 기본 요약 (비워 두면 대시보드에 계속 '생성 중'으로 보임)
    if (!summary) summary = buildFallbackSummary(entries.slice(0, MAX_ENTRIES))

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    // 새 형식 비밀 키(sb_secret_...)를 SERVICE_KEY로 넣었으면 그걸 쓰고, 없으면 기본 service_role 키
    const serviceKey = Deno.env.get('SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL / SERVICE_KEY(SUPABASE_SERVICE_ROLE_KEY) is missing.')

    // sb_ 로 시작하는 새 키는 JWT가 아니라 apikey 헤더로만 보냄
    const authHeaders: Record<string, string> = serviceKey.startsWith('sb_')
      ? { 'apikey': serviceKey }
      : { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
    const res = await fetch(`${supabaseUrl}/rest/v1/surveys?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ ai_summary: summary }),
      signal: AbortSignal.timeout(DB_TIMEOUT_MS)
    })
    if (!res.ok) {
      console.error('ai_summary update failed:', res.status, await res.text().catch(() => ''))
      return false
    }
    await res.body?.cancel()
    return true
  } catch (error) {
    console.error('summarizeAndSave error:', error instanceof Error ? error.message : String(error))
    return false
  }
}

// Database Webhook: surveys에 기록이 저장되면 AI 요약을 만들어 그 행에 채움
async function handleWebhook(req: Request): Promise<Response> {
  // 🔑 Secrets의 WEBHOOK_SECRET (Database Webhook 헤더 x-webhook-secret에도 같은 값)
  const secret = Deno.env.get('WEBHOOK_SECRET')
  // 비밀값이 설정되지 않았거나 다르면 거부 (db.js에 있는 anon 키만으로는 호출 못 하게)
  if (!secret || req.headers.get('x-webhook-secret') !== secret) {
    await req.body?.cancel()
    return json({ error: 'unauthorized' }, 401)
  }

  let body: Obj
  try {
    body = obj(JSON.parse(await req.text()))
  } catch (_) {
    return json({ error: 'bad_request' }, 400)
  }
  const record = obj(body.record)

  // INSERT가 아니거나 다른 테이블, 이미 AI 요약이 있는 기록(예전 큐에서 온 기록)은 그냥 넘김
  // 예전 태블릿이 만든 '[기본 요약(...)]'은 진짜 요약이 아니므로 다시 만듦
  const existing = typeof record.ai_summary === 'string' ? record.ai_summary.trim() : ''
  if (body.type !== 'INSERT' || body.table !== 'surveys' ||
      (existing && !existing.startsWith('[기본 요약'))) {
    return json({ ok: true, skipped: true })
  }
  if (record.id === null || record.id === undefined || record.id === '') {
    console.error('webhook record without id')
    return json({ error: 'no_id' }, 400)
  }

  const work = summarizeAndSave(String(record.id), list(record.entries_json))
  // AI가 웹훅 대기 시간(대시보드 기본 1초)보다 오래 걸리므로, 가능하면 바로 응답하고 백그라운드에서 마저 저장
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
  if (edgeRuntime && typeof edgeRuntime.waitUntil === 'function') {
    edgeRuntime.waitUntil(work)
    return json({ ok: true })
  }
  return json({ ok: await work })
}

serve(async (req) => {
  // CORS Preflight 처리
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Database Webhook 요청 (x-webhook-secret 헤더로 구분)
    if (req.headers.has('x-webhook-secret')) return await handleWebhook(req)

    const raw = await req.text()
    if (byteLength(raw) > MAX_BODY_BYTES) return json({ error: 'too_large' }, 400)
    let body: Obj
    try {
      body = obj(JSON.parse(raw))
    } catch (_) {
      return json({ error: 'bad_request' }, 400)
    }

    // 브라우저에서는 음성 알레르기 추출만 받음 (프롬프트는 서버에서만 만듦)
    if (body.mode !== 'allergy_extract') {
      // 헤더 없이 온 웹훅 형식 요청은 인증 실패
      return body.record !== undefined ? json({ error: 'unauthorized' }, 401) : json({ error: 'unknown_mode' }, 400)
    }
    const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : ''
    if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARS) {
      return json({ error: 'bad_transcript' }, 400)
    }
    const reqLang = body.lang
    const lang = typeof reqLang === 'string' && LANGS.includes(reqLang) ? reqLang : 'ko'

    const ai = await callAI(buildAllergyPrompt(transcript, lang))
    if ('error' in ai) return json({ error: ai.error }, ai.status)

    // 호출하는 쪽이 읽는 형식(choices[0].message.content)만 돌려줌
    return json({ choices: [{ message: { content: ai.content } }] })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('generate-ai-summary error:', message)
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return json({ error: timedOut ? 'ai_timeout' : 'internal_error' }, timedOut ? 504 : 500)
  }
})
