export const routes = [
  { id: "today", label: "اليوم", icon: "◷", title: "اليوم" },
  { id: "tasks", label: "المهام", icon: "☷", title: "المهام" },
  { id: "goals", label: "الأهداف", icon: "◎", title: "الأهداف" },
  { id: "habits", label: "العادات", icon: "✳", title: "العادات" },
  { id: "focus", label: "جلسة التركيز", icon: "◉", title: "جلسة التركيز" },
  { id: "journal", label: "اليوميات", icon: "▤", title: "اليوميات والمراجعات" },
  { id: "reports", label: "تقدّمي", icon: "▥", title: "تقدّمي" },
  { id: "settings", label: "الإعدادات", icon: "⚙", title: "الإعدادات" },
];

const compactNavigation = window.matchMedia("(max-width: 720px)");
let navigationElements;

export function getRouteFromHash(hash = window.location.hash) {
  const routeId = hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return routes.find((route) => route.id === routeId) ?? routes[0];
}

export function renderNavigation(navigation, moreNavigation, activeRoute) {
  navigationElements = { navigation, moreNavigation };
  const visibleRoutes = routes;
  const primaryIds = new Set(["today", "tasks", "habits", "reports", "settings"]);
  const primaryRoutes = visibleRoutes.filter((route) => primaryIds.has(route.id));
  const moreRoutes = visibleRoutes.filter((route) => !primaryIds.has(route.id));
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const focusContextRoute = activeRoute.id === "focus"
    ? query.has("task") ? "tasks" : query.has("habit") ? "habits" : "today"
    : activeRoute.id;
  const renderLink = (route) => {
    const current = route.id === focusContextRoute;
    return `
      <a class="nav-link" href="#/${route.id}"${current ? ' aria-current="page"' : ""}>
        <span class="nav-icon" aria-hidden="true">${route.icon}</span>
        <span>${route.label}</span>
      </a>`;
  };
  navigation.innerHTML = primaryRoutes.map(renderLink).join("");
  moreNavigation.innerHTML = "";
}

compactNavigation.addEventListener("change", () => {
  if (navigationElements) {
    renderNavigation(navigationElements.navigation, navigationElements.moreNavigation, getRouteFromHash());
  }
});

