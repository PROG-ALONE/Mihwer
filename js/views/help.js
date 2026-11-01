const QUICK_START = [
  {
    title: "أضف ما تريد إنجازه",
    text: "افتح «المهام» واضغط زر الإضافة الثابت أسفل الشاشة. اكتب عنواناً واضحاً، ثم أضف اليوم أو الوقت إذا احتجت.",
    icon: "＋",
  },
  {
    title: "اختر خطوة واحدة",
    text: "من لوحة «اليوم» راجع ما خططت له، وابدأ بالأهم. لا تحتاج إلى ملء كل الأقسام كي تستفيد من التطبيق.",
    icon: "◷",
  },
  {
    title: "سجّل تقدمك",
    text: "أكمل المهمة أو سجّل العادة بلمسة. ستنعكس إنجازاتك على ملخص اليوم والتقارير.",
    icon: "✓",
  },
];

const SECTIONS = [
  {
    id: "tasks",
    title: "المهام",
    icon: "☷",
    color: "#7658e8",
    description: "التقط المهام، رتّب أولوياتك، وحوّل الأعمال الكبيرة إلى خطوات صغيرة.",
    cards: [
      {
        label: "إضافة",
        title: "ابدأ بعنوان واضح",
        text: "من تبويب «المهام» اضغط زر «إضافة مهمة» الثابت أسفل الشاشة. اكتب ما تريد إنجازه، ثم أضف اليوم والوقت ومدة التركيز إن كانت مفيدة.",
        steps: ["اكتب فعلاً واضحاً: «إعداد عرض المشروع» بدلاً من «العرض».", "اضغط «إضافة للمهمات» لحفظها؛ يمكنك إضافة التفاصيل والأولوية لاحقاً."],
        tip: "لا يلزم أن تحدد موعداً لكل مهمة؛ أضف الموعد لما تريد ظهوره ضمن خطة يوم محدد.",
      },
      {
        label: "إدخال سريع",
        title: "اكتب التفاصيل المختصرة في العنوان",
        text: "يمكن لمحرّك الإضافة فهم بعض الرموز أثناء الكتابة، فيجهّز المهمة ويفصل الوسوم والمدة والأولوية عن عنوانها.",
        example: "تحضير العرض !1 #عمل ~30د",
        steps: ["!1 للأهم والعاجل، و!2 للمهم، و!3 للعاجل، و!4 لما ليس مهماً ولا عاجلاً.", "#عمل يضيف وسم «عمل».", "~30د يحدد مدة تركيز مقترحة قدرها 30 دقيقة."],
        tip: "اكتب المدة بالساعات أيضاً، مثل ~1ساعة. ويمكنك كتابة «يومياً» أو «أسبوعياً» أو «شهرياً» للتكرار.",
      },
      {
        label: "ترتيب",
        title: "قسّم المهمة وراجع أولوياتك",
        text: "افتح «مهام فرعية» داخل بطاقة المهمة لإضافة خطوات قصيرة، ثم تابع المنجز من شريط التقدم.",
        steps: ["استخدم البحث والعروض المتقدمة للعثور على مهمة أو تصفيتها حسب المشروع أو الأولوية.", "بطاقات الأولوية اختيارية ومطوية افتراضياً؛ افتحها عندما تريد استخدام مصفوفة أيزنهاور.", "اربط المهمة بمشروع أو هدف أو نتيجة رئيسية لتظهر ضمن تقدمها."],
      },
      {
        label: "إنجاز",
        title: "أكمل المهمة من دون أن تفقدها",
        text: "ضع علامة الإنجاز أو اسحب بطاقة المهمة إلى اليمين. عند الحاجة، افتح قسم المهام المنجزة لإعادتها إلى قائمة العمل.",
        tip: "الإنجاز يحدّث حالة المهمة ولا يحذفها؛ تبقى محفوظة ضمن سجلّك وتقاريرك.",
      },
    ],
  },
  {
    id: "today",
    title: "لوحة اليوم",
    icon: "◷",
    color: "#1d9a83",
    description: "صورة سريعة لما أنجزته وما بقي من مهامك وعاداتك.",
    cards: [
      {
        label: "نظرة عامة",
        title: "ابدأ من ملخص يومك",
        text: "تعرض اللوحة إنجاز المهام والعادات المخططة اليوم، وتفصل أعدادها حتى تعرف أين وصل تقدمك.",
        steps: ["راجع الحلقة والملخص قبل اختيار خطوتك التالية.", "استخدم قائمة المهام المنجزة اليوم لفتح مهمة مكتملة من جديد عند الحاجة."],
      },
      {
        label: "خطة اليوم",
        title: "تابع ما هو مجدول أو متأخر",
        text: "تجمع صفحة اليوم العناصر المرتبطة بتاريخ اليوم وما يحتاج إلى متابعة، لتبقى خطة اليوم في مكان واحد.",
        tip: "إذا لم تظهر مهمة غير مؤرخة في خطة اليوم، راجع قائمة «المهام»؛ قد تكون محفوظة من دون موعد.",
      },
      {
        label: "الشهر",
        title: "لاحظ الاستمرارية لا الكمال",
        text: "يعرض حصاد الشهر المهام المكتملة وثبات العادات ووقت التركيز، مع إبراز العادة الأكثر التزاماً خلال الشهر حتى اليوم.",
      },
    ],
  },
  {
    id: "goals",
    title: "الأهداف والنتائج الرئيسية",
    icon: "◎",
    color: "#d18b28",
    description: "اربط عملك اليومي بنتائج قابلة للقياس.",
    cards: [
      {
        label: "بناء الخطة",
        title: "أنشئ هدفاً ثم حدّد نتائجه",
        text: "ابدأ بمجال من مجالات حياتك، واكتب هدفاً يصف التغيير الذي تريده. بعد ذلك أضف نتائج رئيسية يمكن قياسها.",
        steps: ["اجعل الهدف واضحاً وموجهاً للنتيجة.", "أضف لكل نتيجة قيمة بداية وقيمة مستهدفة، ثم حدّث القيمة الفعلية مع تقدمك.", "اختر فترة الخطة المناسبة من الإعدادات."],
      },
      {
        label: "ربط الإنجاز",
        title: "اجعل المهام تخدم الهدف",
        text: "اربط المهام والأنشطة بالهدف أو النتيجة المناسبة. تتجمع مساهماتها في التقدم، وتظهر الأهداف ونتائجها ضمن التقارير.",
        tip: "راجع النتائج أسبوعياً؛ عدّل الخطوات إذا لم تعد تقرّبك من الهدف.",
      },
    ],
  },
  {
    id: "habits",
    title: "العادات",
    icon: "✳",
    color: "#d35d7b",
    description: "تابع السلوك اليومي بالطريقة التي تناسبه.",
    cards: [
      {
        label: "اختيار النوع",
        title: "لكل عادة طريقة تتبّع",
        text: "أنشئ عادة واختر أسلوب تسجيلها بناءً على طبيعتها.",
        steps: ["تأشير: سجّل هل قمت بالعادة اليوم أم لا.", "عداد: اجمع كمية يومية، مثل عدد الصفحات أو أكواب الماء، بوحدة تختارها.", "بنود: سجّل عناصر مستقلة، وحدد عدد العناصر الذي تريد إنجازه يومياً؛ لا يلزم إكمالها كلها."],
      },
      {
        label: "قائمة البنود",
        title: "أضف عناصر واضحة وسهلة التأشير",
        text: "اكتب كل عنصر في سطر بصيغة النوع ثم الاسم والكمية والوحدة، وافصل بينها بعلامة |.",
        example: "سنة | سنة الفجر | 2 | ركعة",
        tip: "تظهر البنود كعناصر منفصلة؛ حدّد ما أنجزته وسيُحدّث ملخص العادة.",
      },
      {
        label: "الاستمرارية",
        title: "سجّل اليوم وابدأ جلسة عند الحاجة",
        text: "استخدم زر التحقق أو العداد أو البنود داخل بطاقة العادة. تعرض البطاقة ملخص اليوم وسلسلة الالتزام وخريطة النشاط.",
        tip: "يمكنك تحديد مدة تركيز مقترحة للعادة وبدء المؤقت من بطاقتها.",
      },
    ],
  },
  {
    id: "focus",
    title: "جلسات التركيز",
    icon: "◉",
    color: "#4386c8",
    description: "ركّز على مهمة أو عادة وسجّل الوقت عليها مباشرة.",
    cards: [
      {
        label: "البدء",
        title: "المؤقت مرتبط بما تعمل عليه",
        text: "لا تحتاج إلى تبويب مستقل للمؤقت. ابدأ جلسة التركيز من بطاقة مهمة أو عادة، وستُقترح المدة التي حددتها لها.",
        steps: ["اختر المهمة أو العادة التي ستعمل عليها.", "ابدأ الجلسة من بطاقتها، ثم تابعها من لوحة اليوم عند التنقل بين الأقسام."],
      },
      {
        label: "التسجيل",
        title: "راجع وقتك في التقارير",
        text: "تُحفظ الجلسات ويُسجّل الوقت الفعلي على المهمة أو العادة المرتبطة بها، لتتمكن من مراجعة جهدك لاحقاً.",
        tip: "يمكن تعديل مدد الجلسة والاستراحات الافتراضية من الإعدادات.",
      },
    ],
  },
  {
    id: "journal",
    title: "اليوميات والمراجعات",
    icon: "▤",
    color: "#a65fc6",
    description: "احتفظ بملاحظاتك وراجع تقدمك بهدوء.",
    cards: [
      {
        label: "تدوينة اليوم",
        title: "اكتب ما تريد تذكّره",
        text: "افتح «اليوميات» واختر التاريخ. دوّن أهم ما جرى أو ما تريد تذكره، وسجّل مزاجك إذا رغبت.",
        tip: "التدوينة مساحة شخصية؛ يكفي سطر واحد لتثبيت فكرة أو ملاحظة.",
      },
      {
        label: "مراجعة",
        title: "حوّل التجربة إلى خطوة قادمة",
        text: "استخدم المراجعات للتوقف قليلاً أمام أسبوعك: ما الذي سار جيداً؟ ما الذي تعلمته؟ وما الخطوة التالية؟",
        steps: ["اختر المراجعة المناسبة من تبويب المراجعات.", "اكتب إجابات قصيرة وصادقة، ثم احفظها للرجوع إليها لاحقاً."],
      },
    ],
  },
  {
    id: "reports",
    title: "التقارير والتصدير",
    icon: "▥",
    color: "#3982aa",
    description: "شاهد الصورة الأوسع واحتفظ بنسخة من سجلاتك.",
    cards: [
      {
        label: "الاستكشاف",
        title: "اختر الفترة والقسم",
        text: "استخدم التقارير لمراجعة نشاطك خلال فترة محددة أو كامل الفترة. تعرض الأقسام مؤشرات ورسوم وأشرطة تساعدك على ملاحظة التقدم.",
        steps: ["اختر المدة التي تريد مراجعتها.", "انتقل بين أقسام المهام والعادات والأهداف والتركيز واليوميات.", "استخدم التصدير لكل الأقسام أو لقسم بعينه."],
      },
      {
        label: "الصيغ",
        title: "صدّر بالطريقة التي تحتاجها",
        text: "اختر CSV أو Excel أو JSON لتحليل البيانات أو نقلها. استخدم «طباعة / PDF» لحفظ نسخة مرئية أو طباعتها من المتصفح.",
        tip: "قد تختلف طريقة عرض الرسوم حسب صيغة التصدير؛ Excel يتضمن مخططات قابلة للتحرير.",
      },
    ],
  },
  {
    id: "settings",
    title: "الإعدادات والبيانات",
    icon: "⚙",
    color: "#64748b",
    description: "تحكّم بخطة التطبيق واحمِ نسخة من بياناتك.",
    cards: [
      {
        label: "نسخة احتياطية",
        title: "صدّر بياناتك قبل نقل الجهاز",
        text: "من «الإعدادات» نزّل نسخة JSON، واحتفظ بها في مكان آمن. عند الاستيراد، سيُطلب تأكيد استبدال البيانات الحالية.",
        tip: "ملف التصدير لا يتضمن توكنات أو بيانات اعتماد.",
      },
      {
        label: "مزامنة اختيارية",
        title: "استخدم Gist خاصاً إذا احتجت المزامنة",
        text: "يمكن ربط التطبيق بحساب GitHub لإنشاء Gist خاص ومزامنة البيانات بين أجهزتك. يُخزّن الرمز على هذا الجهاز ويُرسل إلى GitHub API فقط.",
        steps: ["أنشئ Personal access token بصلاحية Gist فقط.", "أدخله في إعدادات مِحوَر واختبر الاتصال.", "لا تشارك الرمز مع أحد، ويمكنك استخدام التصدير JSON بدلاً من المزامنة."],
      },
      {
        label: "مكان التخزين",
        title: "بياناتك محلية افتراضياً",
        text: "تُحفظ البيانات على الجهاز في المتصفح، ولا تنتقل إلى خدمة أخرى إلا إذا فعّلت مزامنة GitHub بنفسك.",
      },
    ],
  },
  {
    id: "personalize",
    title: "المظهر والعمل دون اتصال",
    icon: "◐",
    color: "#2c9b69",
    description: "اجعل مِحوَر ملائماً لشاشتك وإيقاعك.",
    cards: [
      {
        label: "المظهر",
        title: "اختر اللوحة التي تريحك",
        text: "بدّل بين المظهر الفاتح والداكن من زر «المظهر» أعلى الصفحة. يُحفظ اختيارك على الجهاز.",
      },
      {
        label: "التثبيت",
        title: "استخدمه كتطبيق على جهازك",
        text: "يمكن تثبيت مِحوَر من قائمة المتصفح إلى الشاشة الرئيسية. بعد فتحه مرة واحدة باتصال بالإنترنت، تُخزّن واجهته المحلية للعمل دون اتصال.",
        tip: "تحتاج المزامنة والروابط الخارجية إلى اتصال بالإنترنت.",
      },
    ],
  },
];

