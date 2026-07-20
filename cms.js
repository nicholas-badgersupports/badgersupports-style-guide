/* Badger Supports Style Guide — content loader + password-protected in-page editor.
   ----------------------------------------------------------------------------
   HOW IT WORKS
   - On every load, this reads content.json and applies any saved text/image
     changes over the built-in page. If content.json is missing or empty, the
     page shows exactly what was built (nothing breaks).
   - Editors click the small "edit" button (bottom-left), type the shared
     password, then click any text to rewrite it or any image to replace it,
     and press "Save". Changes are sent to your Cloudflare Worker, which commits
     them to GitHub. The live page updates about a minute later.

   SETUP (one line): after you deploy the Worker, paste its URL below.
   Leave it blank and the page is simply read-only (no edit button shows).
*/
(function () {
  var CONFIG = {
    WORKER_URL: "https://bs-style-editor.nicholas-9d9.workers.dev"   // ← paste your deployed Cloudflare Worker URL here (e.g. https://bs-style-editor.yourname.workers.dev)
  };

  var baseline = {};   // key -> original innerHTML (to detect text edits)
  var stagedImg = {};  // imgKey -> {name, ext, b64}
  var PW = null;       // held in memory for the session only
  var editing = false;
  var exitArmed = false;

  /* ---------- 1) Apply saved content over the built-in page ---------- */
  fetch("content.json?ts=" + Math.floor(Date.now() / 30000))
    .then(function (r) { return r.ok ? r.json() : { text: {}, images: {} }; })
    .then(applyContent)
    .catch(function () { /* offline / missing → keep built-in content */ })
    .then(bootEditor);

  function applyContent(data) {
    data = data || {}; var t = data.text || {}, im = data.images || {};
    Object.keys(t).forEach(function (k) {
      qsa('[data-cms="' + k + '"]').forEach(function (el) { el.innerHTML = t[k]; });
    });
    Object.keys(im).forEach(function (k) {
      qsa('[data-cms-img="' + k + '"]').forEach(function (el) { el.src = im[k]; });
    });
  }

  /* ---------- 2) Editor (only if a Worker URL is configured) ---------- */
  function bootEditor() {
    if (!CONFIG.WORKER_URL) return;
    injectStyle();
    addEditButton();
    if (location.hash === "#edit") openLogin();
  }

  function addEditButton() {
    var b = document.createElement("button");
    b.id = "cmsEdit"; b.type = "button"; b.title = "Edit this page";
    b.innerHTML = pencil() + "<span>edit</span>";
    b.onclick = openLogin;
    document.body.appendChild(b);
  }

  /* ----- login overlay ----- */
  function openLogin() {
    if (editing) return;
    var ov = el("div", "cmsOverlay");
    ov.innerHTML =
      '<div class="cmsCard">' +
        '<div class="cmsH">' + pencil() + ' Editor sign-in</div>' +
        '<p class="cmsP">Enter the editing password to change text and images on this page.</p>' +
        '<input id="cmsPw" type="password" placeholder="Password" autocomplete="off" />' +
        '<div class="cmsErr" id="cmsErr"></div>' +
        '<div class="cmsRow"><button class="cmsBtn ghost" id="cmsCancel">Cancel</button>' +
        '<button class="cmsBtn" id="cmsUnlock">Unlock</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    var pw = ov.querySelector("#cmsPw");
    pw.focus();
    ov.querySelector("#cmsCancel").onclick = function () { ov.remove(); };
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
    pw.addEventListener("keydown", function (e) { if (e.key === "Enter") unlock(); });
    ov.querySelector("#cmsUnlock").onclick = unlock;

    function unlock() {
      var val = pw.value;
      var err = ov.querySelector("#cmsErr");
      var btn = ov.querySelector("#cmsUnlock");
      err.textContent = ""; btn.disabled = true; btn.textContent = "Checking…";
      post({ action: "verify", password: val })
        .then(function (res) {
          if (res.ok) { PW = val; ov.remove(); enterEdit(); }
          else { err.textContent = res.error || "Wrong password."; btn.disabled = false; btn.textContent = "Unlock"; }
        })
        .catch(function (e) { err.textContent = "Can't reach the editor service."; btn.disabled = false; btn.textContent = "Unlock"; });
    }
  }

  /* ----- edit mode ----- */
  function enterEdit() {
    editing = true; exitArmed = false;
    document.body.classList.add("cmsLive");

    qsa("[data-cms]").forEach(function (elm) {
      baseline[elm.getAttribute("data-cms")] = elm.innerHTML;
      elm.setAttribute("contenteditable", "true");
      elm.setAttribute("spellcheck", "true");
    });
    qsa("[data-cms-img]").forEach(function (img) {
      img.classList.add("cmsImg");
      img.title = "Click to replace this image";
      img.addEventListener("click", onImgClick);
    });

    var bar = el("div", "cmsBar");
    bar.innerHTML =
      '<span class="cmsBarT">' + pencil() + ' Editing — click any text to change it, click any image to replace it.</span>' +
      '<span class="cmsStatus" id="cmsStatus"></span>' +
      '<span class="cmsBarBtns"><button class="cmsBtn ghost" id="cmsExit">Exit</button>' +
      '<button class="cmsBtn" id="cmsSave">Save changes</button></span>';
    document.body.appendChild(bar);
    document.getElementById("cmsSave").onclick = save;
    document.getElementById("cmsExit").onclick = exit;
    var eb = document.getElementById("cmsEdit"); if (eb) eb.style.display = "none";
  }

  function onImgClick(e) {
    if (!editing) return;
    e.preventDefault();
    var img = e.currentTarget;
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp";
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      processImage(f, function (out) {
        if (!out) { setStatus("That image couldn't be read.", true); return; }
        img.src = out.dataUrl;
        stagedImg[img.getAttribute("data-cms-img")] = { name: f.name, ext: out.ext, b64: out.b64 };
        setStatus("Image ready — press Save to publish.");
        exitArmed = false;
      });
    };
    inp.click();
  }

  function collectChanges() {
    var texts = {};
    qsa("[data-cms]").forEach(function (elm) {
      var k = elm.getAttribute("data-cms");
      if (elm.innerHTML !== baseline[k]) texts[k] = elm.innerHTML.trim();
    });
    var images = {};
    Object.keys(stagedImg).forEach(function (k) { images[k] = stagedImg[k]; });
    return { texts: texts, images: images };
  }

  function save() {
    var ch = collectChanges();
    var nT = Object.keys(ch.texts).length, nI = Object.keys(ch.images).length;
    if (!nT && !nI) { setStatus("No changes to save yet."); return; }
    var btn = document.getElementById("cmsSave");
    btn.disabled = true; setStatus("Saving " + (nT + nI) + " change" + (nT + nI > 1 ? "s" : "") + "…");
    post({ password: PW, texts: ch.texts, images: ch.images })
      .then(function (res) {
        btn.disabled = false;
        if (res.ok) {
          qsa("[data-cms]").forEach(function (elm) { baseline[elm.getAttribute("data-cms")] = elm.innerHTML; });
          stagedImg = {};
          setStatus("Saved ✓  Live on the site in about a minute.");
        } else {
          setStatus("Couldn't save: " + (res.error || "unknown error"), true);
        }
      })
      .catch(function () { btn.disabled = false; setStatus("Couldn't reach the editor service.", true); });
  }

  function exit() {
    var ch = collectChanges();
    var dirty = Object.keys(ch.texts).length || Object.keys(ch.images).length;
    if (dirty && !exitArmed) { exitArmed = true; setStatus("Unsaved changes — click Exit again to discard.", true); return; }
    location.reload();
  }

  function setStatus(msg, warn) {
    var s = document.getElementById("cmsStatus");
    if (s) { s.textContent = msg; s.className = "cmsStatus" + (warn ? " warn" : " ok"); }
  }

  /* ---------- helpers ---------- */
  function post(payload) {
    return fetch(CONFIG.WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return { error: "bad response" }; }); });
  }

  function processImage(file, cb) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var maxW = 1400;
      var scale = Math.min(1, maxW / img.width);
      var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      var isPng = /\.png$/i.test(file.name) || file.type === "image/png";
      var mime = isPng ? "image/png" : "image/jpeg";
      var dataUrl = c.toDataURL(mime, 0.88);
      URL.revokeObjectURL(url);
      cb({ dataUrl: dataUrl, b64: dataUrl.split(",")[1], ext: isPng ? "png" : "jpg" });
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }

  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function pencil() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'; }

  function injectStyle() {
    var css =
      '#cmsEdit{position:fixed;left:16px;bottom:16px;z-index:9998;display:flex;align-items:center;gap:6px;' +
      'background:#fff;color:#8a8178;border:1px solid #e2d8c6;border-radius:999px;padding:8px 14px;font:600 13px Montserrat,system-ui,sans-serif;' +
      'cursor:pointer;opacity:.5;box-shadow:0 2px 10px rgba(80,60,20,.10);transition:.15s}' +
      '#cmsEdit:hover{opacity:1;color:#B60000;border-color:#B60000}' +
      '.cmsOverlay{position:fixed;inset:0;z-index:10000;background:rgba(40,34,32,.45);display:flex;align-items:center;justify-content:center}' +
      '.cmsCard{background:#fff;border-radius:16px;padding:26px 26px 22px;width:340px;max-width:90vw;box-shadow:0 18px 50px rgba(40,30,10,.3);font-family:Montserrat,system-ui,sans-serif}' +
      '.cmsH{font-weight:800;font-size:19px;color:#393737;display:flex;align-items:center;gap:8px}' +
      '.cmsP{font-size:14px;color:#6b6560;margin:8px 0 14px;line-height:1.5}' +
      '#cmsPw{width:100%;padding:11px 13px;border:1px solid #d8ccb6;border-radius:9px;font-size:15px;font-family:inherit}' +
      '#cmsPw:focus{outline:none;border-color:#B60000}' +
      '.cmsErr{color:#B60000;font-size:13px;font-weight:600;min-height:18px;margin:7px 2px 0}' +
      '.cmsRow{display:flex;gap:10px;justify-content:flex-end;margin-top:10px}' +
      '.cmsBtn{background:#B60000;color:#fff;border:0;border-radius:9px;padding:10px 18px;font:700 14px Montserrat,system-ui,sans-serif;cursor:pointer}' +
      '.cmsBtn:hover{filter:brightness(1.06)}.cmsBtn:disabled{opacity:.6;cursor:default}' +
      '.cmsBtn.ghost{background:#f3ede2;color:#6b6560}' +
      '.cmsBar{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#393737;color:#fff;' +
      'display:flex;align-items:center;gap:16px;padding:11px 18px;font:600 14px Montserrat,system-ui,sans-serif;box-shadow:0 -4px 20px rgba(0,0,0,.2);flex-wrap:wrap}' +
      '.cmsBarT{display:flex;align-items:center;gap:8px}' +
      '.cmsStatus{font-weight:700;font-size:13.5px}.cmsStatus.ok{color:#8fd6a6}.cmsStatus.warn{color:#ffb4a2}' +
      '.cmsBarBtns{margin-left:auto;display:flex;gap:10px}' +
      'body.cmsLive [data-cms]{outline:1px dashed transparent;outline-offset:3px;border-radius:3px;transition:outline-color .12s,background .12s;cursor:text}' +
      'body.cmsLive [data-cms]:hover{outline-color:#c9a94f;background:rgba(225,191,75,.10)}' +
      'body.cmsLive [data-cms]:focus{outline:2px solid #B60000;background:#fff}' +
      'body.cmsLive .cmsImg{cursor:pointer;outline:2px solid transparent;outline-offset:2px;transition:outline-color .12s}' +
      'body.cmsLive .cmsImg:hover{outline-color:#0479A8;box-shadow:0 0 0 4px rgba(4,121,168,.15)}' +
      'body.cmsLive{padding-bottom:60px}';
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }
})();
