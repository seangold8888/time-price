// 내시간역 실시간 승강장 — Cloudflare Worker + Durable Object (WebSocket 휴면 API)
// 접속한 사람들의 위치·가격표·모양만 주고받고, 아무것도 저장하지 않는다.
// 50명씩 '칸'으로 나눠 방송한다. 메시지가 올 때만 깨어나고, 조용하면 잠든다(무료 한도 절약).

const ROOM_CAP = 50;
const FLUSH_MS = 200;
const MAX_RATE = 12; // 초당 메시지
const ALLOW = ["https://seangold8888.github.io", "http://localhost:5178"];

const clamp = (v, lo, hi, d) => (typeof v === "number" && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
// 월급(1분 가격)은 받지도 보내지도 않는다. 머문 시간(분)과 한숨 단계만.
function clean(q, prev) {
  return {
    x: clamp(q.x, 0, 1, prev?.x ?? 0.5),
    d: clamp(q.d, 0, 1, prev?.d ?? 0.5),
    m: Math.round(clamp(q.m, 0, 1440, prev?.m ?? 0)),
    lk: Math.round(clamp(q.lk, 0, 5, prev?.lk ?? 0)),
    st: q.st === "in" ? 1 : 0,
    e: Math.round(clamp(q.e, 0, 3, 0)),
  };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/station" && url.pathname !== "/health") return new Response("not found", { status: 404 });
    if (url.pathname === "/station") {
      const origin = req.headers.get("Origin") || "";
      if (!ALLOW.includes(origin)) return new Response("forbidden", { status: 403 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    }
    const stub = env.STATION.get(env.STATION.idFromName("main"));
    return stub.fetch(req);
  },
};

export class Station {
  constructor(state) {
    this.state = state;
    this.pending = new Set();
    this.timer = null;
    // 브라우저의 "ping"은 객체를 깨우지 않고 바로 "pong"으로 답한다
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

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
    if (url.pathname === "/health") return json({ ok: true, people: this.live().length });

    const counts = {};
    for (const w of this.live()) { const r = w.deserializeAttachment().r; counts[r] = (counts[r] || 0) + 1; }
    let i = 0; while ((counts["r" + i] || 0) >= ROOM_CAP) i++;
    const room = "r" + i;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.state.acceptWebSocket(server, [room]);
    server.serializeAttachment({ id, r: room, s: null, n: 0, w: Date.now(), gone: false });
    server.send(JSON.stringify({ t: "hi", id, room }));
    this.mark(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment();
    if (!a || typeof msg !== "string" || msg.length > 300) return;
    const now = Date.now();
    a.seen = now;
    if (now - a.w > 1000) { a.w = now; a.n = 0; }
    if (++a.n > MAX_RATE) { ws.serializeAttachment(a); return; }
    let q; try { q = JSON.parse(msg); } catch { return; }
    if (!q || q.t !== "me") return;
    a.s = clean(q, a.s);
    ws.serializeAttachment(a);
    this.mark(a.r);
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
      for (const w of socks) { const a = w.deserializeAttachment(); if (a.s) list.push([a.id, a.s.x, a.s.d, a.s.m, a.s.lk, a.s.st, a.s.e]); }
      const out = JSON.stringify({ t: "all", n: total, list });
      for (const w of socks) { try { w.send(out); } catch {} }
    }
    this.pending.clear();
  }
}
