import { createGifFile, pushGifFrame } from "./day-story.js";

const WIDTH = 720;
const HEIGHT = 900;
const BACKGROUND = "#111429";
const CARD = "#1b203a";
const PALETTE = {
  mint: "#6de0ca",
  violet: "#ac9aff",
  gold: "#f0c77c",
  rose: "#f18a9a",
  ink: "#f4f5ff",
  muted: "#b1bad0",
  faint: "#7f8aa7",
};

function roundedRect(context, x, y, width, height, radius) {
  const corner = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + corner, y);
  context.lineTo(x + width - corner, y);
  context.quadraticCurveTo(x + width, y, x + width, y + corner);
  context.lineTo(x + width, y + height - corner);
  context.quadraticCurveTo(x + width, y + height, x + width - corner, y + height);
  context.lineTo(x + corner, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - corner);
  context.lineTo(x, y + corner);
  context.quadraticCurveTo(x, y, x + corner, y);
  context.closePath();
}

function arabicDigits(value) {
  return String(value ?? "").replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);
}

function wrapText(context, value, maxWidth) {
  const lines = [];
  for (const paragraph of String(value ?? "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    if (!paragraph.trim()) lines.push("");
  }
  return lines.length ? lines : [""];
}

function drawText(context, value, x, y, {
  size = 20,
  color = PALETTE.ink,
  weight = 400,
  align = "right",
  maxWidth = WIDTH - 80,
  maxLines = 2,
  lineHeight = size * 1.4,
} = {}) {
  context.direction = "rtl";
  context.textAlign = align;
  context.textBaseline = "alphabetic";
  context.fillStyle = color;
  context.font = `${weight} ${size}px Tahoma, Arial, sans-serif`;
  const lines = wrapText(context, value, maxWidth).slice(0, maxLines);
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight, maxWidth));
  return lines.length;
}

function drawBackground(context, title, period, page, totalPages) {
  const gradient = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#111429");
  gradient.addColorStop(0.58, "#171a35");
  gradient.addColorStop(1, "#101d2d");
  context.fillStyle = gradient;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = context.createRadialGradient(WIDTH - 20, 20, 0, WIDTH - 20, 20, 330);
  glow.addColorStop(0, "#8875ff32");
  glow.addColorStop(1, "#8875ff00");
  context.fillStyle = glow;
  context.fillRect(0, 0, WIDTH, 400);

  drawText(context, "مِحوَر  ·  حكاية إنجازك", WIDTH - 48, 57, {
    size: 17,
    color: PALETTE.mint,
    weight: 700,
  });
  drawText(context, title, WIDTH - 48, 108, { size: 34, weight: 700, maxLines: 1 });
  drawText(context, period, WIDTH - 48, 141, { size: 16, color: PALETTE.muted, maxLines: 1 });
  roundedRect(context, 48, 168, WIDTH - 96, 5, 3);
  context.fillStyle = "#ffffff18";
  context.fill();
  roundedRect(context, 48, 168, (WIDTH - 96) * (page / Math.max(1, totalPages - 1)), 5, 3);
  context.fillStyle = PALETTE.mint;
  context.fill();
}

function drawPanel(context, x, y, width, height, accent = PALETTE.violet) {
  roundedRect(context, x, y, width, height, 20);
  context.fillStyle = CARD;
  context.fill();
  context.strokeStyle = `${accent}45`;
  context.lineWidth = 1;
  context.stroke();
}

function toPercent(value) {
  const match = String(value ?? "").match(/([٠-٩\d]+)\s*٪?/);
  return Math.max(0, Math.min(100, Number(match?.[1]?.replace(/[٠-٩]/g,
    (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))) || 0));
}

function drawRing(context, x, y, percent, radius = 65) {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.strokeStyle = "#ffffff20";
  context.lineWidth = 11;
  context.stroke();
  context.beginPath();
  context.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * percent / 100);
  context.strokeStyle = PALETTE.mint;
  context.lineWidth = 11;
  context.lineCap = "round";
  context.stroke();
  context.lineCap = "butt";
  drawText(context, `${arabicDigits(percent)}٪`, x, y + 9, {
    size: 27,
    weight: 700,
    align: "center",
    maxWidth: radius * 2,
    maxLines: 1,
  });
  drawText(context, "إنجاز الفترة", x, y + 34, {
    size: 12,
    color: PALETTE.muted,
    align: "center",
    maxWidth: radius * 2,
    maxLines: 1,
  });
}

