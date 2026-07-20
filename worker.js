/* Badger Supports Style Guide — editing Worker (Cloudflare Workers, free tier).
   ===========================================================================
   Receives edits from the page and commits them to GitHub. The GitHub token
   lives here as a secret, never in the public website.

   Handles: verify (sign-in), save (text / images / added list items),
   restore (roll back to an earlier version), and a sign-in LOG.

   SETUP — edit the constants below, then in the Cloudflare dashboard add two
   secrets (Settings → Variables and Secrets, or bind them from Secrets Store):
       EDIT_PASSWORD   the shared password editors type
       GH_TOKEN        a GitHub fine-grained token with Contents: Read and write
                       on BOTH repos below (the site repo AND the private log repo)
   =========================================================================== */

// --- Site repo (public, GitHub Pages) ---
const OWNER  = "nicholas-badgersupports";
const REPO   = "badgersupports-style-guide";
const BRANCH = "main";

// --- Sign-in log repo — KEEP THIS PRIVATE (it stores emails, IPs, locations) ---
// Create a PRIVATE repo (e.g. "style-guide-logs"), initialise it with a README,
// and add it to the token's repository access. Set LOG_REPO = "" to turn logging off.
const LOG_OWNER  = "nicholas-badgersupports";
const LOG_REPO   = "style-guide-logs";
const LOG_BRANCH = "main";
const LOG_PATH   = "signins.jsonl";

// Websites allowed to use this Worker:
const ALLOWED = [
  "https://style.badgersupports.org",
  "https://nicholas-badgersupports.github.io"
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }

    const token = await readSecret(env.GH_TOKEN);
    const EDIT_PASSWORD = await readSecret(env.EDIT_PASSWORD);
    const ok = await safeEqual(String(body.password || ""), String(EDIT_PASSWORD || " "));

    const action = body.action || "save";
    const event = action === "verify" ? "signin" : action;   // signin | save | restore

    // Log EVERY attempt (including wrong-password ones). Email is recorded, not checked.
    // Best-effort: logging never blocks or breaks the sign-in.
    await logAttempt(request, { event: event, email: body.email || "", ok: ok }, token);

    if (!ok) return json({ error: "Wrong password." }, 401, cors);
    if (action === "verify") return json({ ok: true }, 200, cors);
    if (!token) return json({ error: "Server not configured (missing GH_TOKEN)." }, 500, cors);

    try {
      // ----- restore a previous version -----
      if (action === "restore") {
        const idx = body.index | 0;
        const h = await ghGetJson(OWNER, REPO, "history.json", BRANCH, token);
        const arr = (h && Array.isArray(h.data)) ? h.data : [];
        if (idx < 0 || idx >= arr.length) return json({ error: "That version is no longer available." }, 400, cors);
        const snap = arr[idx];
        const cur = await ghGetJson(OWNER, REPO, "content.json", BRANCH, token);
        if (cur && cur.data) await pushHistory(cur.data, token);   // make the restore itself undoable
        const restored = { text: snap.text || {}, images: snap.images || {}, adds: snap.adds || {} };
        await ghPutText(OWNER, REPO, "content.json", b64utf8(JSON.stringify(restored, null, 2)), "Editor: restore version", cur && cur.sha, BRANCH, token);
        return json({ ok: true, committed: ["content.json"] }, 200, cors);
      }

      // ----- normal save -----
      const committed = [];

      // 1) replaced images → write files under images/
      const imgOverrides = {};
      const images = body.images || {};
      for (const key of Object.keys(images)) {
        const im = images[key];
        if (!im || !im.b64) continue;
        const ext = String(im.ext || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
        const path = "images/" + safeKey(key) + "." + ext;
        const sha = await getSha(OWNER, REPO, path, BRANCH, token);
        await ghPutText(OWNER, REPO, path, im.b64, "Editor: update image " + key, sha, BRANCH, token);
        imgOverrides[key] = path + "?v=" + (await hash8(im.b64));
        committed.push(path);
      }

      // 2) load current content, snapshot it into history, then merge changes
      const cur = await ghGetJson(OWNER, REPO, "content.json", BRANCH, token);
      const data = (cur && cur.data) || { text: {}, images: {}, adds: {} };
      data.text = data.text || {}; data.images = data.images || {}; data.adds = data.adds || {};
      await pushHistory(data, token);   // snapshot the pre-change state (keeps last 5)

      const texts = body.texts || {};
      for (const k of Object.keys(texts)) data.text[k] = texts[k];
      for (const k of Object.keys(imgOverrides)) data.images[k] = imgOverrides[k];
      const adds = body.adds || {};
      for (const k of Object.keys(adds)) data.adds[k] = adds[k];   // full replace per list

      await ghPutText(OWNER, REPO, "content.json", b64utf8(JSON.stringify(data, null, 2)), "Editor: update content", cur && cur.sha, BRANCH, token);
      committed.push("content.json");
      return json({ ok: true, committed: committed }, 200, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, cors);
    }
  }
};

