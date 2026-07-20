/* Badger Supports Style Guide — content loader + password-protected in-page editor.
   ---------------------------------------------------------------------------
   Read-only for everyone by default. Editors click the "edit" button, enter the
   shared password, then can: edit any text, format it (bold / link / color /
   font, kept to brand options), swap any image, ADD new list items and glossary
   definitions with a "+", and restore an earlier version. Changes commit to
   GitHub through your Cloudflare Worker; the live page updates ~1 minute later.

   After deploying the Worker, put its URL in WORKER_URL below (leave blank = read-only).
*/
(function () {
  var CONFIG = {
    WORKER_URL: "https://bs-style-editor.nicholas-9d9.workers.dev"   // ← your Cloudflare Worker URL (blank = read-only)
  };

  // Brand-limited formatting choices
  var COLORS = [["Red", "#B60000"], ["Charcoal", "#393737"], ["Green", "#346B4F"],
                ["Blue", "#304674"], ["Purple", "#4F4F7D"], ["Khaki", "#8f7f52"], ["Link", "#0479A8"]];
  var FONTS = [["Body", "Montserrat"], ["Display", "Fredoka"], ["Handwritten", "Caveat"]];

  var baseline = {}, stagedImg = {}, PW = null, EMAIL = "", editing = false, exitArmed = false, dirtyAdds = false;

  /* ---------- 1) apply saved content ---------- */
  fetch("content.json?ts=" + Math.floor(Date.now() / 30000))
    .then(function (r) { return r.ok ? r.json() : { text: {}, images: {}, adds: {} }; })
    .then(applyContent).catch(function () {}).then(bootEditor);

  function applyContent(data) {
    data = data || {};
    var t = data.text || {}, im = data.images || {}, adds = data.adds || {};
    Object.keys(t).forEach(function (k) { qsa('[data-cms="' + k + '"]').forEach(function (el) { el.innerHTML = t[k]; }); });
    Object.keys(im).forEach(function (k) { qsa('[data-cms-img="' + k + '"]').forEach(function (el) { el.src = im[k]; }); });
    Object.keys(adds).forEach(function (k) { applyAdds(k, adds[k]); });
  }
  function applyAdds(listKey, items) {
    if (!items || !items.length) return;
    var el = document.querySelector('[data-cms-list="' + listKey + '"]'); if (!el) return;
    var isDL = el.tagName === "DL";
    items.forEach(function (it) {
      if (isDL) {
        var dt = ce("dt", "cms-added"); dt.innerHTML = (it && it.term) || "";
        var dd = ce("dd", "cms-added"); dd.innerHTML = (it && it.def) || "";
        el.appendChild(dt); el.appendChild(dd);
      } else {
        var li = ce("li", "cms-added"); li.innerHTML = (typeof it === "string" ? it : (it && it.html) || "");
        el.appendChild(li);
      }
    });
  }

  /* ---------- 2) editor ---------- */
  function bootEditor() {
    if (!CONFIG.WORKER_URL) return;
    injectStyle(); addEditButton();
    if (location.hash === "#edit") openLogin();
  }

  function addEditButton() {
    var b = ce("button", null); b.id = "cmsEdit"; b.type = "button"; b.title = "Edit this page";
    b.innerHTML = pencil() + "<span>edit</span>"; b.onclick = openLogin;
    document.body.appendChild(b);
  }

  function openLogin() {
    if (editing) return;
    var ov = ce("div", "cmsOverlay");
    ov.innerHTML =
      '<div class="cmsCard"><div class="cmsH">' + pencil() + ' Editor sign-in</div>' +
      '<p class="cmsP">Sign in to edit. Your email is recorded with each edit; the password is what unlocks editing.</p>' +
      '<input id="cmsEmail" type="email" placeholder="Your email (recorded in the edit log)" autocomplete="off" />' +
      '<input id="cmsPw" type="password" placeholder="Password" autocomplete="off" />' +
      '<div class="cmsErr" id="cmsErr"></div>' +
      '<div class="cmsRow"><button class="cmsBtn ghost" id="cmsCancel">Cancel</button>' +
      '<button class="cmsBtn" id="cmsUnlock">Unlock</button></div></div>';
    document.body.appendChild(ov);
    var pw = ov.querySelector("#cmsPw"), em = ov.querySelector("#cmsEmail"); em.focus();
    ov.querySelector("#cmsCancel").onclick = function () { ov.remove(); };
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
    function onKey(e) { if (e.key === "Enter") unlock(); }
    pw.addEventListener("keydown", onKey); em.addEventListener("keydown", onKey);
    ov.querySelector("#cmsUnlock").onclick = unlock;
    function unlock() {
      var val = pw.value, mail = (em.value || "").trim(), err = ov.querySelector("#cmsErr"), btn = ov.querySelector("#cmsUnlock");
      var GENERIC = "Incorrect email or password.";
      var domainOK = /^[^@\s]+@badgersupports\.org$/i.test(mail);   // required, but not revealed in errors
      err.textContent = ""; btn.disabled = true; btn.textContent = "Checking…";
      // Always sent so the attempt is logged; unlock needs the right password AND a badgersupports.org email.
      post({ action: "verify", email: mail, password: val }).then(function (res) {
        if (res.ok && domainOK) { PW = val; EMAIL = mail; ov.remove(); enterEdit(); }
        else { err.textContent = GENERIC; btn.disabled = false; btn.textContent = "Unlock"; }
      }).catch(function () { err.textContent = "Can't reach the editor service."; btn.disabled = false; btn.textContent = "Unlock"; });
    }
  }

  function enterEdit() {
    editing = true; exitArmed = false; dirtyAdds = false;
    document.body.classList.add("cmsLive");
    try { document.execCommand("styleWithCSS", false, true); } catch (e) {}

    qsa("[data-cms]").forEach(function (el) { baseline[el.getAttribute("data-cms")] = el.innerHTML; el.setAttribute("contenteditable", "true"); });
    qsa(".cms-added").forEach(makeAddedEditable);
    qsa("[data-cms-img]").forEach(function (img) { img.classList.add("cmsImg"); img.title = "Click to replace"; img.addEventListener("click", onImgClick); });
    qsa("[data-cms-list]").forEach(addListControl);

    var bar = ce("div", "cmsBar");
    bar.innerHTML =
      '<span class="cmsBarT">' + pencil() + ' Editing — click text to change it, select text to format it, use + to add items.</span>' +
      '<span class="cmsStatus" id="cmsStatus"></span>' +
      '<span class="cmsBarBtns"><button class="cmsBtn ghost" id="cmsHistBtn">History</button>' +
      '<button class="cmsBtn ghost" id="cmsExit">Exit</button>' +
      '<button class="cmsBtn" id="cmsSave">Save changes</button></span>';
    document.body.appendChild(bar);
    document.getElementById("cmsSave").onclick = save;
    document.getElementById("cmsExit").onclick = exit;
    document.getElementById("cmsHistBtn").onclick = openHistory;
    var eb = document.getElementById("cmsEdit"); if (eb) eb.style.display = "none";

    buildToolbar();
    document.addEventListener("selectionchange", updateToolbar);
    document.addEventListener("mouseup", updateToolbar);
    document.addEventListener("keyup", updateToolbar);
  }

  /* ----- appendable lists (+) ----- */
  function addListControl(list) {
    var isDL = list.tagName === "DL";
    var ctl = ce("div", "cmsAddCtl");
    var b = ce("button", null); b.type = "button";
    b.innerHTML = '<span class="cmsPlus">+</span> ' + (isDL ? "add definition" : "add item");
    b.onclick = function () { addItem(list); };
    ctl.appendChild(b);
    list.parentNode.insertBefore(ctl, list.nextSibling);
  }
  function addItem(list) {
    dirtyAdds = true;
    var focusEl;
    if (list.tagName === "DL") {
      var dt = ce("dt", "cms-added"); dt.innerHTML = "New term";
      var dd = ce("dd", "cms-added"); dd.innerHTML = "New definition";
      list.appendChild(dt); list.appendChild(dd);
      makeAddedEditable(dt); makeAddedEditable(dd); focusEl = dt;
    } else {
      var li = ce("li", "cms-added"); li.innerHTML = "New item";
      list.appendChild(li); makeAddedEditable(li); focusEl = li;
    }
    selectAll(focusEl);
    setStatus("New item added — edit it, then Save.");
  }
  function makeAddedEditable(el) {
    el.setAttribute("contenteditable", "true");
    if ((el.tagName === "DT" || el.tagName === "LI") && !el.querySelector(".cms-rm")) {
      var x = ce("button", "cms-rm"); x.type = "button"; x.setAttribute("contenteditable", "false");
      x.innerHTML = "×"; x.title = "Remove this item";
      x.addEventListener("mousedown", function (e) { e.preventDefault(); });
      x.onclick = function (e) { e.stopPropagation(); removeAdded(el); };
      el.appendChild(x);
    }
  }
  function removeAdded(el) {
    dirtyAdds = true;
    if (el.tagName === "DT") { var dd = el.nextElementSibling; if (dd && dd.tagName === "DD" && dd.classList.contains("cms-added")) dd.remove(); }
    el.remove(); setStatus("Item removed — Save to keep this change.");
  }

  /* ----- image replace ----- */
  function onImgClick(e) {
    if (!editing) return; e.preventDefault();
    var img = e.currentTarget, inp = ce("input", null); inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp";
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      processImage(f, function (out) {
        if (!out) { setStatus("That image couldn't be read.", true); return; }
        img.src = out.dataUrl;
        stagedImg[img.getAttribute("data-cms-img")] = { name: f.name, ext: out.ext, b64: out.b64 };
        setStatus("Image ready — press Save to publish.");
      });
    };
    inp.click();
  }

  /* ----- formatting toolbar ----- */
  var TB;
  function buildToolbar() {
    TB = ce("div", "cmsTools"); TB.style.display = "none";
    TB.innerHTML =
      '<button data-cmd="bold" title="Bold"><b>B</b></button>' +
      '<button data-cmd="italic" title="Italic"><i>I</i></button>' +
      '<button data-cmd="link" title="Add link">🔗</button>' +
      '<span class="cmsTsep"></span><span class="cmsTlab">A</span>' +
      COLORS.map(function (c, i) { return '<button class="cmsSw" data-color="' + c[1] + '" title="' + c[0] + '" style="background:' + c[1] + '"></button>'; }).join("") +
      '<span class="cmsTsep"></span>' +
      FONTS.map(function (f) { return '<button class="cmsFont" data-font="' + f[1] + '" style="font-family:' + f[1] + '" title="' + f[0] + ' font">' + f[0] + '</button>'; }).join("") +
      '<span class="cmsTsep"></span><button data-cmd="clear" title="Clear formatting">clear</button>';
    document.body.appendChild(TB);
    // keep selection when clicking a control
    TB.addEventListener("mousedown", function (e) { e.preventDefault(); });
    TB.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var cmd = b.getAttribute("data-cmd"), col = b.getAttribute("data-color"), fn = b.getAttribute("data-font");
      if (col) exec("foreColor", col);
      else if (fn) exec("fontName", fn);
      else if (cmd === "bold") exec("bold");
      else if (cmd === "italic") exec("italic");
      else if (cmd === "clear") { exec("removeFormat"); exec("unlink"); }
      else if (cmd === "link") addLink();
      updateToolbar();
    });
  }
  function exec(cmd, val) { try { document.execCommand(cmd, false, val || null); } catch (e) {} }
  function addLink() {
    var url = promptInline(); if (url === null) return;
    if (url === "") { exec("unlink"); return; }
    if (!/^https?:|^mailto:/i.test(url)) url = "https://" + url;
    exec("createLink", url);
  }
  function inEditable() {
    var s = window.getSelection(); if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
    var n = s.anchorNode; n = n && (n.nodeType === 1 ? n : n.parentElement);
    while (n && n !== document.body) { if (n.isContentEditable) return n; n = n.parentElement; }
    return null;
  }
  function updateToolbar() {
    if (!editing || !TB) return;
    var host = inEditable();
    if (!host) { TB.style.display = "none"; return; }
    var r = window.getSelection().getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { TB.style.display = "none"; return; }
    TB.style.display = "flex";
    var top = r.top - TB.offsetHeight - 8; if (top < 6) top = r.bottom + 8;
    var left = Math.max(6, Math.min(r.left, window.innerWidth - TB.offsetWidth - 6));
    TB.style.top = (top + window.scrollY) + "px"; TB.style.left = (left + window.scrollX) + "px";
  }

  /* ----- save ----- */
  function cleanHTML(el) { var c = el.cloneNode(true); Array.prototype.forEach.call(c.querySelectorAll(".cms-rm,.cmsAddCtl"), function (x) { x.remove(); }); return c.innerHTML.trim(); }
  function collectChanges() {
    var texts = {};
    qsa("[data-cms]").forEach(function (el) { var k = el.getAttribute("data-cms"); if (el.innerHTML !== baseline[k]) texts[k] = el.innerHTML.trim(); });
    var images = {}; Object.keys(stagedImg).forEach(function (k) { images[k] = stagedImg[k]; });
    var adds = {}, anyAdds = false;
    qsa("[data-cms-list]").forEach(function (list) {
      var key = list.getAttribute("data-cms-list"), isDL = list.tagName === "DL", items = [];
      if (isDL) {
        var kids = Array.prototype.slice.call(list.children);
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].tagName === "DT" && kids[i].classList.contains("cms-added")) {
            var dd = kids[i + 1] && kids[i + 1].tagName === "DD" ? kids[i + 1] : null;
            items.push({ term: cleanHTML(kids[i]), def: dd ? cleanHTML(dd) : "" });
          }
        }
      } else {
        qsaIn(list, "li.cms-added").forEach(function (li) { items.push(cleanHTML(li)); });
      }
      adds[key] = items; if (items.length) anyAdds = true;
    });
    return { texts: texts, images: images, adds: adds, anyAdds: anyAdds };
  }
  function save() {
    var ch = collectChanges();
    var nT = Object.keys(ch.texts).length, nI = Object.keys(ch.images).length;
    if (!nT && !nI && !ch.anyAdds && !dirtyAdds) { setStatus("No changes to save yet."); return; }
    var btn = document.getElementById("cmsSave"); btn.disabled = true;
    setStatus("Saving…");
    post({ password: PW, email: EMAIL, texts: ch.texts, images: ch.images, adds: ch.adds }).then(function (res) {
      btn.disabled = false;
      if (res.ok) {
        qsa("[data-cms]").forEach(function (el) { baseline[el.getAttribute("data-cms")] = el.innerHTML; });
        stagedImg = {}; dirtyAdds = false;
        setStatus("Saved ✓  Live on the site in about a minute.");
      } else setStatus("Couldn't save: " + (res.error || "unknown error"), true);
    }).catch(function () { btn.disabled = false; setStatus("Couldn't reach the editor service.", true); });
  }

  /* ----- version history ----- */
  function openHistory() {
    var panel = ce("div", "cmsOverlay");
    panel.innerHTML = '<div class="cmsCard cmsHistCard"><div class="cmsH">Version history</div>' +
      '<p class="cmsP">Restore the page to an earlier saved version (last 5 kept).</p>' +
      '<div id="cmsHistList" class="cmsHistList">Loading…</div>' +
      '<div class="cmsRow"><button class="cmsBtn ghost" id="cmsHistClose">Close</button></div></div>';
    document.body.appendChild(panel);
    panel.querySelector("#cmsHistClose").onclick = function () { panel.remove(); };
    panel.addEventListener("click", function (e) { if (e.target === panel) panel.remove(); });
    fetch("history.json?ts=" + Date.now()).then(function (r) { return r.ok ? r.json() : []; }).then(function (hist) {
      var list = panel.querySelector("#cmsHistList");
      if (!hist || !hist.length) { list.innerHTML = '<p class="cmsP">No earlier versions yet — they appear here after your next save.</p>'; return; }
      list.innerHTML = "";
      hist.forEach(function (h, i) {
        var row = ce("div", "cmsHistRow");
        var when = h && h.at ? new Date(h.at).toLocaleString() : ("version " + (i + 1));
        row.innerHTML = '<span>' + when + '</span>';
        var rb = ce("button", "cmsBtn ghost"); rb.textContent = "Restore"; rb.onclick = function () { restore(i, rb); };
        row.appendChild(rb); list.appendChild(row);
      });
    }).catch(function () { panel.querySelector("#cmsHistList").innerHTML = '<p class="cmsP">Couldn\'t load history.</p>'; });
  }
  function restore(index, btn) {
    btn.disabled = true; btn.textContent = "Restoring…";
    post({ password: PW, email: EMAIL, action: "restore", index: index }).then(function (res) {
      if (res.ok) { btn.textContent = "Restored ✓"; setTimeout(function () { location.reload(); }, 700); }
      else { btn.disabled = false; btn.textContent = "Restore"; alert(res.error || "Couldn't restore."); }
    }).catch(function () { btn.disabled = false; btn.textContent = "Restore"; });
  }

  function exit() {
    var ch = collectChanges();
    var dirty = Object.keys(ch.texts).length || Object.keys(ch.images).length || dirtyAdds;
    if (dirty && !exitArmed) { exitArmed = true; setStatus("Unsaved changes — click Exit again to discard.", true); return; }
    location.reload();
  }
  function setStatus(msg, warn) { var s = document.getElementById("cmsStatus"); if (s) { s.textContent = msg; s.className = "cmsStatus" + (warn ? " warn" : " ok"); } }

  /* ---------- helpers ---------- */
  function post(payload) {
    return fetch(CONFIG.WORKER_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return { error: "bad response" }; }); });
  }
  function processImage(file, cb) {
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var maxW = 1400, scale = Math.min(1, maxW / img.width);
      var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      var c = ce("canvas", null); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
      var isPng = /\.png$/i.test(file.name) || file.type === "image/png";
      var dataUrl = c.toDataURL(isPng ? "image/png" : "image/jpeg", 0.88);
      URL.revokeObjectURL(url);
      cb({ dataUrl: dataUrl, b64: dataUrl.split(",")[1], ext: isPng ? "png" : "jpg" });
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }
  function promptInline() { var u = window.prompt("Link address (leave blank to remove the link):", "https://"); return u; }
  function selectAll(el) { try { var r = document.createRange(); r.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); el.focus(); } catch (e) {} }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function qsaIn(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function ce(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function pencil() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'; }

  function injectStyle() {
    var css =
      '#cmsEdit{position:fixed;right:16px;bottom:16px;z-index:9998;display:flex;align-items:center;gap:7px;background:#fff;color:#B60000;border:1.6px solid #B60000;border-radius:999px;padding:9px 16px;font:700 13.5px Montserrat,system-ui,sans-serif;cursor:pointer;opacity:.92;box-shadow:0 3px 14px rgba(120,20,20,.18);transition:.15s}' +
      '#cmsEdit:hover{opacity:1;background:#B60000;color:#fff}' +
      '.cmsOverlay{position:fixed;inset:0;z-index:10000;background:rgba(40,34,32,.45);display:flex;align-items:center;justify-content:center}' +
      '.cmsCard{background:#fff;border-radius:16px;padding:26px;width:360px;max-width:92vw;box-shadow:0 18px 50px rgba(40,30,10,.3);font-family:Montserrat,system-ui,sans-serif}' +
      '.cmsHistCard{width:440px}' +
      '.cmsH{font-weight:800;font-size:19px;color:#393737;display:flex;align-items:center;gap:8px}' +
      '.cmsP{font-size:14px;color:#6b6560;margin:8px 0 14px;line-height:1.5}' +
      '#cmsEmail,#cmsPw{width:100%;padding:11px 13px;border:1px solid #d8ccb6;border-radius:9px;font-size:15px;font-family:inherit}#cmsEmail{margin-bottom:9px}#cmsEmail:focus,#cmsPw:focus{outline:none;border-color:#B60000}' +
      '.cmsErr{color:#B60000;font-size:13px;font-weight:600;min-height:18px;margin:7px 2px 0}' +
      '.cmsRow{display:flex;gap:10px;justify-content:flex-end;margin-top:12px}' +
      '.cmsBtn{background:#B60000;color:#fff;border:0;border-radius:9px;padding:10px 18px;font:700 14px Montserrat,system-ui,sans-serif;cursor:pointer}.cmsBtn:hover{filter:brightness(1.06)}.cmsBtn:disabled{opacity:.6;cursor:default}.cmsBtn.ghost{background:#f3ede2;color:#6b6560}' +
      '.cmsHistList{max-height:320px;overflow:auto;margin:4px 0}' +
      '.cmsHistRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 2px;border-top:1px solid #eee3d3;font-size:14px;color:#54504e}.cmsHistRow:first-child{border-top:0}' +
      '.cmsBar{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#393737;color:#fff;display:flex;align-items:center;gap:16px;padding:11px 18px;font:600 14px Montserrat,system-ui,sans-serif;box-shadow:0 -4px 20px rgba(0,0,0,.2);flex-wrap:wrap}' +
      '.cmsBarT{display:flex;align-items:center;gap:8px}.cmsStatus{font-weight:700;font-size:13.5px}.cmsStatus.ok{color:#8fd6a6}.cmsStatus.warn{color:#ffb4a2}.cmsBarBtns{margin-left:auto;display:flex;gap:10px}' +
      '.cmsTools{position:absolute;z-index:10001;display:flex;align-items:center;gap:4px;background:#2b2a29;padding:6px 8px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.32)}' +
      '.cmsTools button{background:transparent;color:#fff;border:0;border-radius:6px;min-width:26px;height:26px;padding:0 6px;font:700 13px Montserrat,system-ui,sans-serif;cursor:pointer}' +
      '.cmsTools button:hover{background:rgba(255,255,255,.16)}' +
      '.cmsTools .cmsSw{width:18px;height:18px;min-width:18px;padding:0;border-radius:50%;border:1.5px solid rgba(255,255,255,.5)}' +
      '.cmsTools .cmsFont{font-size:12px}.cmsTools .cmsTlab{color:#b9b3ab;font-weight:800;padding:0 2px}.cmsTsep{width:1px;height:18px;background:rgba(255,255,255,.18);margin:0 3px}' +
      'body.cmsLive [data-cms],body.cmsLive .cms-added{outline:1px dashed transparent;outline-offset:3px;border-radius:3px;transition:outline-color .12s,background .12s;cursor:text}' +
      'body.cmsLive [data-cms]:hover,body.cmsLive .cms-added:hover{outline-color:#c9a94f;background:rgba(225,191,75,.10)}' +
      'body.cmsLive [data-cms]:focus,body.cmsLive .cms-added:focus{outline:2px solid #B60000;background:#fff}' +
      'body.cmsLive .cms-added{position:relative}' +
      '.cms-rm{position:absolute;top:-8px;right:-8px;width:20px;height:20px;border-radius:50%;border:0;background:#B60000;color:#fff;font-weight:800;line-height:1;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3);padding:0}' +
      '.cmsAddCtl{margin:8px 0 2px}.cmsAddCtl button{background:#fff;border:1.4px dashed #B60000;color:#B60000;border-radius:9px;padding:6px 13px;font:700 13px Montserrat,system-ui,sans-serif;cursor:pointer}.cmsAddCtl button:hover{background:#B60000;color:#fff}.cmsAddCtl .cmsPlus{font-size:15px;font-weight:800}' +
      'body.cmsLive .cmsImg{cursor:pointer;outline:2px solid transparent;outline-offset:2px;transition:outline-color .12s}body.cmsLive .cmsImg:hover{outline-color:#0479A8;box-shadow:0 0 0 4px rgba(4,121,168,.15)}' +
      'body.cmsLive{padding-bottom:60px}';
    var s = ce("style", null); s.textContent = css; document.head.appendChild(s);
  }
})();