function drawStatCards(context, summary, startY = 205) {
  const columns = 2;
  const gap = 12;
  const width = (WIDTH - 96 - gap) / columns;
  const height = 94;
  summary.slice(0, 4).forEach((stat, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = WIDTH - 48 - width - column * (width + gap);
    const y = startY + row * (height + 10);
    drawPanel(context, x, y, width, height, index % 2 ? PALETTE.violet : PALETTE.mint);
    drawText(context, stat.label, x + width - 18, y + 28, {
      size: 15,
      color: PALETTE.muted,
      maxWidth: width - 36,
      maxLines: 1,
    });
    drawText(context, stat.value, x + width - 18, y + 63, {
      size: 23,
      weight: 700,
      color: index === 0 ? PALETTE.mint : PALETTE.ink,
      maxWidth: width - 36,
      maxLines: 1,
    });
    if (stat.detail) {
      drawText(context, stat.detail, x + width - 18, y + 82, {
        size: 12,
        color: PALETTE.faint,
        maxWidth: width - 36,
        maxLines: 1,
      });
    }
  });
}

function drawChart(context, series, y = 425, activeIndex = -1) {
  const x = 38;
  const width = WIDTH - 76;
  const height = 245;
  drawPanel(context, x, y, width, height, PALETTE.violet);
  drawText(context, "إيقاع إنجازك خلال الفترة", WIDTH - 62, y + 35, {
    size: 21,
    weight: 700,
    maxLines: 1,
  });
  const graph = { x: 82, y: y + 65, width: WIDTH - 130, height: 118 };
  for (const percent of [0, 25, 50, 75, 100]) {
    const gridY = graph.y + graph.height - graph.height * percent / 100;
    context.beginPath();
    context.moveTo(graph.x, gridY);
    context.lineTo(graph.x + graph.width, gridY);
    context.strokeStyle = "#ffffff16";
    context.setLineDash(percent ? [4, 6] : []);
    context.stroke();
  }
  context.setLineDash([]);

  const step = graph.width / Math.max(1, series.length);
  const points = [];
  series.forEach((item, index) => {
    const percent = Math.max(0, Math.min(100, Number(item.metrics?.percent) || 0));
    const centerX = graph.x + step * (index + 0.5);
    const barY = graph.y + graph.height - graph.height * percent / 100;
    const barWidth = Math.min(34, step * 0.56);
    points.push({ x: centerX, y: barY });
    roundedRect(context, centerX - barWidth / 2, barY, barWidth, graph.y + graph.height - barY, 8);
    context.fillStyle = index === activeIndex ? PALETTE.mint : "#8878e8b8";
    context.fill();
  });
  if (points.length > 1) {
    context.beginPath();
    points.forEach((point, index) => {
      if (index) context.lineTo(point.x, point.y);
      else context.moveTo(point.x, point.y);
    });
    context.strokeStyle = PALETTE.mint;
    context.lineWidth = 3;
    context.stroke();
  }
  series.forEach((item, index) => {
    const point = points[index];
    context.beginPath();
    context.arc(point.x, point.y, index === activeIndex ? 6 : 4, 0, Math.PI * 2);
    context.fillStyle = index === activeIndex ? PALETTE.gold : PALETTE.mint;
    context.fill();
    const shortLabel = String(item.title ?? "").slice(0, series.length > 8 ? 5 : 10);
    drawText(context, shortLabel, point.x, graph.y + graph.height + 24, {
      size: series.length > 8 ? 11 : 13,
      color: PALETTE.muted,
      align: "center",
      maxWidth: step + 3,
      maxLines: 1,
    });
    drawText(context, `${arabicDigits(item.metrics?.percent ?? 0)}٪`, point.x, graph.y + graph.height + 44, {
      size: 11,
      color: PALETTE.mint,
      weight: 700,
      align: "center",
      maxWidth: step + 3,
      maxLines: 1,
    });
  });
}