/* ---------- history ---------- */
async function pushHistory(prevData, token) {
  try {
    const h = await ghGetJson(OWNER, REPO, "history.json", BRANCH, token);
    let arr = (h && Array.isArray(h.data)) ? h.data : [];
    arr.unshift({ at: new Date().toISOString(), text: prevData.text || {}, images: prevData.images || {}, adds: prevData.adds || {} });
    arr = arr.slice(0, 5);
    await ghPutText(OWNER, REPO, "history.json", b64utf8(JSON.stringify(arr, null, 2)), "Editor: snapshot history", h && h.sha, BRANCH, token);
  } catch (e) { /* history is best-effort; never block a save */ }
}

/* ---------- sign-in log (to the PRIVATE log repo) ---------- */
async function logAttempt(request, info, token) {
  if (!token || !LOG_REPO) return;
  try {
    const cf = request.cf || {};
    const entry = {
      at: new Date().toISOString(),
      event: info.event,
      email: String(info.email || "").slice(0, 200),
      ok: !!info.ok,
      ip: request.headers.get("CF-Connecting-IP") || "",
      ua: request.headers.get("User-Agent") || "",
      lang: request.headers.get("Accept-Language") || "",
      referer: request.headers.get("Referer") || "",
      country: cf.country || "", region: cf.region || "", city: cf.city || "",
      postalCode: cf.postalCode || "", timezone: cf.timezone || "",
      asn: cf.asn || "", isp: cf.asOrganization || "",
      latitude: cf.latitude || "", longitude: cf.longitude || ""
    };
    const cur = await ghGetText(LOG_OWNER, LOG_REPO, LOG_PATH, LOG_BRANCH, token);
    const content = (cur ? cur.text : "") + JSON.stringify(entry) + "\n";
    await ghPutText(LOG_OWNER, LOG_REPO, LOG_PATH, b64utf8(content), "sign-in: " + info.event + (info.ok ? " ok" : " FAIL"), cur && cur.sha, LOG_BRANCH, token);
  } catch (e) { /* never block sign-in on logging */ }
}

/* ---------- GitHub REST ---------- */
function ghReq(owner, repo, path, opts, token) {
  return fetch("https://api.github.com/repos/" + owner + "/" + repo + path, Object.assign({
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bs-style-guide-editor"
    }
  }, opts || {}));
}
async function getSha(owner, repo, path, branch, token) {
  const r = await ghReq(owner, repo, "/contents/" + encodeURI(path) + "?ref=" + branch, {}, token);
  if (r.status === 200) { const j = await r.json(); return j.sha; }
  return undefined;
}
async function ghGetText(owner, repo, path, branch, token) {
  const r = await ghReq(owner, repo, "/contents/" + encodeURI(path) + "?ref=" + branch, {}, token);
  if (r.status !== 200) return null;
  const j = await r.json();
  return { sha: j.sha, text: b64decodeUtf8((j.content || "").replace(/\n/g, "")) };
}
async function ghGetJson(owner, repo, path, branch, token) {
  const t = await ghGetText(owner, repo, path, branch, token);
  if (!t) return null;
  try { return { sha: t.sha, data: JSON.parse(t.text) }; } catch (e) { return { sha: t.sha, data: null }; }
}
async function ghPutText(owner, repo, path, contentB64, message, sha, branch, token) {
  const b = { message: message, content: contentB64, branch: branch };
  if (sha) b.sha = sha;
  const r = await ghReq(owner, repo, "/contents/" + encodeURI(path), { method: "PUT", body: JSON.stringify(b) }, token);
  if (r.status !== 200 && r.status !== 201) { const t = await r.text(); throw new Error("GitHub " + r.status + " on " + path + ": " + t.slice(0, 140)); }
  return r.json();
}

/* ---------- utils ---------- */
function corsHeaders(origin) {
  const allow = ALLOWED.indexOf(origin) !== -1 ? origin : ALLOWED[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status: status, headers: Object.assign({ "Content-Type": "application/json" }, cors || {}) });
}
function safeKey(k) { return String(k).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60); }
async function readSecret(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;                    // per-Worker secret / plaintext var
  if (typeof v.get === "function") return await v.get();  // Cloudflare Secrets Store binding
  return String(v);
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(b)));
  let d = 0; for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i];
  return d === 0;
}
async function hash8(s) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
  return Array.from(h).slice(0, 4).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}
function b64utf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decodeUtf8(b64) { return decodeURIComponent(escape(atob(b64))); }
