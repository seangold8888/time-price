// 실시간 서버 — Cloudflare Worker + Durable Object (WebSocket 휴면 API)
//  /station : 내시간역(옥상·역·찜질방) — 위치·모양만 주고받고 아무것도 저장하지 않는다.
//  /haewoo  : 해우소 — 위치·칸 번호, 근심 '카드 번호'만. 자유 글은 받지 않는다. 저장하는 건 오늘 내려간 근심 '개수' 하나뿐.
// 50명씩 '칸'으로 나눠 방송한다. 메시지가 올 때만 깨어나고, 조용하면 잠든다(무료 한도 절약).

const ROOM_CAP = 50;
const FLUSH_MS = 200;
const MAX_RATE = 12; // 초당 메시지
const ALLOW = ["https://seangold8888.github.io", "http://localhost:5178"];
const CARD_N = 60;   // 해우소 근심 카드 수

const clamp = (v, lo, hi, d) => (typeof v === "number" && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
// 월급(1분 가격)은 받지도 보내지도 않는다. 머문 시간(분)과 한숨 단계만.
function cleanStation(q, prev) {
  return {
    x: clamp(q.x, 0, 1, prev?.x ?? 0.5),
    d: clamp(q.d, 0, 1, prev?.d ?? 0.5),
    m: Math.round(clamp(q.m, 0, 1440, prev?.m ?? 0)),
    lk: Math.round(clamp(q.lk, 0, 5, prev?.lk ?? 0)),
    st: q.st === "in" ? 1 : q.st === "lie" ? 2 : 0,
    e: Math.round(clamp(q.e, 0, 3, 0)),
    sc: Math.round(clamp(q.sc, 0, 2, prev?.sc ?? 1)),   // 장소: 0 옥상, 1 역, 2 찜질방
    p: Math.round(clamp(q.p, 0, 7, prev?.p ?? 0)),       // 소품
    c: Math.round(clamp(q.c, 0, 5, prev?.c ?? 0)),       // 사원증 줄·수건 색
    k: Math.round(clamp(q.k, 0, 99, 0)),                 // 오늘 구운 계란 수
  };
}
function cleanHaewoo(q, prev) {
  return {
    x: clamp(q.x, 0, 1, prev?.x ?? 0.5),
    d: clamp(q.d, 0, 1, prev?.d ?? 0.5),
    lk: Math.round(clamp(q.lk, 0, 5, prev?.lk ?? 0)),
    st: Math.round(clamp(q.st, 0, 2, 0)),                // 0 돌아다님, 1 줄, 2 칸 안
    s: Math.round(clamp(q.s, -1, 3, -1)),                // 칸 번호
  };
}
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!["/station", "/health", "/haewoo", "/haewoo/health"].includes(p)) return new Response("not found", { status: 404 });
    if (p === "/station" || p === "/haewoo") {
      const origin = req.headers.get("Origin") || "";
      if (!ALLOW.includes(origin)) return new Response("forbidden", { status: 403 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    }
    const name = p.startsWith("/haewoo") ? "haewoo" : "main";
    const stub = env.STATION.get(env.STATION.idFromName(name));
    return stub.fetch(req);
  },
};