function drawRoute(context, series, activeIndex) {
  const top = 202;
  const bottom = HEIGHT - 84;
  const x = 106;
  const usableHeight = bottom - top;
  context.beginPath();
  context.moveTo(x, top);
  context.lineTo(x, bottom);
  context.strokeStyle = "#ffffff35";
  context.lineWidth = 3;
  context.stroke();
  context.beginPath();
  context.moveTo(x, top);
  context.lineTo(x, top + usableHeight * (activeIndex + 1) / Math.max(1, series.length));
  context.strokeStyle = PALETTE.mint;
  context.lineWidth = 4;
  context.stroke();

  const visibleCount = Math.min(series.length, 12);
  series.slice(0, visibleCount).forEach((item, index) => {
    const y = top + (visibleCount === 1 ? 0 : usableHeight * index / (visibleCount - 1));
    context.beginPath();
    context.arc(x, y, index === activeIndex ? 13 : 9, 0, Math.PI * 2);
    context.fillStyle = index === activeIndex ? PALETTE.gold : index < activeIndex ? PALETTE.mint : "#202642";
    context.fill();
    context.strokeStyle = index === activeIndex ? "#fff2c2" : "#ffffff70";
    context.lineWidth = 2;
    context.stroke();
    drawPanel(context, 145, y - 28, WIDTH - 193, 56, index === activeIndex ? PALETTE.gold : PALETTE.violet);
    drawText(context, item.title, WIDTH - 66, y - 3, { size: 17, weight: 700, maxWidth: 250, maxLines: 1 });
    drawText(context, item.subtitle ?? "", WIDTH - 66, y + 18, { size: 12, color: PALETTE.muted, maxWidth: 250, maxLines: 1 });
    drawText(context, `${arabicDigits(item.metrics?.percent ?? 0)}٪`, 170, y + 8, {
      size: 19,
      weight: 700,
      color: index === activeIndex ? PALETTE.gold : PALETTE.mint,
      maxWidth: 76,
      maxLines: 1,
    });
  });
}

function itemLines(item) {
  const details = (item.details ?? []).map((detail) => typeof detail === "string"
    ? detail
    : `${detail.label}: ${detail.value}`);
  return [item.title, item.detail, ...details].filter(Boolean);
}

function drawDetailsPage(context, section, items, pageIndex, pageCount) {
  drawText(context, section.title, WIDTH - 50, 214, {
    size: 26,
    color: PALETTE.violet,
    weight: 700,
    maxLines: 1,
  });
  drawText(context, `التفاصيل ${arabicDigits(pageIndex + 1)} من ${arabicDigits(pageCount)}`, WIDTH - 50, 246, {
    size: 15,
    color: PALETTE.muted,
    maxLines: 1,
  });
  const rowHeight = 126;
  items.forEach((item, index) => {
    const y = 270 + index * (rowHeight + 14);
    drawPanel(context, 42, y, WIDTH - 84, rowHeight, index % 2 ? PALETTE.violet : PALETTE.mint);
    context.fillStyle = index % 2 ? PALETTE.violet : PALETTE.mint;
    roundedRect(context, WIDTH - 59, y + 16, 4, rowHeight - 32, 2);
    context.fill();
    const lines = itemLines(item);
    const availableLines = Math.floor((rowHeight - 35) / 22);
    let lineY = y + 35;
    for (const [lineIndex, line] of lines.entries()) {
      const wrapped = wrapText(context, line, WIDTH - 142);
      for (const wrappedLine of wrapped) {
        if (lineY > y + rowHeight - 12) break;
        drawText(context, wrappedLine, WIDTH - 77, lineY, {
          size: lineIndex ? 14 : 17,
          color: lineIndex ? PALETTE.muted : PALETTE.ink,
          weight: lineIndex ? 400 : 700,
          maxWidth: WIDTH - 142,
          maxLines: 1,
        });
        lineY += lineIndex ? 20 : 24;
      }
      if (lineY > y + rowHeight - 12) break;
    }
    if (lines.length > availableLines) {
      drawText(context, "…", 68, y + rowHeight - 14, { size: 18, color: PALETTE.gold, maxLines: 1 });
    }
  });
  if (!items.length) {
    drawPanel(context, 42, 270, WIDTH - 84, 100);
    drawText(context, "لا توجد سجلات ضمن هذه الفترة.", WIDTH - 68, 327, {
      size: 18,
      color: PALETTE.muted,
      maxLines: 1,
    });
  }
}

