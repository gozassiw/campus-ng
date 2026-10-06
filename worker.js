import { DurableObject } from "cloudflare:workers";
import GAME_HTML from "./index.html";

/*
  Campus NG multiplayer server.
  One Durable Object per university campus (and per shard when a campus fills up).
  Clients send:   { t:"p", p:{...presence} }   and   { t:"c", s:"chat text" }
  Server sends:   hello (your id, players, recent chat), p (someone moved), l (someone left), c (chat), full
*/
const MAX_PER_ROOM = 60;
const CHAT_KEEP = 40;
const BAD = /\b(fuck|shit|bitch|cunt|dick|pussy|asshole|nigga|nigger|whore)\b/gi;

function cleanText(t, max) {
  return String(t || "")
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, max)
    .replace(BAD, w => w[0] + "***");
}
function num(v, a, b, d) { v = +v; return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; }
function cleanPresence(p) {
  if (!p || typeof p !== "object") return null;
  const k = Array.isArray(p.k) ? p.k.slice(0, 6).map(x => num(x, 0, 9, 0) | 0) : [];
  return {
    n: cleanText(p.n, 16) || "Student",
    x: num(p.x, -80, 700, 0), z: num(p.z, -80, 700, 0), r: num(p.r, -20, 20, 0),
    m: p.m ? 1 : 0, k, p: p.p === "play" ? "play" : "menu",
    u: cleanText(p.u, 12), i: cleanText(p.i, 12), v: ["car","keke","okada","danfo"].includes(p.v) ? p.v : ""
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const uni = (url.searchParams.get("uni") || "unilag").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "unilag";
      const shard = Math.max(1, Math.min(200, parseInt(url.searchParams.get("s") || "1", 10) || 1));
      const stub = env.ROOMS.get(env.ROOMS.idFromName(uni + ":" + shard));
      return stub.fetch(request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(GAME_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    return new Response("Not found", { status: 404 });
  }
};

export class CampusRoom extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const sockets = this.ctx.getWebSockets();
    this.ctx.acceptWebSocket(server);
    if (sockets.length >= MAX_PER_ROOM) {
      server.send(JSON.stringify({ t: "full" }));
      server.close(1013, "Room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = crypto.randomUUID().slice(0, 8);
    server.serializeAttachment({ id, p: null, last: 0, chatAt: 0 });
    const peers = [];
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (a && a.p) peers.push({ id: a.id, p: a.p });
    }
    const chat = (await this.ctx.storage.get("chat")) || [];
    server.send(JSON.stringify({ t: "hello", id, peers, chat }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 2000) return;
    let d; try { d = JSON.parse(message); } catch { return; }
    const a = ws.deserializeAttachment(); if (!a) return;
    const now = Date.now();
    if (d.t === "p") {
      if (now - a.last < 90) return;
      const p = cleanPresence(d.p); if (!p) return;
      a.p = p; a.last = now; ws.serializeAttachment(a);
      this.broadcast({ t: "p", id: a.id, p }, ws);
    } else if (d.t === "c") {
      if (now - a.chatAt < 1200) return;
      const s = cleanText(d.s, 80); if (!s) return;
      a.chatAt = now; ws.serializeAttachment(a);
      const m = { id: a.id, n: (a.p && a.p.n) || "Student", s, at: now };
      const chat = (await this.ctx.storage.get("chat")) || [];
      chat.push(m); while (chat.length > CHAT_KEEP) chat.shift();
      await this.ctx.storage.put("chat", chat);
      this.broadcast({ t: "c", m }, null);
    }
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const a = ws.deserializeAttachment();
    if (a) this.broadcast({ t: "l", id: a.id }, ws);
    try { ws.close(1000, "bye"); } catch {}
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      try { w.send(s); } catch {}
    }
  }
}
