import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Passcode gate.
 *
 * Everything except /login and /auth requires a signed session cookie. The
 * passcode lives in the systemd unit, never in the repo. Anyone on the same
 * network can still see the code in transit because the site is plain HTTP, so
 * this stops strangers finding it, not a determined snoop.
 */

const COOKIE = "hl_session";
const MAX_AGE_S = 30 * 24 * 3600;

interface Attempt {
  count: number;
  until: number;
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const LOGIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#03050c"/><title>HL DESK · private</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Pixelify+Sans:wght@400;600&display=swap" rel="stylesheet"/>
<style>
  html,body{height:100%;margin:0;background:#03050c;color:#f6f1e7;
    font-family:"Pixelify Sans",system-ui,sans-serif;display:grid;place-items:center}
  .card{width:min(360px,88vw);border:1px solid rgba(255,255,255,.1);border-radius:10px;
    background:rgba(8,14,24,.92);padding:26px 24px 22px;box-shadow:0 18px 50px rgba(0,0,0,.6)}
  h1{font-family:"Press Start 2P",monospace;font-size:13px;letter-spacing:.08em;margin:0 0 4px}
  h1 span{color:#4aa8ff}
  p.sub{margin:0 0 18px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.38)}
  input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);
    border-radius:6px;color:#eae3d6;font-family:ui-monospace,monospace;font-size:18px;letter-spacing:.3em;
    padding:11px 12px;text-align:center;outline:none}
  input:focus{border-color:#4aa8ff}
  button{width:100%;margin-top:12px;border:0;border-radius:6px;padding:11px;cursor:pointer;
    background:linear-gradient(180deg,#ffb347,#ef6a12);color:#1a1004;font-family:"Press Start 2P",monospace;
    font-size:10px;letter-spacing:.1em}
  .err{min-height:16px;margin-top:10px;font-size:11px;color:#ff8c42}
</style></head><body>
<div class="card">
  <h1>HL <span>DESK</span></h1>
  <p class="sub">private · passcode required</p>
  <input id="code" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••••" autofocus/>
  <button id="go">UNLOCK</button>
  <div class="err" id="err"></div>
</div>
<script>
  const send = async () => {
    const code = document.getElementById('code').value.trim();
    const err = document.getElementById('err');
    err.textContent = '';
    try {
      const r = await fetch('/auth', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({code})});
      if (r.ok) { location.replace('/'); return; }
      err.textContent = r.status === 429 ? 'too many attempts, wait 10 minutes' : 'wrong passcode';
    } catch { err.textContent = 'request failed'; }
  };
  document.getElementById('go').addEventListener('click', send);
  document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
</script>
</body></html>`;

export function registerAuth(app: FastifyInstance, passcode: string): void {
  if (!passcode) return;

  const secret = `hl-desk:${passcode}`;
  const attempts = new Map<string, Attempt>();

  const stamp = (exp: number) =>
    createHmac("sha256", secret).update(String(exp)).digest("hex").slice(0, 40);

  const issue = (): string => {
    const exp = Date.now() + MAX_AGE_S * 1000;
    return `${exp}.${stamp(exp)}`;
  };

  const isValid = (value?: string): boolean => {
    if (!value) return false;
    const [raw, sig] = value.split(".");
    const exp = Number(raw);
    if (!exp || exp < Date.now() || !sig) return false;
    const want = stamp(exp);
    return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  };

  const tooMany = (ip: string): boolean => {
    const hit = attempts.get(ip);
    if (!hit) return false;
    if (Date.now() > hit.until) {
      attempts.delete(ip);
      return false;
    }
    return hit.count >= 10;
  };

  const noteFailure = (ip: string): void => {
    const hit = attempts.get(ip) ?? { count: 0, until: 0 };
    hit.count += 1;
    hit.until = Date.now() + 10 * 60_000;
    attempts.set(ip, hit);
  };

  app.get("/login", async (_req, reply: FastifyReply) => {
    reply.type("text/html").send(LOGIN_HTML);
  });

  app.post<{ Body: { code?: string } }>("/auth", async (req: FastifyRequest<{ Body: { code?: string } }>, reply) => {
    const ip = req.ip;
    if (tooMany(ip)) return reply.code(429).send({ ok: false, error: "too many attempts" });
    const code = String(req.body?.code ?? "").trim();
    if (!code || code !== passcode) {
      noteFailure(ip);
      return reply.code(401).send({ ok: false, error: "wrong passcode" });
    }
    attempts.delete(ip);
    reply.header(
      "set-cookie",
      `${COOKIE}=${encodeURIComponent(issue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}`,
    );
    return { ok: true };
  });

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.raw.url ?? "/";
    if (url.startsWith("/auth") || url.startsWith("/login")) return;
    if (isValid(parseCookies(req.headers.cookie)[COOKIE])) return;
    if (url.startsWith("/api")) {
      reply.code(401).send({ ok: false, error: "passcode required" });
      return;
    }
    reply.code(302).header("location", "/login").send();
  });
}