function drawClosingPage(context, title, period, summary, series) {
  drawRing(context, WIDTH / 2, 290, toPercent(summary[0]?.value), 88);
  drawText(context, "رحلتك تستحق الاحتفاء", WIDTH / 2, 424, {
    size: 28,
    color: PALETTE.gold,
    weight: 700,
    align: "center",
    maxLines: 1,
  });
  drawText(context, `${series.length} محطات · ${title}`, WIDTH / 2, 466, {
    size: 19,
    color: PALETTE.ink,
    align: "center",
    maxLines: 1,
  });
  drawText(context, period, WIDTH / 2, 502, {
    size: 17,
    color: PALETTE.muted,
    align: "center",
    maxLines: 1,
  });
  drawStatCards(context, summary, 550);
}

function buildScenes(story) {
  const scenes = [
    { type: "cover", delay: 90 },
    ...story.series.map((_item, index) => ({ type: "route", index, delay: 24 })),
    ...story.sections.flatMap((section) => {
      const items = section.items ?? [];
      const pageCount = Math.max(1, Math.ceil(items.length / 4));
      return Array.from({ length: pageCount }, (_unused, pageIndex) => ({
        type: "details",
        section,
        pageIndex,
        pageCount,
        items: items.slice(pageIndex * 4, (pageIndex + 1) * 4),
        delay: 75,
      }));
    }),
    { type: "closing", delay: 150 },
  ];
  if (scenes.length > 60) {
    throw new Error("التقرير يتضمن تفاصيل كثيرة جدًا لإنشاء GIF واحد. شارك المهام أو الجلسات على دفعات أصغر.");
  }
  return scenes;
}

function drawScene(context, story, scene, page, totalPages) {
  context.clearRect(0, 0, WIDTH, HEIGHT);
  drawBackground(context, story.title, story.period, page, totalPages);
  if (scene.type === "cover") {
    drawRing(context, WIDTH - 152, 300, toPercent(story.summary[0]?.value), 68);
    drawText(context, "هذا حصاد رحلتك", WIDTH - 50, 223, {
      size: 24,
      color: PALETTE.gold,
      weight: 700,
      maxLines: 1,
    });
    drawStatCards(context, story.summary, 405);
    drawText(context, "مرّر لمشاهدة محطاتك وإنجازاتك بالتفصيل", WIDTH / 2, 780, {
      size: 16,
      color: PALETTE.muted,
      align: "center",
      maxLines: 1,
    });
    return;
  }
  if (scene.type === "route") {
    const series = story.series.length ? story.series : [{ title: "لا توجد محطات", metrics: { percent: 0 } }];
    drawText(context, `محطة ${arabicDigits(scene.index + 1)} من ${arabicDigits(series.length)}`, WIDTH - 50, 211, {
      size: 16,
      color: PALETTE.muted,
      maxLines: 1,
    });
    drawRoute(context, series, scene.index);
    const active = series[scene.index];
    drawText(context, `إنجاز ${active.title}: ${arabicDigits(active.metrics?.percent ?? 0)}٪`, WIDTH - 50, HEIGHT - 42, {
      size: 17,
      color: PALETTE.mint,
      weight: 700,
      maxLines: 1,
    });
    return;
  }
  if (scene.type === "details") {
    drawDetailsPage(context, scene.section, scene.items, scene.pageIndex, scene.pageCount);
    return;
  }
  drawClosingPage(context, story.title, story.period, story.summary, story.series);
}

export async function animatedPeriodStoryFile(story) {
  await document.fonts?.ready;
  const scenes = buildScenes(story);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("تعذّر تجهيز لوحة مسار الفترة.");

  const frames = [];
  for (const [index, scene] of scenes.entries()) {
    drawScene(context, story, scene, index, scenes.length);
    pushGifFrame(frames, context, canvas, scene.delay);
    if (index % 2 === 1 && index < scenes.length - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }
  const filename = `mihwar-${story.mode}-${new Date().toISOString().slice(0, 10)}.gif`;
  return createGifFile(frames, WIDTH, HEIGHT, filename);
}
