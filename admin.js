/* Oud & Ink · owner dashboard (visible only to the owner's account; the numbers come from admin_stats(), which checks the email on the server). */
(function () {
  var O = window.OI; if (!O) return;
  var S = O.S, T = O.T, t = O.t, esc = O.esc, render = O.render;
  Object.assign(T.en, { admin: "Dashboard", admT: "Dashboard", admP: "Who has joined Oud & Ink and what they collect. Only you can see this page.", admMembers: "members", admBottles: "perfumes saved", admShared: "public shelves", admReviews: "reviewers", admAI: "searches today", admAIAll: "searches in total", admPeople: "Members", admTop: "Most collected perfumes", admName: "Name", admEmail: "Email", admJoined: "Joined", admLast: "Last visit", admShelf: "Perfumes", admSearch: "Searches", admPublic: "Public shelf", admRefresh: "Refresh", admLoading: "Loading the numbers…", admErr: "Couldn't load the dashboard. Make sure you're signed in with your owner account.", admNone: "No perfumes saved yet.", admOwners: "collectors", admSupabase: "Open full user list in Supabase ↗" });
  Object.assign(T.ar, { admin: "لوحة التحكم", admT: "لوحة التحكم", admP: "من انضم إلى عود وحبر وماذا يجمعون. هذه الصفحة تظهر لك وحدك.", admMembers: "عضو", admBottles: "عطر محفوظ", admShared: "رف عام", admReviews: "مقيّم", admAI: "بحث اليوم", admAIAll: "بحث إجمالاً", admPeople: "الأعضاء", admTop: "العطور الأكثر اقتناءً", admName: "الاسم", admEmail: "البريد", admJoined: "انضم", admLast: "آخر زيارة", admShelf: "العطور", admSearch: "عمليات البحث", admPublic: "رف عام", admRefresh: "تحديث", admLoading: "جارٍ تحميل الأرقام…", admErr: "تعذّر تحميل اللوحة. تأكدي من تسجيل الدخول بحساب المالك.", admNone: "لم يُحفظ أي عطر بعد.", admOwners: "مقتنٍ", admSupabase: "افتحي قائمة المستخدمين كاملة في Supabase ↗" });

  var st = document.createElement("style");
  st.textContent = ".admtbl{width:100%;border-collapse:collapse;font-size:14px}.admtbl th,.admtbl td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:start;vertical-align:top}.admtbl th{color:var(--gold);font-weight:500;white-space:nowrap}.admtbl td small{display:block;color:var(--mute)}.admscroll{overflow-x:auto;margin-top:12px}.admgrid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));margin-top:22px}.admtop li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}.admtop{list-style:none;padding:0;margin:10px 0 0}.admtop small{color:var(--mute)}";
  document.head.appendChild(st);

  var data = null, err = false, busy = false;
  function fmt(d) { if (!d) return "—"; try { return new Date(d).toLocaleDateString(S.lang === "ar" ? "ar-EG" : "en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch (_) { return "—"; } }
  function load() {
    if (busy) return; busy = true; err = false;
    window.OUDINK.supabase.rpc("admin_stats").then(function (r) {
      busy = false;
      if (r.error) { err = true; data = null; } else data = r.data;
      if (S.view === "admin") render();
    }, function () { busy = false; err = true; if (S.view === "admin") render(); });
  }
  window.adminRefresh = function () { data = null; load(); render(); };
  window.adminHTML = function () {
    if (!data && !err) load();
    var head = '<section class="band"><div class="wrap"><h1>' + esc(t("admT")) + '</h1><p style="color:var(--mute)">' + esc(t("admP")) + '</p>';
    if (err) return head + '<p class="empty">' + esc(t("admErr")) + '</p><p><button class="btn ghost" onclick="adminRefresh()">' + esc(t("admRefresh")) + '</button></p></div></section>';
    if (!data) return head + '<p class="empty">' + esc(t("admLoading")) + '</p></div></section>';
    var u = data.users || [], tot = u.reduce(function (a, x) { return a + (x.bottles || 0); }, 0);
    var stats = [[u.length, "admMembers"], [tot, "admBottles"], [data.shelves || 0, "admShared"], [data.reviews || 0, "admReviews"], [data.ai_today || 0, "admAI"], [data.ai_total || 0, "admAIAll"]];
    var h = head + '<div class="stats">' + stats.map(function (s) { return '<div class="stat"><b>' + s[0] + '</b><small>' + esc(t(s[1])) + '</small></div>'; }).join("") + '</div>';
    h += '<p class="acts" style="margin-top:18px"><button class="btn ghost" onclick="adminRefresh()">' + esc(t("admRefresh")) + '</button> <a class="btn ghost" target="_blank" rel="noopener" href="https://supabase.com/dashboard/project/thxwoafnnmuhigstjlah/auth/users">' + esc(t("admSupabase")) + '</a></p>';
    h += '<div class="admgrid"><div class="panel" style="grid-column:1/-1"><h3>' + esc(t("admPeople")) + '</h3><div class="admscroll"><table class="admtbl"><thead><tr><th>' + esc(t("admName")) + '</th><th>' + esc(t("admJoined")) + '</th><th>' + esc(t("admLast")) + '</th><th>' + esc(t("admShelf")) + '</th><th>' + esc(t("admSearch")) + '</th><th>' + esc(t("admPublic")) + '</th></tr></thead><tbody>';
    h += u.map(function (x) { return '<tr><td>' + esc(x.name || "—") + '<small>' + esc(x.email || "") + '</small></td><td>' + fmt(x.created) + '</td><td>' + fmt(x.last) + '</td><td>' + (x.bottles || 0) + (x.bottles !== x.owned ? '<small>' + (x.owned || 0) + ' ' + esc(t("owned")) + '</small>' : '') + '</td><td>' + (x.ai || 0) + '</td><td>' + (x.shared ? "✓" : "—") + '</td></tr>'; }).join("");
    h += '</tbody></table></div></div><div class="panel"><h3>' + esc(t("admTop")) + '</h3>';
    var top = data.top || [];
    h += top.length ? '<ol class="admtop">' + top.map(function (p) { return '<li><span>' + esc(p.name || "") + '<br><small>' + esc(p.brand || "") + '</small></span><span>' + p.n + ' <small>' + esc(t("admOwners")) + '</small></span></li>'; }).join("") + '</ol>' : '<p style="color:var(--mute)">' + esc(t("admNone")) + '</p>';
    h += '</div></div></div></section>';
    return h;
  };
  if (S.view === "admin" || location.hash === "#admin") { S.view = "admin"; }
  try { render(); } catch (_) {}
})();