function renderCard(card, index) {
  return `
    <article class="guide-card">
      <div class="guide-card-heading">
        <span class="guide-card-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="guide-card-label">${card.label}</span>
      </div>
      <h3>${card.title}</h3>
      <p>${card.text}</p>
      ${card.example ? `<div class="guide-example"><span>مثال</span><code dir="auto">${card.example}</code></div>` : ""}
      ${card.steps ? `<ol class="guide-steps">${card.steps.map((step) => `<li>${step}</li>`).join("")}</ol>` : ""}
      ${card.tip ? `<aside class="guide-tip"><span aria-hidden="true">✦</span><p><strong>تلميح:</strong> ${card.tip}</p></aside>` : ""}
    </article>`;
}

export function renderHelp(app) {
  app.innerHTML = `
    <div class="help-page">
      <header class="guide-hero">
        <div class="guide-hero-copy">
          <p class="guide-eyebrow"><span aria-hidden="true">✦</span> دليل مِحوَر خطوة بخطوة</p>
          <h2>خطّط بلطف، وتقدّم بطريقتك</h2>
          <p class="guide-hero-description">تعرّف على المهام والعادات والأهداف، واكتشف أين تجد كل ميزة. ابدأ بالخطوات السريعة أو افتح أي بطاقة للشرح التفصيلي.</p>
          <div class="guide-hero-actions">
            <a class="button button-primary" href="#/tasks">ابدأ بإضافة مهمة <span aria-hidden="true">←</span></a>
            <button class="button button-secondary" type="button" id="replay-tour">إعادة الجولة التعريفية</button>
          </div>
        </div>
        <aside class="guide-hero-aside" aria-label="معلومات الدليل">
          <span class="guide-hero-mark" aria-hidden="true">م</span>
          <strong>خطوة صغيرة تكفي</strong>
          <p>ابدأ بما تحتاجه اليوم، وأضف التفاصيل كلما احتجتها.</p>
          <div class="guide-hero-stats">
            <div><strong>${SECTIONS.length}</strong><span>أقسام الدليل</span></div>
            <div><strong>٣</strong><span>خطوات للبداية</span></div>
          </div>
        </aside>
      </header>

      <section class="guide-start" id="guide-start" aria-labelledby="guide-start-title">
        <div class="guide-block-heading">
          <div><p class="guide-eyebrow">بداية هادئة</p><h2 id="guide-start-title">ابدأ بثلاث خطوات</h2></div>
          <p>لا تحتاج إلى إعداد كل شيء الآن.</p>
        </div>
        <div class="guide-start-grid">
          ${QUICK_START.map((step, index) => `
            <article class="guide-start-card guide-start-card-${index + 1}">
              <span class="guide-start-number">${String(index + 1).padStart(2, "0")}</span>
              <span class="guide-start-icon" aria-hidden="true">${step.icon}</span>
              <h3>${step.title}</h3>
              <p>${step.text}</p>
            </article>`).join("")}
        </div>
      </section>

      <section class="guide-library" aria-labelledby="guide-library-title">
        <div class="guide-block-heading">
          <div><p class="guide-eyebrow">مكتبة الشرح</p><h2 id="guide-library-title">استكشف أقسام مِحوَر</h2></div>
          <p>اضغط على القسم لفتح الشرح والبطاقات.</p>
        </div>
        <nav class="guide-nav" aria-label="انتقل إلى قسم في الدليل">
          ${SECTIONS.map((section) => `
            <a href="#/help" data-guide-target="${section.id}">
              <span aria-hidden="true">${section.icon}</span>${section.title}
            </a>`).join("")}
        </nav>
        <div class="guide-sections">
          ${SECTIONS.map((section) => `
            <details class="guide-section" id="guide-section-${section.id}" style="--guide-accent:${section.color}">
              <summary class="guide-section-summary">
                <span class="guide-section-icon" aria-hidden="true">${section.icon}</span>
                <span class="guide-section-copy"><strong>${section.title}</strong><span>${section.description}</span></span>
                <span class="guide-section-meta">${section.cards.length} ${section.cards.length === 2 ? "موضوعان" : "مواضيع"}<span class="guide-section-chevron" aria-hidden="true">⌄</span></span>
              </summary>
              <div class="guide-section-body">
                <div class="guide-card-grid">${section.cards.map(renderCard).join("")}</div>
              </div>
            </details>`).join("")}
        </div>
      </section>
      <footer class="guide-footer">
        <span aria-hidden="true">✦</span>
        <p><strong>تذكير لطيف:</strong> مِحوَر أداة لمساعدتك، لا قائمة يجب أن تنهيها كلها. اختر ما يخدم يومك واترك الباقي.</p>
      </footer>
    </div>`;

  app.querySelector("#replay-tour").addEventListener("click", () => {
    document.querySelector("#onboarding-dialog")?.showModal();
  });
  app.querySelectorAll("[data-guide-target]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    const section = app.querySelector(`#guide-section-${link.dataset.guideTarget}`);
    if (!section) return;
    section.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}