export class Station {
  constructor(state) {
    this.state = state;
    this.pending = new Set();
    this.timer = null;
    this.count = { day: "", n: 0 };
    state.blockConcurrencyWhile(async () => { this.count = (await state.storage.get("count")) || { day: "", n: 0 }; });
    // 브라우저의 "ping"은 객체를 깨우지 않고 바로 "pong"으로 답한다
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  today() { const d = kstDay(); if (this.count.day !== d) this.count = { day: d, n: 0 }; return this.count.n; }

  // 살아 있는 연결만. 90초 넘게 아무 소식(메시지·30초 ping) 없는 연결은 닫힌 탭으로 보고 정리한다.
  live(tag) {
    const now = Date.now();
    return this.state.getWebSockets(tag).filter(w => {
      const a = w.deserializeAttachment();
      if (!a || a.gone) return false;
      const pinged = this.state.getWebSocketAutoResponseTimestamp(w)?.getTime() || 0;
      if (now - Math.max(a.seen || a.w, pinged) > 90000) {
        a.gone = true; w.serializeAttachment(a); try { w.close(1001, "stale"); } catch {}
        return false;
      }
      return true;
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/health")) return json({ ok: true, people: this.live().length, today: this.today() });
    const kind = url.pathname === "/haewoo" ? "h" : "s";

    const counts = {};
    for (const w of this.live()) { const r = w.deserializeAttachment().r; counts[r] = (counts[r] || 0) + 1; }
    let i = 0; while ((counts["r" + i] || 0) >= ROOM_CAP) i++;
    const room = "r" + i;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.state.acceptWebSocket(server, [room]);
    server.serializeAttachment({ id, r: room, k: kind, s: null, n: 0, w: Date.now(), f: 0, gone: false });
    server.send(JSON.stringify({ t: "hi", id, room, ...(kind === "h" ? { c: this.today() } : {}) }));
    this.mark(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment();
    if (!a || typeof msg !== "string" || msg.length > 300) return;
    const now = Date.now();
    a.seen = now;
    if (now - a.w > 1000) { a.w = now; a.n = 0; }
    if (++a.n > MAX_RATE) { ws.serializeAttachment(a); return; }
    let q; try { q = JSON.parse(msg); } catch { return; }
    if (!q) return;
    if (q.t === "me") {
      a.s = a.k === "h" ? cleanHaewoo(q, a.s) : cleanStation(q, a.s);
      ws.serializeAttachment(a);
      this.mark(a.r);
      return;
    }
    // 해우소: 물 내리기. 카드 번호만 받아서 같은 칸 사람들에게 알리고, 오늘 개수 +1 (한 사람 8초에 한 번까지)
    if (q.t === "flush" && a.k === "h") {
      if (now - (a.f || 0) < 8000) { ws.serializeAttachment(a); return; }
      a.f = now; ws.serializeAttachment(a);
      this.today(); this.count.n++;
      await this.state.storage.put("count", this.count);
      const k = Number.isInteger(q.k) && q.k >= 0 && q.k < CARD_N ? q.k : -1;
      const s = Number.isInteger(q.s) && q.s >= 0 && q.s <= 3 ? q.s : -1;
      const out = JSON.stringify({ t: "ev", k, s, c: this.count.n });
      for (const w of this.live(a.r)) if (w !== ws) { try { w.send(out); } catch {} }
      this.mark(a.r);
    }
  }

  webSocketClose(ws) { this.drop(ws); }
  webSocketError(ws) { this.drop(ws); }
  drop(ws) {
    const a = ws.deserializeAttachment();
    if (a) { a.gone = true; ws.serializeAttachment(a); this.mark(a.r); }
    try { ws.close(1000, "bye"); } catch {}
  }

  mark(room) {
    this.pending.add(room);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this.timer = null;
    const total = this.live().length;
    for (const room of this.pending) {
      const socks = this.live(room);
      const list = [];
      let haewoo = false;
      for (const w of socks) {
        const a = w.deserializeAttachment(); if (!a.s) continue;
        if (a.k === "h") { haewoo = true; list.push([a.id, a.s.x, a.s.d, a.s.lk, a.s.st, a.s.s]); }
        else list.push([a.id, a.s.x, a.s.d, a.s.m, a.s.lk, a.s.st, a.s.e, a.s.sc ?? 1, a.s.p || 0, a.s.c || 0, a.s.k || 0]);
      }
      const out = JSON.stringify(haewoo ? { t: "all", n: total, c: this.today(), list } : { t: "all", n: total, list });
      for (const w of socks) { try { w.send(out); } catch {} }
    }
    this.pending.clear();
  }
}
