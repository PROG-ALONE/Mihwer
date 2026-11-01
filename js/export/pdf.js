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
  const metricMaximums = new Map();
  const collectMetrics = (details) => {
    for (const item of details ?? []) {
      for (const metric of item.metrics ?? []) {
        const value = metricNumber(metric.value);
        if (value === null) continue;
        const maximum = metric.percent !== undefined ? 100 : value;
        metricMaximums.set(metric.label, Math.max(metricMaximums.get(metric.label) ?? 0, maximum));
      }
      collectMetrics(item.children);
    }
  };
  Object.values(analytics.sections).forEach((section) => collectMetrics(section.details));
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
  const chartMarkup = analytics.charts.map((chart) => {
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
  const sectionAnalytics = Object.values(analytics.sections).map((section) => `
    <section class="export-stat-section">
      <h3>${escapeHtml(section.label)}</h3>
      ${(() => {
        const maximum = Math.max(0, ...section.metrics.map((metric) => metric.percent !== undefined ? 0 : metricNumber(metric.value) ?? 0));
        return `<div class="export-stat-grid">${section.metrics.map((metric) => `<article class="export-stat-visual">
          <span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong>
          ${visualMetric(metric.label, metric.value, metric.percent !== undefined ? 100 : maximum, metric.percent)}
          <small>${escapeHtml(metric.detail ?? "")}</small>
        </article>`).join("")}</div>`;
      })()}
      ${section.details.length ? `<div class="export-entity-stats">${section.details.map((item) => `
        <article class="${item.visualKind === "habit-items" ? "export-habit-card" : ""}"><strong>${escapeHtml(item.title)}</strong><b>${escapeHtml(item.value)}</b><small>${escapeHtml(item.detail ?? "")}</small>
          <div class="export-entity-visuals">${(item.metrics ?? []).map((metric) => visualMetric(
            metric.label,
            metric.value,
            metric.percent !== undefined ? 100 : metricMaximums.get(metric.label),
            metric.percent,
          )).join("")}</div>
          ${(item.children ?? []).length ? `<div class="export-child-grid">${item.children.map((child) => `<div class="export-child-card"><strong>${escapeHtml(child.label)}</strong><b>${escapeHtml(child.value)}</b><small>${escapeHtml(child.detail ?? "")}</small>
            <div class="export-entity-visuals">${(child.metrics ?? []).map((metric) => visualMetric(
              metric.label,
              metric.value,
              metric.percent !== undefined ? 100 : metricMaximums.get(metric.label),
              metric.percent,
            )).join("")}
              ${child.metrics?.length ? "" : visualMetric("الحالة", child.value, 1, /مكتمل|مسجل/.test(String(child.value)) ? 100 : 0)}
            </div>
          </div>`).join("")}</div>` : ""}
        </article>`).join("")}</div>` : ""}
    </section>`).join("");
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
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p>مِحوَر · ${escapeHtml(period)} · ${escapeHtml(new Date().toLocaleString("ar"))}</p>
    </header>
    <section class="export-analytics">
      <h2>إحصاءات الأقسام والسجلات</h2>
      ${sectionAnalytics}
      <h2>الرسوم البيانية لكل قسم</h2>
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
