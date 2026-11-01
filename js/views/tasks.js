import { add, getRecords, remove, subscribe, update } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { nextOccurrence, RECURRENCE_OPTIONS } from "../utils/recurrence.js";
import { parseQuickAdd } from "../utils/quickadd.js";
import { showToast } from "../utils/notifications.js";

const PRIORITY_LABELS = ["مهم وعاجل", "مهم وغير عاجل", "عاجل وغير مهم", "غير عاجل وغير مهم"];
const PRIORITY_GUIDANCE = ["ابدأ بها الآن", "حدّد لها وقتاً", "أنجزها بسرعة", "أجّلها أو استبعدها"];
const VIEWS = [
  { id: "list", label: "القائمة" },
  { id: "upcoming", label: "قادم" },
  { id: "matrix", label: "مصفوفة أيزنهاور" },
  { id: "someday", label: "يوماً ما" },
];

let unsubscribe;
let records = { tasks: [], projects: [], objectives: [], keyResults: [] };
let activeView = "list";
let searchText = "";
let statusFilter = "active";
let projectFilter = "";
let priorityFilter = null;
let priorityCardsOpen = false;
let advancedToolsOpen = false;
let dragTaskId = null;
let swipeGesture;
let eventController;
const expandedTaskSubtasks = new Set();

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function priorityIndex(task) {
  if (task.important && task.urgent) return 0;
  if (task.important) return 1;
  if (task.urgent) return 2;
  return 3;
}

function currentTasks() {
  const query = searchText.trim().toLocaleLowerCase("ar");
  return records.tasks.filter((task) => {
    if (statusFilter === "active" && task.status === "done") return false;
    if (statusFilter === "done" && task.status !== "done") return false;
    if (priorityFilter !== null && priorityIndex(task) !== priorityFilter) return false;
    if (projectFilter && task.projectId !== projectFilter) return false;
    if (!query) return true;
    const project = records.projects.find((item) => item.id === task.projectId)?.name ?? "";
    const searchable = [task.title, task.notes, project, ...(task.tags ?? [])].join(" ").toLocaleLowerCase("ar");
    return searchable.includes(query);
  });
}

function projectName(projectId) {
  return records.projects.find((project) => project.id === projectId)?.name ?? "";
}

function normalizedChecklist(task) {
  return (task.checklist ?? []).map((item) => typeof item === "string"
    ? { id: crypto.randomUUID(), text: item, done: false }
    : item);
}

function subtasksBlock(task) {
  const items = normalizedChecklist(task);
  const doneCount = items.filter((item) => item.done).length;
  const percent = items.length ? Math.round((doneCount / items.length) * 100) : 0;
  return `
    <details class="subtasks"${expandedTaskSubtasks.has(task.id) ? " open" : ""}>
      <summary>مهام فرعية${items.length ? ` <span class="subtask-count">${doneCount}/${items.length}</span>` : ""}</summary>
      ${items.length ? `<div class="subtask-progress" role="progressbar" aria-label="إنجاز المهام الفرعية" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>` : ""}
      <ul class="subtask-list">
        ${items.map((item, index) => `
          <li class="${item.done ? "is-done" : ""}">
            <label><input type="checkbox" data-action="toggle-subtask" data-index="${index}" ${item.done ? "checked" : ""}> <span>${escapeHtml(item.text)}</span></label>
            <button class="icon-button" type="button" data-action="delete-subtask" data-index="${index}" aria-label="حذف المهمة الفرعية">×</button>
          </li>`).join("")}
      </ul>
      <form class="subtask-add" data-subtask-form>
        <input type="text" name="text" placeholder="أضف مهمة فرعية…" aria-label="مهمة فرعية جديدة" maxlength="200">
        <button class="button button-secondary" type="submit">إضافة</button>
      </form>
    </details>`;
}

async function saveChecklist(task, checklist) {
  await update("tasks", { ...task, checklist, updatedAt: new Date().toISOString() });
}

