// 내 시간의 가격 — 가격표 갱신 스크립트
// 실행: node update-prices.mjs
// 자동 갱신: 서울 아파트 평균 매매가(KB 주간), 서울 짜장면 평균(참가격 월간)
// 나머지 항목은 공식 발표가 날 때만 바뀌므로 prices.json을 직접 고치고 checked 날짜를 올린다.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "prices.json");
const UA = { "User-Agent": "Mozilla/5.0 (time-price updater)" };
const STALE_DAYS = 90;

const today = new Date();
const ymd = d => d.toISOString().slice(0, 10);

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// KB 주간 아파트 매매 평균가격 (서울). 단위: 만원
async function kbSeoulApt() {
  const base = "https://data-api.kbland.kr/bfmstat";
  const dte = await getJson(`${base}/cmm/dteInfo`);
  const end = dte?.dataBody?.data?.["종료년월일"];
  if (!/^\d{8}$/.test(end || "")) throw new Error("KB 기준일을 못 읽음");
  const q = new URLSearchParams({ "기준년월일": end, "법정동코드": "0000000000" });
  const j = await getJson(`${base}/statusBoard/weeklyAptPrice?${q}`);
  const rows = j?.dataBody?.data?.["주간 매매가격"] || [];
  const seoul = rows.find(r => r["법정동코드"] === "1100000000");
  if (!seoul) throw new Error("KB 서울 행 없음");
  const man = Number(seoul["현재데이터"]);
  if (!(man > 10000 && man < 1000000)) throw new Error(`KB 값 이상: ${man}`);
  const price = Math.round(man) * 10000;
  const asof = `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6)}`;
  return { price, asof, src: `평균 매매가, KB ${end.slice(2, 4)}년 ${+end.slice(4, 6)}월 ${+end.slice(6)}일` };
}

// 한국소비자원 참가격 외식비 (서울 자장면). 기본 조회가 최신 월
async function chamPriceJjajang() {
  const url = "https://www.price.go.kr/tprice/portal/servicepriceinfo/dineoutprice/dineOutPriceList.do";
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`참가격 HTTP ${r.status}`);
  const html = await r.text();
  const year = html.match(/<option value="(\d{4})" selected>/)?.[1];
  const month = html.match(/name="searchMonth"[\s\S]*?<option value="(\d{2})" selected>/)?.[1];
  // 표 머리: 지역 | 냉면 | 비빔밥 | 김치찌개백반 | 삼겹살 환산전 | 삼겹살 환산후 | 자장면 | 삼계탕 | 칼국수 | 김밥
  const row = html.match(/<td>서울<\/td>([\s\S]*?)<\/tr>/)?.[1];
  if (!year || !month || !row) throw new Error("참가격 표를 못 읽음");
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map(m => Number(m[1].replace(/<[^>]+>/g, "").replace(/[^\d]/g, "")));
  if (cells.length < 9) throw new Error(`참가격 칸 수 이상: ${cells.length}`);
  const price = cells[5];
  if (!(price > 3000 && price < 30000)) throw new Error(`자장면 값 이상: ${price}`);
  return { price, asof: `${year}-${month}`, src: `서울 평균, 참가격 ${year.slice(2)}년 ${+month}월` };
}

const AUTO = { "seoul-apt": kbSeoulApt, jjajang: chamPriceJjajang };

const data = JSON.parse(await readFile(FILE, "utf8"));
let changed = 0, failed = 0;
for (const it of data.items) {
  const fn = AUTO[it.id];
  if (!fn) {
    const age = (today - new Date(it.checked)) / 86400000;
    if (age > STALE_DAYS) console.warn(`⚠ ${it.name}: ${Math.floor(age)}일 전 확인 — 직접 다시 확인 필요`);
    continue;
  }
  try {
    const v = await fn();
    const before = it.price;
    if (before !== v.price || it.asof !== v.asof) {
      Object.assign(it, v, { checked: ymd(today) });
      changed++;
    }
    console.log(`✓ ${it.name}: ${before.toLocaleString()} → ${v.price.toLocaleString()}원 (${v.asof})`);
  } catch (e) {
    failed++;
    console.error(`✗ ${it.name}: ${e.message} — 기존 값 유지`);
  }
}
// 새 데이터가 있을 때만 파일을 고친다 (날짜만 바뀌는 빈 커밋 방지)
if (changed) {
  data.updated = ymd(today);
  await writeFile(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}
console.log(`새 데이터 ${changed}개, 실패 ${failed}개.${changed ? " prices.json 저장." : " 파일 그대로."}`);
if (failed) process.exitCode = 1;
