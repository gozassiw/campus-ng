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


/* ---------- Accounts, cloud saves and leaderboards (D1) ---------- */
let dbReady = false;
async function initDb(env) {
  if (dbReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, pass TEXT, salt TEXT, created INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, created INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS saves (user_id TEXT PRIMARY KEY, data TEXT, name TEXT, uni TEXT, cash INTEGER, gpa REAL, pop INTEGER, updated INTEGER)")
  ]);
  dbReady = true;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function hashPass(pass, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 10000, hash: "SHA-256" }, key, 256);
  return b64(bits);
}
async function userFromToken(request, env) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer ([A-Za-z0-9-]{20,80})$/);
  if (!m) return null;
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE token = ?").bind(m[1]).first();
  return row ? row.user_id : null;
}
const isNum = (x, a, b) => typeof x === "number" && Number.isFinite(x) && x >= a && x <= b;
const MAX_GAIN_PER_DAY = 300000;
function checkSave(prev, d) {
  if (!d || typeof d !== "object" || d.v !== 2) return "That save doesn't look right.";
  if (!isNum(d.cash, 0, 1e9) || !isNum(d.day, 1, 15) || !isNum(d.prep, 0, 100) || !isNum(d.pop, 0, 100) ||
      !isNum(d.rep, -50, 50) || !isNum(d.energy, 0, 100) || !isNum(d.food, 0, 100)) return "Some numbers are out of range.";
  if (d.job && (!isNum(d.job.level || 0, 0, 4) || !isNum(d.job.shifts || 0, 0, 100))) return "Job data is out of range.";
  const prevCash = prev ? prev.cash : 10500000;
  const days = prev ? Math.max(1, d.day - prev.day + 1) : Math.max(1, d.day);
  if (d.cash - prevCash > MAX_GAIN_PER_DAY * days) return "Your money went up faster than the game allows.";
  return "";
}
async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: "The database isn't connected yet." }, 503);
  await initDb(env);
  const path = url.pathname;
  let body = {};
  if (request.method === "POST") { try { body = await request.json(); } catch { body = {}; } }
  if (path === "/api/signup" || path === "/api/login") {
    const username = String(body.username || "").trim().toLowerCase(), password = String(body.password || "");
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return json({ error: "Username must be 3 to 20 letters, numbers or underscores." }, 400);
    if (password.length < 6 || password.length > 100) return json({ error: "Password must be at least 6 characters." }, 400);
    let user = await env.DB.prepare("SELECT id, pass, salt FROM users WHERE username = ?").bind(username).first();
    if (path === "/api/signup") {
      if (user) return json({ error: "That username is taken." }, 409);
      const id = crypto.randomUUID(), salt = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO users (id, username, pass, salt, created) VALUES (?, ?, ?, ?, ?)").bind(id, username, await hashPass(password, salt), salt, Date.now()).run();
      user = { id };
    } else {
      if (!user || (await hashPass(password, user.salt)) !== user.pass) return json({ error: "Wrong username or password." }, 401);
    }
    const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
    await env.DB.prepare("INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)").bind(token, user.id, Date.now()).run();
    const save = await env.DB.prepare("SELECT data FROM saves WHERE user_id = ?").bind(user.id).first();
    return json({ token, username, data: save ? JSON.parse(save.data) : null });
  }
  if (path === "/api/leaderboard") {
    const type = url.searchParams.get("type") || "rich", since = Date.now() - 30 * 86400000;
    if (type === "uni") {
      const r = await env.DB.prepare("SELECT uni, COUNT(*) AS players, ROUND(AVG(gpa), 2) AS gpa FROM saves WHERE updated > ? GROUP BY uni ORDER BY players DESC LIMIT 30").bind(since).all();
      return json({ rows: r.results });
    }
    const col = type === "gpa" ? "gpa" : type === "pop" ? "pop" : "cash";
    const r = await env.DB.prepare(`SELECT name, uni, ${col} AS value FROM saves WHERE updated > ? AND ${col} IS NOT NULL ORDER BY ${col} DESC LIMIT 20`).bind(since).all();
    return json({ rows: r.results });
  }
  const userId = await userFromToken(request, env);
  if (!userId) return json({ error: "Please log in again." }, 401);
  if (path === "/api/logout") { await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind((request.headers.get("authorization") || "").slice(7)).run(); return json({ ok: true }); }
  if (path === "/api/save" && request.method === "GET") {
    const save = await env.DB.prepare("SELECT data FROM saves WHERE user_id = ?").bind(userId).first();
    return json({ data: save ? JSON.parse(save.data) : null });
  }
  if (path === "/api/save" && request.method === "POST") {
    const d = body.data, text = JSON.stringify(d || null);
    if (text.length > 80000) return json({ error: "Save is too big." }, 413);
    const row = await env.DB.prepare("SELECT data FROM saves WHERE user_id = ?").bind(userId).first();
    const prev = row ? JSON.parse(row.data) : null, problem = checkSave(prev, d);
    if (problem) return json({ error: problem, data: prev }, 409);
    const gpa = d.results && isNum(d.results.gpa, 0, 5) ? d.results.gpa : null;
    await env.DB.prepare("INSERT INTO saves (user_id, data, name, uni, cash, gpa, pop, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, name=excluded.name, uni=excluded.uni, cash=excluded.cash, gpa=excluded.gpa, pop=excluded.pop, updated=excluded.updated")
      .bind(userId, text, cleanText(d.name, 16) || "Student", cleanText(d.uni, 12), Math.round(d.cash), gpa, Math.round(d.pop), Date.now()).run();
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) { return json({ error: "Server error. Try again." }, 500); }
    }
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