function taskCard(task) {
  const project = projectName(task.projectId);
  const keyResult = records.keyResults.find((item) => item.id === task.keyResultId);
  const objective = records.objectives.find((item) => item.id === task.objectiveId);
  const done = task.status === "done";
  return `
    <div class="task-card-swipe-wrap">
      <span class="task-swipe-hint" aria-hidden="true">✓ إكمال</span>
      <article class="task-card${done ? " is-done" : ""}" data-priority="${priorityIndex(task)}" draggable="${activeView === "matrix" && !done}" data-task-id="${escapeHtml(task.id)}">
      <label class="task-check" aria-label="${done ? "إعادة فتح المهمة" : "إنجاز المهمة"}">
        <input type="checkbox" data-action="toggle" ${done ? "checked" : ""}>
        <span aria-hidden="true"></span>
      </label>
      <div class="task-main">
        <p class="task-title">${escapeHtml(task.title)}</p>
        <div class="task-meta">
          ${project ? `<span class="task-project">${escapeHtml(project)}</span>` : ""}
          ${keyResult ? `<span class="task-target">${escapeHtml(keyResult.title)}</span>` : objective ? `<span class="task-target">${escapeHtml(objective.title)}</span>` : ""}
          ${task.due ? `<span>${escapeHtml(formatDate(task.due))}</span>` : ""}
          ${task.dueTime ? `<span>◷ ${escapeHtml(task.dueTime)}</span>` : ""}
          ${task.estimateMin ? `<span>تركيز مخطط ${task.estimateMin} د</span>` : ""}
          ${task.timeSpentMin ? `<span>تركيز مسجل ${task.timeSpentMin} د</span>` : ""}
          ${task.recurrence ? `<span>↻ ${escapeHtml(RECURRENCE_OPTIONS.find((item) => item.value === task.recurrence)?.label ?? "")}</span>` : ""}
          ${(task.tags ?? []).map((tag) => `<span class="task-tag">#${escapeHtml(tag)}</span>`).join("")}
        </div>
        ${subtasksBlock(task)}
      </div>
      <div class="task-actions">
        <span class="priority-indicator priority-${priorityIndex(task)}" title="${PRIORITY_LABELS[priorityIndex(task)]}">${PRIORITY_LABELS[priorityIndex(task)]}</span>
        ${!done ? `<a class="icon-button task-focus" href="#/focus?task=${encodeURIComponent(task.id)}" aria-label="ابدأ التركيز على ${escapeHtml(task.title)}" title="ابدأ التركيز">◉</a>` : ""}
        <button class="icon-button task-edit" type="button" data-action="edit" aria-label="تعديل المهمة">✎</button>
        <button class="icon-button task-delete" type="button" data-action="delete" aria-label="حذف المهمة">×</button>
      </div>
      </article>
    </div>`;
}

function renderList(tasks) {
  if (!tasks.length) {
    const emptyMessage = statusFilter === "done"
      ? priorityFilter !== null ? `لا توجد مهام منجزة ضمن «${PRIORITY_LABELS[priorityFilter]}».` : "لا توجد مهام منجزة بعد."
      : priorityFilter !== null ? `لا توجد مهام قيد الإنجاز ضمن «${PRIORITY_LABELS[priorityFilter]}».`
      : statusFilter === "all" || !records.tasks.length
        ? "ابدأ بإضافة مهمتك الأولى من الزر أسفل الشاشة."
        : "لا توجد مهام قيد الإنجاز. يمكنك مراجعة المنجزة أو إضافة مهمة جديدة.";
    return `<div class="tasks-empty">${emptyMessage}</div>`;
  }
  const groups = new Map();
  for (const task of tasks) {
    const key = task.projectId || "__inbox__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()].map(([key, grouped]) => `
    <section class="task-group">
      <h3>${key === "__inbox__" ? "الوارد" : escapeHtml(projectName(key) || "مشروع")}</h3>
      <div class="task-list">${grouped.map(taskCard).join("")}</div>
    </section>`).join("");
}

function renderUpcoming(tasks) {
  const datedTasks = tasks.filter((task) => task.due || task.scheduled);
  if (!datedTasks.length) return `<div class="tasks-empty">أضف تاريخاً لمهمة لتظهر هنا ضمن القادم.</div>`;
  const groups = new Map();
  for (const task of datedTasks) {
    const date = task.due || task.scheduled;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(task);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, grouped]) => `
    <section class="task-group">
      <h3>${escapeHtml(formatDate(date))}</h3>
      <div class="task-list">${grouped.map(taskCard).join("")}</div>
    </section>`).join("");
}

function renderMatrix(tasks) {
  return `<div class="priority-matrix">${PRIORITY_LABELS.map((label, index) => `
    <section class="matrix-quadrant quadrant-${index}" data-priority="${index}" aria-label="${label}">
      <h3>${label}</h3>
      <div class="matrix-dropzone" data-dropzone="${index}">
        ${tasks.filter((task) => priorityIndex(task) === index).map(taskCard).join("") || `<p class="matrix-empty">اسحب مهمة إلى هنا</p>`}
      </div>
    </section>`).join("")}</div>`;
}

function renderPriorityCards() {
  const counts = [0, 0, 0, 0];
  for (const task of records.tasks) {
    if (task.status !== "done") counts[priorityIndex(task)] += 1;
  }
  const activeCount = counts.reduce((total, count) => total + count, 0);
  return `<details class="task-priority-panel"${priorityCardsOpen ? " open" : ""}>
    <summary><span>ترتيب الأولوية</span><small>اختر بطاقة لعرض مهامها فقط</small></summary>
    <div class="task-priority-grid">
      ${PRIORITY_LABELS.map((label, index) => {
        const percent = activeCount ? Math.round(counts[index] / activeCount * 100) : 0;
        const selected = priorityFilter === index;
        return `<button class="task-priority-card priority-card-${index}${selected ? " is-selected" : ""}" type="button" data-priority-filter="${index}" aria-pressed="${selected}">
          <span>${label}</span><strong>${counts[index]}</strong><small>${PRIORITY_GUIDANCE[index]}</small>
          <span class="task-priority-track" aria-hidden="true"><i style="width:${percent}%"></i></span>
        </button>`;
      }).join("")}
    </div>
  </details>`;
}

function renderSomeday(tasks) {
  const someday = tasks.filter((task) => task.status !== "done" && !task.scheduled && !task.due);
  return renderList(someday);
}

function renderTaskDaySummary() {
  const today = localDateString();
  const todayTasks = records.tasks.filter((task) =>
    (task.status !== "done" && (task.scheduled === today || task.due === today)) ||
    (task.status === "done" && task.completedAt?.slice(0, 10) === today));
  const completed = todayTasks.filter((task) =>
    task.status === "done" && task.completedAt?.slice(0, 10) === today).length;
  const percent = todayTasks.length ? Math.round(completed / todayTasks.length * 100) : 0;
  const dateLabel = new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  return `<section class="task-day-summary" aria-label="ملخص مهام اليوم">
    <div class="task-day-summary-heading"><span>خطة اليوم</span><time>${escapeHtml(dateLabel)}</time></div>
    <div class="task-day-summary-progress">
      <strong>${completed}<small> / ${todayTasks.length} منجزة</small></strong>
      <span>${todayTasks.length - completed ? `${todayTasks.length - completed} متبقية` : todayTasks.length ? "اكتملت مهام اليوم" : "لا توجد مهام مجدولة اليوم"}</span>
    </div>
    <div class="task-day-progress-track" role="progressbar" aria-label="إنجاز مهام اليوم" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>
  </section>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const tasks = currentTasks();
  const activeCount = records.tasks.filter((task) => task.status !== "done").length;
  const doneCount = records.tasks.filter((task) => task.status === "done").length;
  const visibleTasks = activeView === "someday"
    ? tasks.filter((task) => task.status !== "done" && !task.scheduled && !task.due)
    : activeView === "upcoming"
      ? tasks.filter((task) => task.due || task.scheduled)
      : tasks;
  const body = activeView === "upcoming" ? renderUpcoming(tasks)
    : activeView === "matrix" ? renderMatrix(tasks)
      : activeView === "someday" ? renderSomeday(tasks)
        : renderList(tasks);

  app.innerHTML = `
    <section class="tasks-page" aria-label="إدارة المهام">
      ${renderTaskDaySummary()}
      <nav class="task-status-tabs" aria-label="حالة المهام">
        <button type="button" class="${statusFilter === "active" ? "is-active" : ""}" data-status="active" aria-pressed="${statusFilter === "active"}">قيد الإنجاز <strong>${activeCount}</strong></button>
        <button type="button" class="${statusFilter === "done" ? "is-active" : ""}" data-status="done" aria-pressed="${statusFilter === "done"}">المنجزة <strong>${doneCount}</strong></button>
        <button type="button" class="${statusFilter === "all" ? "is-active" : ""}" data-status="all" aria-pressed="${statusFilter === "all"}">الكل <strong>${records.tasks.length}</strong></button>
      </nav>
      ${renderPriorityCards()}
      <details class="task-tools"${advancedToolsOpen ? " open" : ""}>
        <summary>بحث وعروض متقدمة</summary>
        <div class="task-toolbar">
          <div class="task-view-tabs" role="tablist" aria-label="عرض المهام">
            ${VIEWS.map((view) => `<button class="view-tab${activeView === view.id ? " is-active" : ""}" type="button" role="tab" aria-selected="${activeView === view.id}" data-view="${view.id}">${view.label}</button>`).join("")}
          </div>
          <div class="task-filters">
            <label class="visually-hidden" for="task-search">ابحث في المهام</label>
            <input id="task-search" type="search" placeholder="بحث…" value="${escapeHtml(searchText)}">
            <label class="visually-hidden" for="task-project-filter">تصفية حسب المشروع</label>
            <select id="task-project-filter" aria-label="تصفية حسب المشروع">
              <option value="">كل المشاريع</option>
              ${records.projects.filter((project) => !project.archived).map((project) => `<option value="${escapeHtml(project.id)}"${projectFilter === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
            </select>
            <button class="button button-secondary project-create" type="button" data-action="new-project">مشروع جديد</button>
          </div>
        </div>
      </details>
      <div class="tasks-content">${body}</div>
      <p class="tasks-count">${visibleTasks.length} مهمة</p>
      <p class="tasks-status" id="tasks-status" role="status" aria-live="polite"></p>
      <button class="button button-primary tasks-add-button" type="button" data-action="new-task"><span aria-hidden="true">＋</span> إضافة مهمة</button>
      <dialog class="task-dialog task-add-dialog" id="task-add-dialog">
        <div class="task-add-dialog-heading"><span class="task-add-mark" aria-hidden="true">＋</span><div><p>خطوة جديدة</p><h2>إضافة مهمة</h2></div><button class="icon-button" type="button" data-action="close-add" aria-label="إغلاق">×</button></div>
        <form class="quick-add-form task-add-form" id="quick-add-form">
          <label class="task-add-title-label" for="quick-add-input">ماذا تريد أن تنجز؟</label>
          <input id="quick-add-input" name="task" autocomplete="off" placeholder="اكتب المهمة هنا…" required maxlength="240">
          <div class="quick-add-schedule">
            <label><span>اليوم</span><input id="quick-add-date" name="date" type="date" aria-label="موعد المهمة"></label>
            <label><span>الوقت</span><input id="quick-add-time" name="time" type="time" aria-label="وقت المهمة"></label>
            <label><span>تركيز (د)</span><input id="quick-add-estimate" name="estimateMin" type="number" min="1" max="180" step="1" aria-label="مدة التركيز بالدقائق"></label>
          </div>
          <p class="quick-add-hint">يمكنك إضافة التفاصيل والأولوية بعد الحفظ.</p>
          <button class="button button-primary task-add-submit" type="submit">إضافة للمهمات</button>
        </form>
      </dialog>
      <dialog class="task-dialog" id="task-dialog">
        <form id="task-editor-form" method="dialog">
          <div class="dialog-heading">
            <h2>تفاصيل المهمة</h2>
            <button class="icon-button" type="button" data-action="close-editor" aria-label="إغلاق">×</button>
          </div>
          <input type="hidden" name="id">
          <label>عنوان المهمة<input name="title" required maxlength="240"></label>
          <label>ملاحظات<textarea name="notes" rows="3"></textarea></label>
          <div class="editor-fields">
            <label>تاريخ الجدولة<input name="scheduled" type="date"></label>
            <label>تاريخ الاستحقاق<input name="due" type="date"></label>
            <label>وقت التنفيذ<input name="dueTime" type="time"></label>
            <label>الأولوية<select name="priority">${PRIORITY_LABELS.map((label, index) => `<option value="${index}">${label}</option>`).join("")}</select></label>
            <label>مدة التركيز المستهدفة بالدقائق<input name="estimateMin" type="number" min="1" max="180" step="1"></label>
            <label>المشروع<select name="projectId"><option value="">الوارد</option>${records.projects.filter((project) => !project.archived).map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select></label>
            <label>الهدف<select name="objectiveId"><option value="">بلا هدف</option>${records.objectives.map((objective) => `<option value="${escapeHtml(objective.id)}">${escapeHtml(objective.title)}</option>`).join("")}</select></label>
            <label>النتيجة الرئيسية<select name="keyResultId"><option value="">بلا نتيجة</option>${records.keyResults.map((keyResult) => `<option value="${escapeHtml(keyResult.id)}">${escapeHtml(keyResult.title)}</option>`).join("")}</select></label>
            <label>التكرار<select name="recurrence">${RECURRENCE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("")}</select></label>
          </div>
          <label>الوسوم (افصل بينها بفاصلة)<input name="tags" placeholder="عمل، دراسة"></label>
          <label>قائمة التحقق (عنصر في كل سطر)<textarea name="checklist" rows="3"></textarea></label>
          <div class="dialog-actions">
            <button class="button button-secondary" type="button" data-action="close-editor">إلغاء</button>
            <button class="button button-primary" type="submit">حفظ التعديلات</button>
          </div>
        </form>
      </dialog>
    </section>`;

  bindEvents(app);
}

function setStatus(message, isError = false) {
  const element = document.querySelector("#tasks-status");
  if (element) {
    element.textContent = message;
    element.dataset.state = isError ? "error" : "success";
  }
  showToast(message, { isError });
}

async function createTask(input, dueDate, dueTime, focusDuration) {
  const parsed = parseQuickAdd(input);
  if (!parsed) throw new Error("اكتب عنواناً للمهمة أولاً.");
  const focusDurationMin = focusDuration === "" ? parsed.estimateMin : Number(focusDuration);
  if (focusDurationMin !== null && (!Number.isInteger(focusDurationMin) || focusDurationMin < 1 || focusDurationMin > 180)) {
    throw new Error("مدة التركيز يجب أن تكون بين دقيقة واحدة و3 ساعات.");
  }
  const taskDate = dueDate || parsed.due || parsed.scheduled || (dueTime ? localDateString() : null);
  const task = {
    id: crypto.randomUUID(),
    title: parsed.title,
    notes: "",
    projectId: null,
    objectiveId: null,
    keyResultId: null,
    scheduled: taskDate,
    due: taskDate,
    dueTime: dueTime || null,
    important: parsed.important,
    urgent: parsed.urgent,
    estimateMin: focusDurationMin,
    tags: parsed.tags,
    checklist: [],
    recurrence: parsed.recurrence,
    status: "open",
    completedAt: null,
    timeSpentMin: 0,
    order: Date.now(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (parsed.referenceName) {
    const name = parsed.referenceName.toLocaleLowerCase("ar");
    const project = records.projects.find((item) => item.name.toLocaleLowerCase("ar") === name);
    const objective = records.objectives.find((item) => item.title.toLocaleLowerCase("ar") === name);
    const keyResult = records.keyResults.find((item) => item.title.toLocaleLowerCase("ar") === name);
    if (project) task.projectId = project.id;
    else if (objective) task.objectiveId = objective.id;
    else if (keyResult) {
      task.keyResultId = keyResult.id;
      task.objectiveId = keyResult.objectiveId ?? null;
    }
    else throw new Error(`لم يُعثر على مشروع أو هدف باسم «${parsed.referenceName}». أنشئه أولاً.`);
  }

  await add("tasks", task);
}

async function toggleTask(task) {
  const now = new Date().toISOString();
  if (task.status !== "done") {
    await update("tasks", { ...task, status: "done", completedAt: now, updatedAt: now });
    if (task.recurrence) {
      const nextDate = nextOccurrence(task.scheduled || task.due, task.recurrence);
      await add("tasks", {
        ...task,
        id: crypto.randomUUID(),
        scheduled: nextDate,
        due: task.due ? nextDate : null,
        status: "open",
        completedAt: null,
        order: Date.now(),
        createdAt: now,
        updatedAt: now,
      });
    }
  } else {
    await update("tasks", { ...task, status: "open", completedAt: null, updatedAt: now });
  }
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;

  app.querySelector(".task-tools").addEventListener("toggle", (event) => {
    advancedToolsOpen = event.currentTarget.open;
  });
  app.querySelector(".task-priority-panel").addEventListener("toggle", (event) => {
    priorityCardsOpen = event.currentTarget.open;
  });

  app.addEventListener("pointerdown", (event) => {
    if (activeView === "matrix" || (event.pointerType !== "touch" && event.button !== 0)) return;
    const card = event.target.closest(".task-card");
    if (!card || event.target.closest("button, a, input, select, textarea, summary, details, .task-check")) return;
    const task = records.tasks.find((item) => item.id === card.dataset.taskId);
    if (!task || task.status === "done") return;
    swipeGesture = {
      card,
      wrapper: card.closest(".task-card-swipe-wrap"),
      taskId: task.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    card.setPointerCapture(event.pointerId);
  }, { signal });

  app.addEventListener("pointermove", (event) => {
    if (!swipeGesture || event.pointerId !== swipeGesture.pointerId) return;
    const distanceX = event.clientX - swipeGesture.startX;
    const distanceY = event.clientY - swipeGesture.startY;
    if (Math.abs(distanceY) > Math.abs(distanceX) && Math.abs(distanceY) > 12) {
      swipeGesture.card.releasePointerCapture(event.pointerId);
      swipeGesture = undefined;
      return;
    }
    if (distanceX <= 0) return;
    swipeGesture.card.classList.add("is-swiping");
    swipeGesture.card.style.setProperty("--task-swipe-offset", `${Math.min(distanceX, 112)}px`);
    swipeGesture.wrapper?.style.setProperty("--task-swipe-progress", String(Math.min(1, distanceX / 88)));
  }, { signal });

  const finishSwipe = async (event) => {
    if (!swipeGesture || event.pointerId !== swipeGesture.pointerId) return;
    const gesture = swipeGesture;
    swipeGesture = undefined;
    const distanceX = event.clientX - gesture.startX;
    const distanceY = event.clientY - gesture.startY;
    gesture.card.classList.remove("is-swiping");
    gesture.card.style.removeProperty("--task-swipe-offset");
    gesture.wrapper?.style.removeProperty("--task-swipe-progress");
    if (distanceX < 88 || Math.abs(distanceY) >= distanceX) return;
    const task = records.tasks.find((item) => item.id === gesture.taskId);
    if (!task || task.status === "done") return;
    try {
      await toggleTask(task);
      setStatus("أُنجزت المهمة بالسحب، وتجدها في قائمة المنجزة.");
    } catch (error) {
      console.error("تعذّر إنجاز المهمة بالسحب:", error);
      setStatus(error.message, true);
    }
  };
  app.addEventListener("pointerup", finishSwipe, { signal });
  app.addEventListener("pointercancel", (event) => {
    if (!swipeGesture || event.pointerId !== swipeGesture.pointerId) return;
    swipeGesture.card.classList.remove("is-swiping");
    swipeGesture.card.style.removeProperty("--task-swipe-offset");
    swipeGesture.wrapper?.style.removeProperty("--task-swipe-progress");
    swipeGesture = undefined;
  }, { signal });

  app.addEventListener("click", (event) => {
    const summary = event.target.closest(".subtasks > summary");
    if (!summary) return;
    const details = summary.parentElement;
    const taskId = details.closest("[data-task-id]")?.dataset.taskId;
    if (!taskId) return;
    if (details.open) expandedTaskSubtasks.delete(taskId);
    else expandedTaskSubtasks.add(taskId);
  }, { capture: true, signal });

  app.querySelector("#quick-add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = app.querySelector("#quick-add-input");
    const dateInput = app.querySelector("#quick-add-date");
    const timeInput = app.querySelector("#quick-add-time");
    const focusDurationInput = app.querySelector("#quick-add-estimate");
    try {
      statusFilter = "active";
      priorityFilter = null;
      activeView = "list";
      await createTask(input.value, dateInput.value, timeInput.value, focusDurationInput.value);
      app.querySelector("#quick-add-form")?.reset();
      app.querySelector("#task-add-dialog")?.close();
      setStatus("أُضيفت المهمة.");
    } catch (error) {
      console.error("تعذّرت إضافة المهمة:", error);
      setStatus(error.message, true);
    }
  });

  app.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    activeView = button.dataset.view;
    render();
  }));

  app.querySelector("#task-search").addEventListener("input", (event) => {
    searchText = event.currentTarget.value;
    const position = event.currentTarget.selectionStart;
    render();
    const input = app.querySelector("#task-search");
    input.focus();
    input.setSelectionRange(position, position);
  });

  app.querySelector("#task-project-filter").addEventListener("change", (event) => {
    projectFilter = event.currentTarget.value;
    render();
  });
  app.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => {
    statusFilter = button.dataset.status;
    render();
  }));
  app.querySelectorAll("[data-priority-filter]").forEach((button) => button.addEventListener("click", () => {
    const selected = Number(button.dataset.priorityFilter);
    priorityFilter = priorityFilter === selected ? null : selected;
    statusFilter = "active";
    activeView = "list";
    render();
  }));

  app.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-subtask-form]");
    if (!form) return;
    event.preventDefault();
    const text = form.elements.text.value.trim();
    const task = records.tasks.find((item) => item.id === form.closest("[data-task-id]")?.dataset.taskId);
    if (!text || !task) return;
    try {
      await saveChecklist(task, [...normalizedChecklist(task), { id: crypto.randomUUID(), text, done: false }]);
    } catch (error) {
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("change", async (event) => {
    const sub = event.target.closest('[data-action="toggle-subtask"]');
    if (sub) {
      const task = records.tasks.find((item) => item.id === sub.closest("[data-task-id]")?.dataset.taskId);
      if (!task) return;
      const items = normalizedChecklist(task);
      const item = items[Number(sub.dataset.index)];
      if (!item) return;
      item.done = sub.checked;
      try {
        await saveChecklist(task, items);
        if (items.every((entry) => entry.done) && task.status !== "done") {
          setStatus("اكتملت كل المهام الفرعية. يمكنك إنجاز المهمة الرئيسية.");
        }
      } catch (error) {
        setStatus(error.message, true);
      }
      return;
    }
    const checkbox = event.target.closest('[data-action="toggle"]');
    if (!checkbox) return;
    const taskElement = checkbox.closest("[data-task-id]");
    const task = records.tasks.find((item) => item.id === taskElement?.dataset.taskId);
    if (!task) return;
    try {
      await toggleTask(task);
      setStatus(task.status === "done" ? "أُعيد فتح المهمة، وأصبحت ضمن المهام قيد الإنجاز." : "أُنجزت المهمة، وتجدها في قائمة المنجزة.");
    } catch (error) {
      console.error("تعذّر تحديث المهمة:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "new-task") {
      const form = app.querySelector("#quick-add-form");
      form.reset();
      app.querySelector("#task-add-dialog").showModal();
      requestAnimationFrame(() => app.querySelector("#quick-add-input")?.focus());
      return;
    }
    if (button.dataset.action === "close-add") {
      app.querySelector("#task-add-dialog")?.close();
      return;
    }
    if (button.dataset.action === "new-project") {
      const name = window.prompt("اسم المشروع الجديد:");
      if (!name?.trim()) return;
      try {
        await add("projects", {
          id: crypto.randomUUID(),
          name: name.trim(),
          color: "#6258d9",
          objectiveId: null,
          archived: false,
          order: records.projects.length,
          createdAt: new Date().toISOString(),
        });
        setStatus("أُنشئ المشروع.");
      } catch (error) {
        console.error("تعذّر إنشاء المشروع:", error);
        setStatus(error.message, true);
      }
      return;
    }
    if (button.dataset.action === "delete-subtask") {
      const task = records.tasks.find((item) => item.id === button.closest("[data-task-id]")?.dataset.taskId);
      if (!task) return;
      try {
        await saveChecklist(task, normalizedChecklist(task).filter((_, index) => index !== Number(button.dataset.index)));
      } catch (error) {
        setStatus(error.message, true);
      }
      return;
    }
    if (button.dataset.action === "edit") {
      const taskId = button.closest("[data-task-id]")?.dataset.taskId;
      const task = records.tasks.find((item) => item.id === taskId);
      const dialog = app.querySelector("#task-dialog");
      if (!task || !dialog) return;
      const form = dialog.querySelector("#task-editor-form");
      form.elements.id.value = task.id;
      form.elements.title.value = task.title;
      form.elements.notes.value = task.notes ?? "";
      form.elements.scheduled.value = task.scheduled ?? "";
      form.elements.due.value = task.due ?? "";
      form.elements.dueTime.value = task.dueTime ?? "";
      form.elements.priority.value = String(priorityIndex(task));
      form.elements.estimateMin.value = task.estimateMin ?? "";
      form.elements.projectId.value = task.projectId ?? "";
      form.elements.objectiveId.value = task.objectiveId ?? "";
      form.elements.keyResultId.value = task.keyResultId ?? "";
      form.elements.recurrence.value = task.recurrence ?? "";
      form.elements.tags.value = (task.tags ?? []).join("، ");
      form.elements.checklist.value = (task.checklist ?? []).map((item) => typeof item === "string" ? item : item.text).join("\n");
      dialog.showModal();
      return;
    }
    if (button.dataset.action === "close-editor") {
      app.querySelector("#task-dialog")?.close();
      return;
    }
    if (button.dataset.action === "delete") {
      const taskElement = button.closest("[data-task-id]");
      const task = records.tasks.find((item) => item.id === taskElement?.dataset.taskId);
      if (!task || !window.confirm(`هل تريد حذف «${task.title}»؟`)) return;
      try {
        await remove("tasks", task.id);
        expandedTaskSubtasks.delete(task.id);
        setStatus("حُذفت المهمة.");
      } catch (error) {
        console.error("تعذّر حذف المهمة:", error);
        setStatus(error.message, true);
      }
    }
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const form = event.target.closest("#task-editor-form");
    if (!form) return;
    event.preventDefault();
    const task = records.tasks.find((item) => item.id === form.elements.id.value);
    if (!task) {
      setStatus("لم تعد المهمة موجودة. حدّث الصفحة وحاول مجدداً.", true);
      return;
    }
    const keyResultId = form.elements.keyResultId.value || null;
    const keyResult = records.keyResults.find((item) => item.id === keyResultId);
    const objectiveId = form.elements.objectiveId.value || keyResult?.objectiveId || null;
    if (keyResult?.objectiveId && objectiveId !== keyResult.objectiveId) {
      setStatus("النتيجة الرئيسية المحددة لا تتبع الهدف المختار.", true);
      return;
    }
    const priority = Number(form.elements.priority.value);
    const checklist = form.elements.checklist.value.split("\n").map((line) => line.trim()).filter(Boolean);
    const oldChecklist = Array.isArray(task.checklist) ? task.checklist : [];
    try {
      await update("tasks", {
        ...task,
        title: form.elements.title.value.trim(),
        notes: form.elements.notes.value.trim(),
        scheduled: form.elements.scheduled.value || null,
        due: form.elements.due.value || null,
        dueTime: form.elements.dueTime.value || null,
        important: priority === 0 || priority === 1,
        urgent: priority === 0 || priority === 2,
        estimateMin: form.elements.estimateMin.value ? Number(form.elements.estimateMin.value) : null,
        projectId: form.elements.projectId.value || null,
        objectiveId,
        keyResultId,
        recurrence: form.elements.recurrence.value || null,
        tags: form.elements.tags.value.split(/[,،]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean),
        checklist: checklist.map((text) => oldChecklist.find((item) => typeof item === "object" && item.text === text)
          ?? { id: crypto.randomUUID(), text, done: false }),
        updatedAt: new Date().toISOString(),
      });
      setStatus("حُفظت تعديلات المهمة.");
    } catch (error) {
      console.error("تعذّر حفظ تعديلات المهمة:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".task-card[draggable='true']");
    if (!card) return;
    dragTaskId = card.dataset.taskId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragTaskId);
  }, { signal });
  app.addEventListener("dragover", (event) => {
    const zone = event.target.closest("[data-dropzone]");
    if (zone) event.preventDefault();
  }, { signal });
  app.addEventListener("drop", async (event) => {
    const zone = event.target.closest("[data-dropzone]");
    if (!zone || !dragTaskId) return;
    event.preventDefault();
    const task = records.tasks.find((item) => item.id === dragTaskId);
    const index = Number(zone.dataset.dropzone);
    dragTaskId = null;
    if (!task || !Number.isInteger(index) || index < 0 || index > 3 || priorityIndex(task) === index) return;
    try {
      await update("tasks", {
        ...task,
        important: index === 0 || index === 1,
        urgent: index === 0 || index === 2,
        updatedAt: new Date().toISOString(),
      });
      setStatus("تحدّثت أولوية المهمة.");
    } catch (error) {
      console.error("تعذّر تغيير أولوية المهمة:", error);
      setStatus(error.message, true);
    }
  }, { signal });
}

export async function mountTasksView(isCurrent = () => true) {
  if (unsubscribe) unsubscribe();
  const loadedRecords = {
    tasks: await getRecords("tasks"),
    projects: await getRecords("projects"),
    objectives: await getRecords("objectives"),
    keyResults: await getRecords("keyResults"),
  };
  if (!isCurrent()) return;
  records = loadedRecords;
  document.querySelector("#page-title").textContent = "المهام";
  render();
  unsubscribe = subscribe((state, change) => {
    if (!change.storeName || ["tasks", "projects", "objectives", "keyResults"].includes(change.storeName)) {
      records = {
        ...records,
        tasks: state.tasks ?? records.tasks,
        projects: state.projects ?? records.projects,
        objectives: state.objectives ?? records.objectives,
        keyResults: state.keyResults ?? records.keyResults,
      };
      if (window.location.hash.startsWith("#/tasks")) render();
    }
  });
}

export function unmountTasksView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
}
