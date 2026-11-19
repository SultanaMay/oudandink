/* Oud & Ink standalone runtime.
 * Provides window.claude.use(name) — the same interface the app was built on —
 * backed by Supabase (accounts, data, realtime) and a Supabase Edge Function
 * that calls the Claude API. The app code itself stays unchanged.
 */
(function () {
  "use strict";
  var CFG = window.OUDINK_CONFIG || {};
  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" }
  });
  var currentUser = null;

  /* ---------- helpers ---------- */
  var SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function parentOf(p) { return p.slice(0, p.lastIndexOf("/")); }
  function idOf(p) { return p.slice(p.lastIndexOf("/") + 1); }
  function checkPath(p, isDoc) {
    var s = String(p).split("/");
    if (s.some(function (x) { return !SEG.test(x) || x === "." || x === ".."; })) throw new TypeError("Invalid path: " + p);
    if ((s.length % 2 === 0) !== isDoc) throw new TypeError("Wrong number of segments for " + (isDoc ? "document" : "collection") + ": " + p);
  }
  function mapErr(e) {
    var m = (e && e.message) || "";
    var c = e && e.code;
    if (c === "42501" || c === "23514" || c === "22P02" || /row-level security|violates check/i.test(m)) return { code: "invalid_argument", message: m };
    if (c === "PGRST301" || /JWT|expired/i.test(m)) return { code: "revoked", message: m };
    return { code: "unavailable", message: m || "network" };
  }
  var META = { fromCache: false, hasPendingWrites: false };
  function snapDoc(path, row) {
    return row
      ? { id: idOf(path), exists: true, data: function () { return row.data; }, metadata: META }
      : { id: idOf(path), exists: false, data: function () { return undefined; }, metadata: META };
  }
  function deepMerge(a, b) {
    var o = Object.assign({}, a);
    Object.keys(b).forEach(function (k) {
      var v = b[k];
      if (v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) o[k] = deepMerge(o[k], v);
      else o[k] = v;
    });
    return o;
  }

  /* ---------- live updates ---------- */
  var listeners = new Map(); // collection path -> Set(refresh fn)
  function bump(col) { var s = listeners.get(col); if (s) s.forEach(function (f) { f(); }); }
  function bumpAll() { listeners.forEach(function (s) { s.forEach(function (f) { f(); }); }); }
  var channel = null;
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel("docs-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, function (pl) {
        var p = (pl.new && pl.new.parent) || (pl.old && pl.old.parent);
        if (p) bump(p); else bumpAll();
      })
      .subscribe();
  }

  /* ---------- db ---------- */
  function colRef(path, q) {
    checkPath(path, false);
    q = q || { w: [], o: null, l: null };
    function run() {
      var r = sb.from("docs").select("path,data").eq("parent", path);
      q.w.forEach(function (w) {
        var f = w[0], op = w[1], v = w[2], col = "data->>" + f;
        if (op === "==") r = r.eq(col, String(v));
        else if (op === "!=") r = r.neq(col, String(v));
        else if (op === "in") r = r.in(col, v.map(String));
        else if (op === "array-contains") { var c = {}; c[f] = [v]; r = r.contains("data", c); }
      });
      r = r.limit(q.l || 1000);
      return r.then(function (res) {
        if (res.error) throw mapErr(res.error);
        var docs = (res.data || []).map(function (x) { return snapDoc(x.path, x); });
        if (q.o) {
          var f = q.o[0], dir = q.o[1] === "desc" ? -1 : 1;
          docs.sort(function (a, b) { var x = a.data()[f], y = b.data()[f]; return (x > y ? 1 : x < y ? -1 : 0) * dir; });
        }
        return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: META };
      });
    }
    function newId() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^A-Za-z0-9]/g, ""); }
    return {
      path: path,
      doc: function (id) { return docRef(path + "/" + (id || newId())); },
      add: function (d) { var r = docRef(path + "/" + newId()); return r.set(d).then(function () { return r; }); },
      where: function (f, op, v) { return colRef(path, { w: q.w.concat([[f, op, v]]), o: q.o, l: q.l }); },
      orderBy: function (f, d) { return colRef(path, { w: q.w, o: [f, d], l: q.l }); },
      limit: function (n) { return colRef(path, { w: q.w, o: q.o, l: n }); },
      get: run,
      onSnapshot: function (next, error) {
        var alive = true, timer = null;
        function refresh() {
          clearTimeout(timer);
          timer = setTimeout(function () {
            if (!alive) return;
            run().then(function (s) { if (alive) next(s); }, function () { /* retry on next change */ });
          }, 120);
        }
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(refresh);
        ensureChannel();
        run().then(function (s) { if (alive) next(s); }, function (e) { if (error) error(e); });
        var poll = setInterval(refresh, 30000);
        return function () { alive = false; clearInterval(poll); listeners.get(path).delete(refresh); };
      }
    };
  }
  function docRef(path) {
    checkPath(path, true);
    var col = parentOf(path);
    function get() {
      return sb.from("docs").select("path,data").eq("path", path).maybeSingle().then(function (res) {
        if (res.error) throw mapErr(res.error);
        return snapDoc(path, res.data);
      });
    }
    function set(d) {
      if (!d || typeof d !== "object" || Array.isArray(d)) return Promise.reject({ code: "invalid_argument", message: "Body must be an object" });
      var body = JSON.parse(JSON.stringify(d));
      return sb.from("docs").upsert({ path: path, parent: col, data: body, updated_at: new Date().toISOString() }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        bump(col);
      });
    }
    return {
      id: idOf(path), path: path, get: get, set: set,
      update: function (d) {
        return get().then(function (s) {
          if (!s.exists) throw { code: "invalid_argument", message: "Document does not exist" };
          return set(deepMerge(s.data(), d));
        });
      },
      delete: function () {
        return sb.from("docs").delete().eq("path", path).then(function (res) {
          if (res.error) throw mapErr(res.error);
          bump(col);
        });
      },
      onSnapshot: function (next, error) {
        return colRef(col).onSnapshot(function (s) {
          var d = s.docs.find(function (x) { return x.id === idOf(path); });
          next(d || snapDoc(path, null));
        }, error);
      },
      collection: function (sub) { return colRef(path + "/" + sub); },
      acquire: function () { return Promise.resolve({ acquired: true }); }
    };
  }
  var db = { doc: docRef, collection: colRef };

  /* ---------- user ---------- */
  var user = {
    id: function () { return Promise.resolve(currentUser ? currentUser.id : null); },
    isOwner: function () {
      return !!(currentUser && CFG.OWNER_EMAIL && (currentUser.email || "").toLowerCase() === String(CFG.OWNER_EMAIL).toLowerCase());
    },
    canEdit: function () { return false; },
    can: function (n) { return n === "data.write" ? !!currentUser : null; },
    me: function () {
      var m = (currentUser && currentUser.user_metadata) || {};
      return Promise.resolve({ id: currentUser ? currentUser.id : "", name: m.full_name || m.name || "", avatar: m.avatar_url || "" });
    },
    profiles: function (ids) { var o = {}; (ids || []).forEach(function (i) { o[i] = { id: i, name: "" }; }); return Promise.resolve(o); },
    search: function () { return Promise.resolve([]); }
  };

  /* ---------- Claude (via Edge Function) ---------- */
  function blobToB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(",")[1]); };
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function prepImage(blob) {
    if (!window.createImageBitmap) return blobToB64(blob).then(function (d) { return { media_type: blob.type || "image/jpeg", data: d }; });
    return createImageBitmap(blob).then(function (bmp) {
      var s = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return { media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] };
    }, function () {
      return blobToB64(blob).then(function (d) { return { media_type: blob.type || "image/jpeg", data: d }; });
    });
  }
  var cache = new Map();
  function callClaude(input, opts, asJson) {
    opts = opts || {};
    if (!currentUser) return Promise.reject({ code: "not_granted", message: "Sign in to use Claude" });
    if (opts.signal && opts.signal.aborted) return Promise.reject({ code: "cancelled", message: "cancelled" });
    var messages = typeof input === "string"
      ? [{ role: "user", content: input }]
      : (input || []).map(function (m) { return { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }; });
    if (!messages.length) return Promise.reject({ code: "invalid_request", message: "empty input" });
    var list = !opts.images ? [] : (opts.images instanceof Blob ? [opts.images] : Array.prototype.slice.call(opts.images));
    var key = (opts.cache === false || list.length) ? null : JSON.stringify([messages, asJson, opts.modelTier || ""]);
    var ttl = (opts.cache && opts.cache.gcTime) || 300000;
    if (key && cache.has(key) && Date.now() - cache.get(key).t < ttl) return Promise.resolve(cache.get(key).v);
    return Promise.all(list.slice(0, 4).map(prepImage)).then(function (images) {
      return sb.functions.invoke("claude", { body: { messages: messages, images: images, json: !!asJson, tier: opts.modelTier || "default" } });
    }).then(function (res) {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled", message: "cancelled" };
      if (res.error) {
        var st = res.error.context && res.error.context.status;
        throw { code: st === 429 ? "rate_limited" : st === 401 ? "session_expired" : st === 413 ? "prompt_too_large" : "upstream_error", message: res.error.message };
      }
      var data = res.data || {};
      if (!data.text) throw { code: "empty_completion", message: "No answer" };
      var v = { text: data.text, truncated: !!data.truncated, modelTierApplied: opts.modelTier || "default" };
      if (key) cache.set(key, { t: Date.now(), v: v });
      if (opts.onText) { try { opts.onText({ text: v.text, delta: v.text }); } catch (e) { /* ignore */ } }
      return v;
    });
  }
  function parseJSON(t) {
    try { return JSON.parse(t); } catch (e) { /* continue */ }
    var m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1]); } catch (e) { /* continue */ } }
    var a = [t.indexOf("{"), t.indexOf("[")].filter(function (i) { return i >= 0; });
    var start = a.length ? Math.min.apply(null, a) : -1, end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* continue */ } }
    throw { code: "invalid_json", message: "No JSON in reply", text: t };
  }
  var sample = function (input, opts) { return callClaude(input, opts, false); };
  sample.json = function (input, opts) { return callClaude(input, opts, true).then(function (r) { return parseJSON(r.text); }); };
  sample.limits = function () {
    return Promise.resolve({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 20000000, mediaTypes: ["image/jpeg", "image/png", "image/webp"] } });
  };

  /* ---------- downloads ---------- */
  var downloads = {
    save: function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = o.filename || "download";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return Promise.resolve({ status: "saved" });
    }
  };

  /* ---------- sign-in button in the header ---------- */
  var L = {
    en: { in: "Sign in with Google", out: "Sign out" },
    ar: { in: "تسجيل الدخول بجوجل", out: "تسجيل الخروج" }
  };
  function lang() { return document.documentElement.lang === "ar" ? "ar" : "en"; }
  function paintAuth() {
    var host = document.getElementById("authbox");
    if (!host) {
      var langBtn = document.getElementById("lang");
      if (!langBtn) return;
      host = document.createElement("div");
      host.id = "authbox";
      langBtn.parentNode.insertBefore(host, langBtn);
    }
    var t = L[lang()];
    if (currentUser) {
      var m = currentUser.user_metadata || {};
      var pic = m.avatar_url ? '<img src="' + String(m.avatar_url).replace(/"/g, "") + '" alt="" referrerpolicy="no-referrer">' : "";
      host.innerHTML = pic + '<button type="button" class="authbtn ghostish" id="signout">' + t.out + "</button>";
    } else {
      host.innerHTML = '<button type="button" class="authbtn" id="signin"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>' + t.in + "</button>";
    }
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("#signin,#signout");
    if (!b) return;
    if (b.id === "signin") {
      sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
    } else {
      sb.auth.signOut().then(function () { location.reload(); });
    }
  });
  new MutationObserver(paintAuth).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

  /* ---------- the claude.use() entry point ---------- */
  var ready = sb.auth.getSession().then(function (r) {
    currentUser = (r.data && r.data.session && r.data.session.user) || null;
    sb.auth.onAuthStateChange(function (event, session) {
      var u = (session && session.user) || null;
      var changed = (u && u.id) !== (currentUser && currentUser.id);
      currentUser = u;
      if (changed && (event === "SIGNED_IN" || event === "SIGNED_OUT")) location.reload();
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paintAuth); else paintAuth();
  }, function () { /* offline: continue signed out */ });

  var caps = { db: db, user: user, sample: sample, downloads: downloads };
  window.claude = {
    use: function (name) { return ready.then(function () { return caps[name] || null; }); }
  };
  window.OUDINK = { supabase: sb };
})();
