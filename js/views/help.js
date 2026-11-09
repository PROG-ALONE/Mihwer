const START_STEPS = [
  {
    title: "أضف مهمة",
    text: "اكتب عنواناً واضحاً فقط؛ الموعد والتفاصيل اختيارية.",
    icon: "＋",
  },
  {
    title: "اختر ما يناسب اليوم",
    text: "تظهر الخارطة كمسار تتناوب محطاته يمينًا ويسارًا. تضيء المحطات المتأخرة غير المنجزة، وتتحول المنجزة إلى الأخضر. عند البداية يظهر نوم الليلة السابقة واستيقاظ اليوم؛ اضغط الصلاة لتسجيل الفرض والسنن، وتظهر الضحى وأذكار الصباح والمساء في أوقاتها. افتح مجموعتي نوافل الليل وسننه عند الحاجة، ثم راجع ملخص اليوم في نهاية المسار. سجّل القيلولة والنوم ليتعلّم مِحوَر إيقاعك.",
    icon: "◷",
  },
  {
    title: "سجّل الإنجاز",
    text: "عند إكمال مهمة أو بلوغ هدف عادة، سجّل وقت الإنجاز ومدته. اختر الشهر أو آخر ٦ أشهر أو السنة أو فترة مخصصة لمراجعة إنجازك وساعاتك. شارك تقرير مهمة من بطاقتها، أو قائمة المهام، أو حصاد اليوم والأسبوع والشهر والسنة؛ ومن «تقدّمي» اختر القسم والفترة والمجال ثم أرسل التقرير أو احفظه PDF أو صدّره إلى Excel وCSV وJSON.",
    icon: "✓",
  },
];

const OPTIONAL_PAGES = [
  { route: "goals", title: "الأهداف", icon: "◎" },
  { route: "habits", title: "العادات", icon: "✳" },
  { route: "journal", title: "اليوميات", icon: "▤" },
  { route: "reports", title: "التقارير", icon: "▥" },
  { route: "settings", title: "الإعدادات", icon: "⚙" },
];

export function renderHelp(app) {
  app.innerHTML = `
    <div class="help-page">
      <header class="guide-hero">
        <div class="guide-hero-copy">
          <p class="guide-eyebrow">دليل سريع</p>
          <h2>ابدأ ببساطة</h2>
          <p class="guide-hero-description">مِحوَر ينظم يومك من دون أن يفرض عليك خطة معقدة. ابدأ بمهمة واحدة، وأضف بقية التفاصيل عند الحاجة.</p>
          <div class="guide-hero-actions">
            <a class="button button-primary" href="#/tasks">أضف مهمة</a>
            <button class="button button-secondary" type="button" data-open-more>افتح المزيد</button>
          </div>
        </div>
        <aside class="guide-hero-aside" aria-label="فكرة مِحوَر">
          <img class="guide-hero-mark" src="./assets/icons/icon.svg" alt="" aria-hidden="true">
          <strong>خطوة واحدة تكفي</strong>
          <p>اختر أولوية المهمة عند إضافتها، ثم اعرضها كطابور أو حسب الأولوية.</p>
        </aside>
      </header>

      <section class="guide-start" aria-labelledby="guide-start-title">
        <div class="guide-block-heading">
          <div><p class="guide-eyebrow">ثلاث خطوات</p><h2 id="guide-start-title">طريقة الاستخدام</h2></div>
          <p>استخدم ما تحتاجه واترك الباقي.</p>
        </div>
        <div class="guide-start-grid">
          ${START_STEPS.map((step, index) => `
            <article class="guide-start-card guide-start-card-${index + 1}">
              <span class="guide-start-number">${index + 1}</span>
              <span class="guide-start-icon" aria-hidden="true">${step.icon}</span>
              <h3>${step.title}</h3>
              <p>${step.text}</p>
            </article>`).join("")}
        </div>
      </section>

      <section class="guide-library" aria-labelledby="guide-library-title">
        <div class="guide-block-heading">
          <div><p class="guide-eyebrow">عند الحاجة</p><h2 id="guide-library-title">أقسام إضافية</h2></div>
          <p>كل قسم اختياري؛ ستجد العادات والتركيز واليوميات والدليل تحت «المزيد»، والإعدادات هناك على الهاتف.</p>
        </div>
        <nav class="guide-nav" aria-label="الأقسام الإضافية">
          ${OPTIONAL_PAGES.map((item) => `
            <a href="#/${item.route}"><span aria-hidden="true">${item.icon}</span>${item.title}</a>`).join("")}
        </nav>
      </section>

      <details class="guide-section">
        <summary class="guide-section-summary">
          <span class="guide-section-icon" aria-hidden="true">⌂</span>
          <span class="guide-section-copy"><strong>الخصوصية والنسخ الاحتياطي</strong><span>بياناتك محفوظة على جهازك.</span></span>
          <span class="guide-section-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="guide-section-body">
          <p>يمكنك تصدير نسخة احتياطية أو استعادتها من الإعدادات. سيذكّرك مِحوَر كل جمعة، ويسمّي الملف باسم اليوم والتاريخ. المزامنة اختيارية عبر GitHub Gist خاص.</p>
        </div>
      </details>
      <footer class="guide-footer">
        <span aria-hidden="true">✦</span>
        <p><strong>تذكير:</strong> التطبيق أداة تساعدك، وليس قائمة يجب أن تنهيها كلها.</p>
      </footer>
    </div>`;
}
