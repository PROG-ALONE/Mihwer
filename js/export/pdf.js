function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function printReport(sheets, title, period, analytics) {
  const metricNumber = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
    const text = String(value ?? "");
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
    const match = text.match(/^\s*(\d+(?:\.\d+)?)(?:\s*(?:\/|من)\s*(\d+(?:\.\d+)?))?/);
    return match ? Number(match[1]) : null;
  };
  const metricRatio = (value, maximum, percent) => {
    if (percent !== undefined) return Math.min(1, Math.max(0, Number(percent) / 100));
    const text = String(value ?? "");
    const fraction = text.match(/^\s*(\d+(?:\.\d+)?)\s*(?:\/|من)\s*(\d+(?:\.\d+)?)/);
    if (fraction) return Number(fraction[2]) > 0 ? Math.min(1, Number(fraction[1]) / Number(fraction[2])) : 0;
    if (/%/.test(text)) return Math.min(1, Math.max(0, (metricNumber(value) ?? 0) / 100));
    const number = metricNumber(value) ?? 0;
    return maximum > 0 ? Math.min(1, number / maximum) : 0;
  };
  const visualMetric = (label, value, maximum, percent) => {
    const number = metricNumber(value);
    if (number === null) return `<div class="export-visual-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
    const ratio = metricRatio(value, maximum, percent);
    const display = `<svg class="export-metric-bar" viewBox="0 0 100 10" role="img" aria-label="${escapeHtml(label)}: ${escapeHtml(value)}">
      <rect x="0.5" y="0.5" width="99" height="9" rx="4.5" fill="#edf1ed" stroke="#87918a"/>
      ${ratio ? `<rect x="1" y="1" width="${Math.max(1, ratio * 98)}" height="8" rx="4" fill="#468b6b" stroke="#315f4a"/>` : ""}
    </svg>`;
    return `<div class="export-visual-metric"><span>${escapeHtml(label)}</span><div>${display}<strong>${escapeHtml(value)}</strong></div></div>`;
  };
  const featuredCharts = analytics.charts.filter((chart) => [
    "إنجاز المهام عبر الزمن",
    "إنجاز العادات اليومي",
    "دقائق التركيز يومياً",
    "تقدّم الأهداف حسب المجال",
  ].includes(chart.title));
  const chartMarkup = featuredCharts.map((chart) => {
    if (chart.type === "line" && chart.values.length) {
      const chartValues = chart.values.length > 56
        ? Array.from({ length: Math.ceil(chart.values.length / 7) }, (_item, index) => {
          const week = chart.values.slice(index * 7, index * 7 + 7);
          return {
            label: week.at(-1).label,
            value: week.reduce((sum, item) => sum + (Number(item.value) || 0), 0) / week.length,
          };
        })
        : chart.values;
      const width = 640;
      const height = 180;
      const padding = 24;
      const max = Math.max(1, ...chartValues.map((item) => Number(item.value) || 0));
      const points = chartValues.map((item, index) => {
        const x = chartValues.length === 1
          ? width / 2
          : padding + index * (width - padding * 2) / (chartValues.length - 1);
        const y = height - padding - (Number(item.value) || 0) / max * (height - padding * 2);
        return `${x},${y}`;
      });
      const line = points.join(" ");
      const labelIndexes = chartValues.map((_item, index) => index).filter((index) =>
        index === 0 || index === chartValues.length - 1 || index % Math.max(1, Math.floor(chartValues.length / 5)) === 0);
      return `<section class="export-chart"><h3>${escapeHtml(analytics.sections[chart.section]?.label ?? "")} · ${escapeHtml(chart.title)}</h3>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">
          ${[0, 1, 2, 3].map((index) => `<line x1="${padding}" y1="${padding + index * (height - padding * 2) / 3}" x2="${width - padding}" y2="${padding + index * (height - padding * 2) / 3}" stroke="#d7ddd9" stroke-dasharray="4 5"/>`).join("")}
          <polyline points="${line}" fill="none" stroke="#468b6b" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          ${chartValues.map((item, index) => `<circle cx="${points[index].split(",")[0]}" cy="${points[index].split(",")[1]}" r="3" fill="#468b6b"><title>${escapeHtml(item.label)}: ${Number(item.value) || 0} ${escapeHtml(chart.unit)}</title></circle>`).join("")}
          ${labelIndexes.map((index) => `<text x="${points[index].split(",")[0]}" y="${height - 4}" text-anchor="middle" fill="#555" font-size="10">${escapeHtml(chartValues[index].label)}</text>`).join("")}
        </svg>
        <p>${chart.values.length ? `${escapeHtml(chart.values[0].label)}: ${Number(chart.values[0].value) || 0} · ${escapeHtml(chart.values.at(-1).label)}: ${Number(chart.values.at(-1).value) || 0} ${escapeHtml(chart.unit)}` : "لا توجد بيانات ضمن الفترة."}</p>
      </section>`;
    }
    const maximum = Math.max(1, ...chart.values.map((item) => Number(item.value) || 0));
    const width = 640;
    const rowHeight = 30;
    const height = Math.max(76, chart.values.length * rowHeight + 16);
    const labelX = 150;
    const barX = 164;
    const barWidth = 370;
    const valueX = 550;
    return `<section class="export-chart"><h3>${escapeHtml(analytics.sections[chart.section]?.label ?? "")} · ${escapeHtml(chart.title)}</h3>
      ${chart.values.length ? `<svg class="export-bar-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">
        ${chart.values.map((item, index) => {
          const value = Math.max(0, Number(item.value) || 0);
          const y = 8 + index * rowHeight;
          const label = String(item.label ?? "");
          const visibleLabel = label.length > 24 ? `${label.slice(0, 23)}…` : label;
          return `<g><title>${escapeHtml(label)}: ${value} ${escapeHtml(chart.unit)}</title>
            <text x="${labelX}" y="${y + 15}" text-anchor="end" fill="#222" font-size="11">${escapeHtml(visibleLabel)}</text>
            <rect x="${barX}" y="${y + 3}" width="${barWidth}" height="14" rx="3" fill="#f2f4f2" stroke="#8b938d"/>
            ${value ? `<rect x="${barX}" y="${y + 3}" width="${Math.max(1, value / maximum * barWidth)}" height="14" rx="3" fill="#468b6b" stroke="#315f4a"/>` : ""}
            <text x="${valueX}" y="${y + 15}" text-anchor="start" fill="#111" font-size="11">${value} ${escapeHtml(chart.unit)}</text>
          </g>`;
        }).join("")}
      </svg>` : "<p>لا توجد بيانات ضمن الفترة.</p>"}
    </section>`;
  }).join("");
  const summary = analytics.summary;
  const summaryCards = [
    { label: "المهام المنجزة", value: summary.completedTasks, detail: `${summary.completionRate}% من ${summary.taskCount}` },
    { label: "ثبات العادات", value: `${summary.habitCompletion}%`, detail: `${summary.habitCount} عادة نشطة` },
    { label: "وقت التركيز", value: `${Math.floor(summary.focusMinutes / 60)} س ${summary.focusMinutes % 60} د`, detail: `${summary.sessionCount} جلسة` },
    { label: "تقدّم الأهداف", value: `${summary.objectiveProgress}%`, detail: `${summary.objectiveCount} هدف` },
  ].map((item) => `<article><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.detail)}</small></article>`).join("");
  const domainHeatmaps = (analytics.domainHeatmaps ?? []).map((area) => {
    const leadingDays = area.days.length ? new Date(`${area.days[0].date}T12:00:00`).getDay() : 0;
    const max = Math.max(1, ...area.days.map((day) => day.value));
    const cells = [
      ...Array.from({ length: leadingDays }, () => `<i class="export-domain-cell is-empty"></i>`),
      ...area.days.map((day) => {
        const intensity = day.value ? Math.max(1, Math.ceil(day.value / max * 4)) : 0;
        return `<i class="export-domain-cell heat-level-${intensity}" title="${escapeHtml(day.date)} · ${day.value} نشاط"></i>`;
      }),
    ].join("");
    const color = /^#[0-9a-f]{6}$/i.test(area.color ?? "") ? area.color : "#688b78";
    return `<article class="export-domain-card" style="--area-color:${color}">
      <header><strong>${escapeHtml(area.name)}</strong><span>${area.total} نشاط · ${area.activeDays} يوم نشط</span></header>
      <div class="export-domain-heatmap">${cells}</div>
      <small>${area.completedTasks + area.completedSubtasks} مهمة · ${area.completedHabits} عادة · ${area.focusMinutes} دقيقة تركيز</small>
    </article>`;
  }).join("");
  const renderSheetCards = (sheet) => {
    const headers = sheet.rows[0] ?? [];
    const records = sheet.rows.slice(1).filter((row) => row.some((value) => String(value ?? "").trim()));
    const titleIndex = headers.findIndex((header) => /العنوان|العادة|الهدف|المشروع|المهمة|التاريخ/.test(String(header)));
    const habitItemsIndex = headers.findIndex((header) => header === "بنود العادة بالتفصيل");
    if (!records.length) return "<p>لا توجد بيانات ضمن هذا القسم والفترة.</p>";
    return `<div class="export-record-grid">${records.map((row) => {
      const title = titleIndex >= 0 ? row[titleIndex] : "";
      const fields = headers
        .map((label, index) => ({ label, value: row[index] }))
        .filter(({ value }, index) => index !== titleIndex && index !== habitItemsIndex && value !== undefined && value !== null && String(value).trim());
      const habitItems = habitItemsIndex >= 0
        ? String(row[habitItemsIndex] ?? "").split("\n").map((line) => {
          const [category, name, amount, ...unit] = line.split("|").map((part) => part.trim());
          return { category, name, amount, unit: unit.join(" ") };
        }).filter((item) => item.name)
        : [];
      const maxHabitAmount = Math.max(0, ...habitItems.map((item) => metricNumber(item.amount) ?? 0));
      return `<article class="export-record-card">
        ${title ? `<h3>${escapeHtml(title)}</h3>` : ""}
        <div class="export-record-fields">${fields.map(({ label, value }) => {
          const number = metricNumber(value);
          if (number === null) return `<div class="export-record-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
          const maximum = Math.max(number, ...records.map((record) => metricNumber(record[headers.indexOf(label)]) ?? 0));
          return `<div class="export-record-field"><span>${escapeHtml(label)}</span>${visualMetric(label, value, maximum)} </div>`;
        }).join("")}</div>
        ${habitItems.length ? `<section class="export-habit-items" aria-label="بنود العادة بالتفصيل">
          <h4>بنود العادة بالتفصيل <span>${habitItems.length}</span></h4>
          <div class="export-habit-item-grid">${habitItems.map((item) => `<article class="export-habit-item">
            <span>${escapeHtml(item.category || "عام")}</span>
            <strong>${escapeHtml(item.name)}</strong>
            ${visualMetric("الكمية لكل مرة", `${item.amount || 0}${item.unit ? ` ${item.unit}` : ""}`, maxHabitAmount)}
          </article>`).join("")}</div>
        </section>` : ""}
      </article>`;
    }).join("")}</div>`;
  };
  const printView = document.createElement("section");
  printView.className = "print-data-report";
  printView.innerHTML = `
    <header class="export-cover">
      <div><p>مِحوَر · تقرير تقدّمك</p><h1>${escapeHtml(title)}</h1><span><bdi dir="ltr">${escapeHtml(period)}</bdi></span></div>
      <strong aria-hidden="true">م</strong>
      <small>أُعدّ في ${escapeHtml(new Date().toLocaleString("ar"))}</small>
    </header>
    <section class="export-summary"><h2>ملخص الفترة</h2><div>${summaryCards}</div></section>
    ${domainHeatmaps ? `<section class="export-domain-section"><h2>خريطة الإنجاز حسب المجال</h2><p>كل مربع يمثل يوماً؛ قوة اللون توضّح مقدار النشاط.</p><div>${domainHeatmaps}</div></section>` : ""}
    <section class="export-analytics">
      <h2>اتجاهات مختارة</h2>
      ${sheets.some((sheet) => sheet.name === "سجل العادات") ? `<p class="export-aggregation-note">عُرض سجل العادات اليومية كمجاميع لكل بند لتقليل التكرار. السجل اليومي الكامل متاح في CSV وExcel وJSON.</p>` : ""}
      <div class="export-chart-grid">${chartMarkup}</div>
    </section>
    ${sheets.filter((sheet) => sheet.name !== "سجل العادات").map((sheet) => `
      <section>
        <h2>${escapeHtml(sheet.name)}</h2>
        ${renderSheetCards(sheet)}
      </section>`).join("")}`;
  document.body.append(printView);
  document.body.classList.add("printing-data-report");
  window.addEventListener("afterprint", () => {
    printView.remove();
    document.body.classList.remove("printing-data-report");
  }, { once: true });
  window.print();
}
