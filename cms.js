/* Badger Supports Style Guide — Google Sheets content layer.
   The page shows its built-in content by default. To let non-technical staff
   edit text and swap images from a spreadsheet, do the two steps below.

   SETUP (one time):
   1. Open the "Style Guide Content" Google Sheet, then Share → General access →
      "Anyone with the link" → Viewer.
   2. Copy the Sheet ID from its URL:
      https://docs.google.com/spreadsheets/d/THIS_LONG_ID/edit   ← paste it below.
*/
(function () {
  var SHEET_ID = "";          // ← paste your Google Sheet ID here to turn on editing
  var TAB = "content";        // the tab name (keep as "content")

  if (!SHEET_ID) return;      // no ID yet → the page uses its built-in content

  var url = "https://opensheet.elk.sh/" + SHEET_ID + "/" + TAB;
  fetch(url)
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      rows.forEach(function (row) {
        var type = (row.type || "").trim();
        var key = (row.key || "").trim();
        var val = (row["new value (edit here)"] || "").trim();
        if (!key || !val) return;                 // blank "new value" → leave as built
        if (type === "text") {
          document.querySelectorAll('[data-cms="' + key + '"]').forEach(function (el) {
            el.innerHTML = val;
          });
        } else if (type === "image") {
          var src = toDirect(val);
          document.querySelectorAll('[data-cms-img="' + key + '"]').forEach(function (el) {
            el.src = src;
          });
        }
      });
    })
    .catch(function () { /* sheet unreachable → keep built-in content */ });

  // Turn a Google Drive share link into a direct image URL.
  function toDirect(u) {
    var m = u.match(/\/d\/([-\w]{20,})/) || u.match(/[?&]id=([-\w]{20,})/);
    return m ? "https://drive.google.com/uc?export=view&id=" + m[1] : u;
  }
})();