export function renderRoute(route, app, title) {
  document.title = `${route.title} — مِحوَر`;
  title.textContent = route.title;
  if (route.id === "today") {
    app.innerHTML = "";
    return;
  }
  if (route.id === "tasks") {
    app.innerHTML = "";
    return;
  }
  if (route.id === "goals") {
    app.innerHTML = "";
    return;
  }
  if (route.id === "habits") {
    app.innerHTML = "";
    return;
  }
  if (route.id === "focus") {
    app.innerHTML = "";
    return;
  }
  if (route.id === "journal" || route.id === "reports") {
    app.innerHTML = "";
    return;
  }
  if (route.id === "settings") {
    app.innerHTML = `
      <section class="settings-grid" aria-label="إعدادات البيانات">
        <header class="settings-page-heading">
          <div><p class="goals-kicker">تحكّم بتجربتك وبياناتك</p><h2>إعدادات مِحوَر</h2></div>
          <p>خيارات التخطيط والتركيز والنسخ الاحتياطي والمزامنة، كلها في مكان واحد.</p>
        </header>
        <article class="settings-card plan-settings-card">
          <span class="settings-icon" aria-hidden="true">▦</span>
          <h2>إيقاع التخطيط</h2>
          <p>اختر طريقة عرض مصفوفة الأهداف. ستُعاد مواءمة فترات أهدافك الحالية مع الخطة الجديدة.</p>
          <label class="visually-hidden" for="active-plan">خطة التخطيط</label>
          <select class="settings-select" id="active-plan">
            <option value="quarterly">ربع سنوي · 4 أرباع</option>
            <option value="monthly">شهري · 12 شهراً</option>
            <option value="trimester">ثلاثي (100) · 3 فترات</option>
          </select>
          <span class="settings-plan-info" id="plan-info"></span>
        </article>
        <article class="settings-card focus-settings-card">
          <span class="settings-icon" aria-hidden="true">◉</span>
          <h2>مدد التركيز</h2>
          <p>خصّص مدد جلسات التركيز والاستراحات بما يناسب إيقاعك.</p>
          <form id="focus-settings-form" class="focus-settings-form">
            <label>جلسة تركيز<input name="focusDurationMin" type="number" min="1" max="180" value="25" required></label>
            <label>استراحة قصيرة<input name="shortBreakMin" type="number" min="1" max="60" value="5" required></label>
            <label>استراحة طويلة<input name="longBreakMin" type="number" min="1" max="90" value="15" required></label>
            <button class="button button-secondary" type="submit">حفظ المدد</button>
          </form>
        </article>
        <article class="settings-card github-settings-card">
          <span class="settings-icon" aria-hidden="true">↔</span>
          <h2>مزامنة GitHub</h2>
          <p>يُحفظ التوكن على هذا الجهاز فقط، ويُرسل إلى GitHub API لإنشاء Gist خاص ومزامنة بياناتك.</p>
          <label for="github-token">Personal access token</label>
          <input class="settings-select" id="github-token" type="password" autocomplete="new-password" placeholder="أدخل التوكن لحفظه محلياً">
          <div class="github-settings-actions">
            <button class="button button-secondary" type="button" data-action="save-token">حفظ التوكن</button>
            <button class="button button-secondary" type="button" data-action="test-github">اختبار الاتصال</button>
            <button class="button button-primary" type="button" data-action="sync-now">مزامنة الآن</button>
          </div>
          <span class="settings-plan-info" id="github-status">لم تُختبر الوصلة بعد.</span>
          <span class="settings-plan-info" id="gist-status">لا يوجد Gist مرتبط.</span>
          <button class="text-button" type="button" data-action="copy-gist" hidden>نسخ رابط Gist الخاص</button>
          <div class="sync-log-list" id="sync-log-list" aria-label="آخر محاولات المزامنة"></div>
        </article>
        <article class="settings-card">
          <span class="settings-icon" aria-hidden="true">⇧</span>
          <h2>نسخة احتياطية</h2>
          <p>احفظ نسخة JSON في المكان الذي تختاره. سيُقترح اسم يحتوي على يوم النسخة وتاريخها.</p>
          <button class="button button-primary" id="export-data" type="button">تصدير البيانات</button>
        </article>
        <article class="settings-card updates-card">
          <span class="settings-icon" aria-hidden="true">✦</span>
          <h2>آخر التحديثات</h2>
          <ul class="settings-updates">
            <li>تذكير أسبوعي يوم الجمعة بالنسخ الاحتياطي.</li>
            <li>اختيار مكان حفظ النسخة عند توفره في المتصفح.</li>
            <li>تسمية كل نسخة باسم اليوم والتاريخ لتسهيل العثور عليها.</li>
            <li>لوحات اليوم والأسبوع والشهر والسنة مع إحصائيات أوضح.</li>
          </ul>
        </article>
        <article class="settings-card">
          <span class="settings-icon" aria-hidden="true">⇩</span>
          <h2>استعادة البيانات</h2>
          <p>استورد نسخة مِحوَر بصيغة JSON. سيؤدي الاستيراد إلى استبدال البيانات الحالية.</p>
          <label class="button button-secondary" for="import-file">اختيار ملف JSON</label>
          <input class="visually-hidden" id="import-file" type="file" accept="application/json,.json">
        </article>
        <p class="settings-note" role="note">بياناتك محفوظة على هذا الجهاز. لا يتضمن ملف التصدير أي توكنات أو بيانات اعتماد.</p>
        <p class="settings-status" id="settings-status" role="status" aria-live="polite"></p>
      </section>`;
    return;
  }

  app.innerHTML = `
    <article class="welcome-card">
      <h2><span class="welcome-dot" aria-hidden="true"></span>${route.title}</h2>
      <p>هذه المساحة جاهزة. ستظهر هنا أدوات ${route.label} في مراحل البناء القادمة.</p>
    </article>`;
}
