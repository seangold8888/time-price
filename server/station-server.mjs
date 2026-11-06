// 내시간역 실시간 승강장 서버 (WebSocket)
// 실행: PORT=8787 node station-server.mjs
// 하는 일: 접속한 사람들의 위치·가격표·모양만 주고받는다. 아무것도 저장하지 않는다.
// 사람이 많으면 50명씩 '칸'(room)으로 나눠 한 화면이 너무 붐비지 않게 한다.
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const ROOM_CAP = 50;          // 한 칸 최대 인원
const TICK_MS = 200;          // 상태 방송 주기
const MAX_MSG = 300;          // 바이트
const MAX_RATE = 12;          // 초당 메시지
const ALLOW = (process.env.ALLOW_ORIGINS || "https://seangold8888.github.io,http://localhost:5178")
  .split(",").map(s => s.trim()).filter(Boolean);

const rooms = new Map(); // roomId -> Map(id -> peer)
let total = 0;

function pickRoom() {
  for (const [rid, m] of rooms) if (m.size < ROOM_CAP) return rid;
  const rid = "r" + rooms.size;
  rooms.set(rid, new Map());
  return rid;
}

const clamp = (v, lo, hi, dflt) => (typeof v === "number" && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : dflt;
function clean(q, prev) {
  return {
    x: clamp(q.x, 0, 1, prev?.x ?? 0.5),
    d: clamp(q.d, 0, 1, prev?.d ?? 0.5),
    p: Math.round(clamp(q.p, 1, 100000, prev?.p ?? 172)),
    lk: Math.round(clamp(q.lk, 0, 5, prev?.lk ?? 0)),
    st: q.st === "in" ? "in" : "wait",
  };
}

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true, people: total, rooms: rooms.size }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server: http, path: "/station", maxPayload: MAX_MSG });

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin || "";
  if (ALLOW.length && !ALLOW.includes(origin)) { ws.close(1008, "origin"); return; }
  const id = randomBytes(6).toString("hex");
  const rid = pickRoom();
  const room = rooms.get(rid);
  const peer = { id, ws, s: clean({}), seen: false, n: 0, win: Date.now() };
  room.set(id, peer); total++;
  ws.send(JSON.stringify({ t: "hi", id, room: rid }));

  ws.on("message", buf => {
    const now = Date.now();
    if (now - peer.win > 1000) { peer.win = now; peer.n = 0; }
    if (++peer.n > MAX_RATE) return;           // 너무 빠르면 버림
    let q; try { q = JSON.parse(buf.toString()); } catch { return; }
    if (!q || typeof q !== "object" || q.t !== "me") return;
    peer.s = clean(q, peer.s); peer.seen = true; room.dirty = true;
  });
  ws.on("close", () => { room.delete(id); total--; room.dirty = true; if (!room.size && rid !== "r0") rooms.delete(rid); });
  ws.on("error", () => {});
});

// 칸마다 모두의 상태를 한 번에 보낸다 (바뀐 칸만)
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.dirty) continue;
    room.dirty = false;
    const list = [];
    for (const p of room.values()) if (p.seen) list.push([p.id, p.s.x, p.s.d, p.s.p, p.s.lk, p.s.st === "in" ? 1 : 0]);
    const msg = JSON.stringify({ t: "all", n: total, list });
    for (const p of room.values()) if (p.ws.readyState === 1) p.ws.send(msg);
  }
}, TICK_MS);

// 끊긴 연결 정리
setInterval(() => { for (const ws of wss.clients) { if (ws.alive === false) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 30000);
wss.on("connection", ws => { ws.alive = true; ws.on("pong", () => { ws.alive = true; }); });

http.listen(PORT, () => console.log(`내시간역 서버 :${PORT}`));
