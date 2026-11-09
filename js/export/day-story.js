const PALETTE_LEVELS = [
  [0, 24, 52, 84, 124, 170, 215, 255],
  [0, 24, 52, 84, 124, 170, 215, 255],
  [0, 48, 128, 255],
];
const PALETTE_INDEX = PALETTE_LEVELS.map((levels) => Uint8Array.from({ length: 256 }, (_value, channel) =>
  levels.reduce((nearest, level, index) =>
    Math.abs(level - channel) < Math.abs(levels[nearest] - channel) ? index : nearest, 0)));

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function compressLzw(pixels) {
  const clearCode = 256;
  const endCode = 257;
  const codeSize = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  const bytes = [];
  const writeCode = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  writeCode(clearCode);
  for (let start = 0; start < pixels.length; start += 200) {
    const dictionary = new Map();
    let nextCode = 258;
    const end = Math.min(start + 200, pixels.length);
    let prefix = pixels[start];
    for (let index = start + 1; index < end; index += 1) {
      const symbol = pixels[index];
      const key = prefix * 256 + symbol;
      const match = dictionary.get(key);
      if (match !== undefined) {
        prefix = match;
      } else {
        writeCode(prefix);
        dictionary.set(key, nextCode);
        nextCode += 1;
        prefix = symbol;
      }
    }
    writeCode(prefix);
    if (end < pixels.length) writeCode(clearCode);
  }
  writeCode(endCode);
  if (bitCount) bytes.push(bitBuffer & 255);
  return Uint8Array.from(bytes);
}

function toGifBytes(frames, width, height) {
  const chunks = [];
  const write = (...values) => chunks.push(Uint8Array.from(values));
  const writeBlocks = (values) => {
    for (let offset = 0; offset < values.length; offset += 255) {
      const block = values.subarray(offset, offset + 255);
      chunks.push(Uint8Array.of(block.length), block);
    }
    chunks.push(Uint8Array.of(0));
  };
  const writeWord = (value) => write(value & 255, value >> 8 & 255);
  write(...new TextEncoder().encode("GIF89a"));
  writeWord(width);
  writeWord(height);
  write(0xf7, 0, 0);
  for (let index = 0; index < 256; index += 1) {
    write(
      PALETTE_LEVELS[0][(index >> 5) & 7],
      PALETTE_LEVELS[1][(index >> 2) & 7],
      PALETTE_LEVELS[2][index & 3],
    );
  }
  write(0x21, 0xff, 0x0b, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  for (const frame of frames) {
    const packed = frame.transparent ? 0x0d : 0x04;
    write(0x21, 0xf9, 4, packed);
    writeWord(frame.delay);
    write(0, 0);
    write(0x2c);
    writeWord(frame.left);
    writeWord(frame.top);
    writeWord(frame.width);
    writeWord(frame.height);
    write(0, 8);
    writeBlocks(frame.compressed);
  }
  write(0x3b);
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function formatArabicNumber(value) {
  return String(value ?? "").replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);
}

function wrapText(context, text, maxWidth, maxLines) {
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    if (!paragraph.trim()) lines.push("");
  }
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = `${clipped[maxLines - 1].replace(/[.…]+$/, "")}…`;
  return clipped;
}

function drawTextLines(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const lines = wrapText(context, text, maxWidth, maxLines);
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight, maxWidth));
  return lines.length;
}

function quantizeFrame(imageData, transparent = false) {
  const source = imageData.data;
  const pixels = new Uint8Array(source.length / 4);
  for (let sourceIndex = 0, pixelIndex = 0; sourceIndex < source.length; sourceIndex += 4, pixelIndex += 1) {
    if (transparent && source[sourceIndex + 3] < 96) {
      pixels[pixelIndex] = 0;
    } else {
      pixels[pixelIndex] = (PALETTE_INDEX[0][source[sourceIndex]] << 5)
        | (PALETTE_INDEX[1][source[sourceIndex + 1]] << 2)
        | PALETTE_INDEX[2][source[sourceIndex + 2]];
    }
  }
  return pixels;
}

function eventColor(progress) {
  const amount = Math.max(0, Math.min(1, Number(progress) || 0));
  const stops = amount < 0.5
    ? ["#e56c78", "#e7ae4c", amount * 2]
    : ["#e7ae4c", "#36bd7a", (amount - 0.5) * 2];
  const from = stops[0].match(/[a-f\d]{2}/gi).map((value) => Number.parseInt(value, 16));
  const to = stops[1].match(/[a-f\d]{2}/gi).map((value) => Number.parseInt(value, 16));
  return `#${from.map((value, index) => Math.round(value + (to[index] - value) * stops[2])
    .toString(16).padStart(2, "0")).join("")}`;
}

function eventStatus(status) {
  if (status === "done") return "مكتملة";
  if (status === "partial") return "مكتملة جزئيًا";
  return "لم تُسجّل";
}

function eventKind(event) {
  if (event.kind === "task") return "مهمة";
  if (event.kind === "habit") return "عادة";
  if (event.kind === "prayer") return "صلاة";
  if (event.kind === "night") return "قيام الليل";
  if (event.role === "wake") return "بداية اليوم";
  if (event.role === "bed") return "النوم";
  if (event.role === "nap") return "قيلولة";
  if (event.kind === "end") return "ختام اليوم";
  return "محطة اليوم";
}

function storyDetailCards(story, event, maxCards = 6) {
  const cards = [];
  if (event.kind === "end") {
    const summary = event.summary ?? {};
    const sleep = event.sleepSummary ?? {};
    if (maxCards <= 2) {
      cards.push({
        title: "ملخص المحطات",
        body: `مكتملة ${formatArabicNumber(summary.completed ?? 0)} · جزئية ${formatArabicNumber(summary.partial ?? 0)} · غير مكتملة ${formatArabicNumber(summary.pending ?? 0)}`,
        color: "#80dfd7",
      });
      if (maxCards === 2) {
        cards.push({
          title: "الإنجاز والنوم",
          body: `الإنجاز ${formatArabicNumber(story.score)}٪ · الاستيقاظ ${sleep.wakeTime || "غير مسجل"} · النوم ${sleep.bedTime || "غير مسجل"}`,
          color: eventColor(story.score / 100),
        });
      } else {
        cards[0].body += ` · الإنجاز ${formatArabicNumber(story.score)}٪ · الاستيقاظ ${sleep.wakeTime || "غير مسجل"} · النوم ${sleep.bedTime || "غير مسجل"}`;
      }
    } else {
      cards.push(
        { title: "المحطات المكتملة", body: formatArabicNumber(summary.completed ?? 0), color: "#36bd7a" },
        { title: "المحطات الجزئية", body: formatArabicNumber(summary.partial ?? 0), color: "#e7ae4c" },
        { title: "المحطات غير المكتملة", body: formatArabicNumber(summary.pending ?? 0), color: "#e56c78" },
        { title: "إنجاز اليوم", body: `${formatArabicNumber(story.score)}٪`, color: eventColor(story.score / 100) },
        { title: "الاستيقاظ والنوم", body: `${sleep.wakeTime || "غير مسجل"} · ${sleep.bedTime || "غير مسجل"}` },
      );
    }
  } else {
    const lines = Array.isArray(event.detailLines) && event.detailLines.length
      ? event.detailLines.map((line) => String(line).trim()).filter(Boolean)
      : String(event.detail ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    const makeItemCard = (line) => {
      const match = line.match(/^([✓○])\s*(.*)$/);
      return {
        title: match ? match[2] : line,
        body: match ? match[1] === "✓" ? "تم التسجيل" : "لم يُسجّل بعد" : "",
        color: match ? match[1] === "✓" ? "#36bd7a" : "#e7ae4c" : undefined,
      };
    };

    if (event.kind === "prayer" && event.prayerCounts) {
      const { fardDone = 0, fardTotal = 0, sunnahDone = 0, sunnahTotal = 0 } = event.prayerCounts;
      cards.push({
        title: "الفرض",
        body: `${formatArabicNumber(fardDone)} من ${formatArabicNumber(fardTotal)} ركعة`,
        color: fardDone >= fardTotal && fardTotal > 0 ? "#36bd7a" : "#e7ae4c",
      });
      if (sunnahTotal > 0) {
        cards.push({
          title: "السنن",
          body: `${formatArabicNumber(sunnahDone)} من ${formatArabicNumber(sunnahTotal)} ركعة`,
          color: sunnahDone >= sunnahTotal ? "#36bd7a" : "#e7ae4c",
        });
      }
      const itemLines = lines.filter((line) => /^[✓○]\s/.test(line));
      itemLines.forEach((line) => cards.push(makeItemCard(line)));
      lines.filter((line) => !/^(?:الفرض:|السنة:|[✓○]\s)/.test(line)).forEach((line) => cards.push({ title: "معلومة", body: line }));
    } else {
      lines.forEach((line, index) => {
        cards.push(makeItemCard(line));
        if (event.kind === "task" && index === 0 && event.time) {
          cards.push({
            title: event.timeIsActual ? "وقت الإنجاز" : "موعد المهمة",
            body: event.time,
            color: event.timeIsActual ? "#8cecdf" : "#c5b6ec",
          });
        }
      });
    }

    if (event.time && event.kind !== "task") {
      const timeCard = {
        title: event.timeIsActual ? "وقت التسجيل" : "الموعد",
        body: event.time,
        color: event.timeIsActual ? "#8cecdf" : "#c5b6ec",
      };
      if (event.kind === "prayer") cards.push(timeCard);
      else cards.unshift(timeCard);
    }
  }
  if (!cards.length) cards.push({ title: "الحالة", body: eventStatus(event.status) });

  if (cards.length > maxCards) {
    const remaining = cards.splice(maxCards - 1);
    cards.push({
      title: "بقية التفاصيل",
      body: remaining.map((card) => [card.title, card.body].filter(Boolean).join(" · ")).join(" / "),
      color: "#a9bad3",
    });
  }
  return cards;
}

function drawBackground(context, width, height) {
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#111b31");
  background.addColorStop(0.52, "#15132a");
  background.addColorStop(1, "#0b1020");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(width * 0.78, height * 0.2, 0, width * 0.78, height * 0.2, width * 0.85);
  glow.addColorStop(0, "#463a7833");
  glow.addColorStop(1, "#463a7800");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  for (let star = 0; star < Math.ceil(height / 30); star += 1) {
    const x = (star * 197 + 31) % width;
    const y = (star * 113 + 17) % height;
    context.globalAlpha = 0.22 + (star % 5) * 0.1;
    context.fillStyle = "#dbeafe";
    context.beginPath();
    context.arc(x, y, star % 9 === 0 ? 1.7 : 1, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

function drawHeader(context, story, width) {
  context.direction = "rtl";
  context.textAlign = "right";
  context.fillStyle = "#80dfd7";
  context.font = "bold 16px Tahoma, Arial, sans-serif";
  context.fillText("مِحوَر · خارطة اليوم", width - 28, 27);
  context.fillStyle = "#f4f4ff";
  context.font = "bold 24px Tahoma, Arial, sans-serif";
  context.fillText(`يوم ${story.name}`, width - 28, 55);
  context.textAlign = "center";
  context.fillStyle = "#b9bfd2";
  context.font = "14px Tahoma, Arial, sans-serif";
  context.fillText(story.dateLabel, width / 2, 51);
  context.textAlign = "left";
  context.fillStyle = eventColor(story.score / 100);
  context.font = "bold 20px Tahoma, Arial, sans-serif";
  context.fillText(`${formatArabicNumber(story.score)}٪`, 28, 45);
  const barX = 28;
  const barY = 65;
  const barWidth = width - 56;
  roundedRect(context, barX, barY, barWidth, 6, 3);
  context.fillStyle = "#ffffff20";
  context.fill();
  roundedRect(context, barX, barY, Math.max(story.score ? 4 : 0, barWidth * story.score / 100), 6, 3);
  context.fillStyle = eventColor(story.score / 100);
  context.fill();
}

function drawStation(context, event, index, width, y, rowHeight, centerX, isActive) {
  const mapIndex = Number.isFinite(event.mapIndex) ? event.mapIndex : index;
  const centered = ["wake", "bed"].includes(event.role) || event.kind === "night";
  const side = centered ? "center" : mapIndex % 2 === 0 ? "right" : "left";
  const color = eventColor(event.progress);
  const cardWidth = centered
    ? event.kind === "night" ? Math.min(width - 128, 520) : Math.min(width - 128, 430)
    : centerX - 58;
  const cardHeight = centered
    ? Math.min(event.kind === "night" ? rowHeight - 8 : 76, rowHeight - 6)
    : Math.min(78, rowHeight - 6);
  const cardX = centered ? (width - cardWidth) / 2 : side === "right" ? centerX + 34 : 24;
  const cardY = y - cardHeight / 2;

  if (!centered) {
    const cardEdge = side === "right" ? cardX : cardX + cardWidth;
    context.strokeStyle = `${color}80`;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(centerX, y);
    context.lineTo(cardEdge, y);
    context.stroke();
  }
  context.fillStyle = "#17132b";
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(centerX, y, 7, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  roundedRect(context, cardX, cardY, cardWidth, cardHeight, 14);
  const cardBackground = context.createLinearGradient(cardX, cardY, cardX + cardWidth, cardY + cardHeight);
  cardBackground.addColorStop(0, isActive ? "#29264b" : "#1d1a39");
  cardBackground.addColorStop(1, isActive ? "#1a2340" : "#13162b");
  context.fillStyle = cardBackground;
  context.fill();
  context.strokeStyle = isActive ? "#80dfd7" : "#ffffff22";
  context.lineWidth = isActive ? 2 : 1;
  context.stroke();
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(cardX + cardWidth - 1, cardY + 11);
  context.lineTo(cardX + cardWidth - 1, cardY + cardHeight - 11);
  context.stroke();

  context.direction = "rtl";
  context.textAlign = "right";
  const textRight = cardX + cardWidth - 15;
  const title = event.mapTitle ?? event.title ?? "محطة اليوم";
  const compactDetail = event.kind === "prayer"
    ? `الفرض ${formatArabicNumber(event.prayerCounts?.fardDone ?? 0)} من ${formatArabicNumber(event.prayerCounts?.fardTotal ?? 0)} · السنة ${formatArabicNumber(event.prayerCounts?.sunnahDone ?? 0)} من ${formatArabicNumber(event.prayerCounts?.sunnahTotal ?? 0)}`
    : event.checklistDetail || event.detailLines?.[0] || event.detail || eventStatus(event.status);
  const isCrowded = rowHeight < 54;
  context.fillStyle = "#f4f4ff";
  const titleSize = isCrowded
    ? Math.max(8, Math.min(14, cardHeight * 0.45))
    : Math.max(8, Math.min(16, cardHeight * 0.22));
  const detailSize = Math.max(7, Math.min(12, cardHeight * 0.16));
  context.font = `bold ${titleSize}px Tahoma, Arial, sans-serif`;
  const titleY = isCrowded
    ? cardY + Math.min(cardHeight - 2, Math.max(titleSize + 1, cardHeight * 0.68))
    : cardY + Math.min(30, cardHeight * 0.4);
  drawTextLines(context, title, textRight, titleY, cardWidth - 30, titleSize + 2, 1);
  if (!isCrowded && cardHeight >= 40) {
    context.fillStyle = "#b7bfd2";
    context.font = `${detailSize}px Tahoma, Arial, sans-serif`;
    drawTextLines(context, compactDetail, textRight, cardY + Math.min(48, cardHeight * 0.69), cardWidth - 30, detailSize + 2, centered ? 2 : 1);
  }

  const barX = cardX + 13;
  const barY = cardY + cardHeight - 2;
  const barWidth = cardWidth - 26;
  drawProgressBar(context, barX, barY, barWidth, event.progress, color);

  if (event.time) {
    const timeText = event.timeIsActual ? `✓ ${event.time}` : event.time;
    context.textAlign = side === "right" ? "left" : "right";
    context.fillStyle = event.timeIsActual ? "#8cecdf" : "#a49dbd";
    context.font = "bold 12px Tahoma, Arial, sans-serif";
    context.fillText(timeText, side === "right" ? 24 : width - 24, y + 4, centerX - 64);
  }
  return {
    y,
    side: side === "center" ? "right" : side,
    x: centerX,
    cardX,
    cardY,
    cardWidth,
    cardHeight,
    centered,
  };
}

function drawSummaryStation(context, event, width, y, rowHeight, isActive) {
  const color = eventColor(1);
  const cardWidth = Math.min(width - 128, 520);
  const cardX = (width - cardWidth) / 2;
  const cardHeight = Math.min(72, rowHeight - 6);
  const cardY = y - cardHeight / 2;
  roundedRect(context, cardX, cardY, cardWidth, cardHeight, 14);
  context.fillStyle = "#1a1c32";
  context.fill();
  context.strokeStyle = isActive ? "#80dfd7" : "#ffffff22";
  context.lineWidth = isActive ? 2 : 1;
  context.stroke();
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(cardX + cardWidth - 1, cardY + 11);
  context.lineTo(cardX + cardWidth - 1, cardY + cardHeight - 11);
  context.stroke();
  context.fillStyle = "#30294c";
  context.beginPath();
  const iconRadius = Math.min(15, cardHeight * 0.23);
  context.arc(cardX + cardWidth - 29, y, iconRadius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#edddff";
  context.textAlign = "center";
  context.font = `${Math.max(8, iconRadius)}px Tahoma, Arial, sans-serif`;
  context.fillText("☾", cardX + cardWidth - 29, y + iconRadius * 0.4);
  context.fillStyle = "#f4f4ff";
  context.direction = "rtl";
  context.textAlign = "right";
  const titleSize = Math.max(9, Math.min(16, cardHeight * 0.22));
  context.font = `bold ${titleSize}px Tahoma, Arial, sans-serif`;
  context.fillText(event.mapTitle ?? "ختام اليوم", cardX + cardWidth - 53, cardY + Math.min(29, cardHeight * 0.42));
  context.fillStyle = "#a9bad3";
  context.font = `${Math.max(7, Math.min(11, cardHeight * 0.16))}px Tahoma, Arial, sans-serif`;
  const summary = event.summary ?? {};
  const summaryLine = `مكتملة ${formatArabicNumber(summary.completed ?? 0)} · جزئية ${formatArabicNumber(summary.partial ?? 0)} · لم تكتمل ${formatArabicNumber(summary.pending ?? 0)}`;
  drawTextLines(context, summaryLine, cardX + cardWidth - 53, cardY + Math.min(46, cardHeight * 0.68), cardWidth - 77, 12, 1);
  context.textAlign = "left";
  context.fillStyle = color;
  context.font = "bold 14px Tahoma, Arial, sans-serif";
  const scoreMatch = String(event.detail ?? "").match(/إنجاز اليوم\s+([٠-٩\d]+٪)/);
  context.fillText(scoreMatch?.[1] ?? "", cardX + 13, y + 4);
  return { y, side: "right", cardX, cardY, cardWidth, cardHeight, centered: true };
}

function drawMap(context, story, width, height, events, activeIndex) {
  drawBackground(context, width, height);
  drawHeader(context, story, width);
  const routeTop = 92;
  const rowHeight = Math.min(112, (height - routeTop - 22) / Math.max(events.length, 1));
  const centerX = width / 2;
  const routeBottom = routeTop + rowHeight * (events.length - 1);
  const route = context.createLinearGradient(0, routeTop, 0, routeBottom || routeTop + 1);
  route.addColorStop(0, "#64dfd3");
  route.addColorStop(0.48, "#9a8bff");
  route.addColorStop(1, "#f2bf83");
  context.strokeStyle = route;
  context.lineWidth = 3;
  context.shadowColor = "#9a8bff88";
  context.shadowBlur = 12;
  context.beginPath();
  context.moveTo(centerX, routeTop - 16);
  context.lineTo(centerX, routeBottom + 16);
  context.stroke();
  context.shadowBlur = 0;

  const arrowStops = [];
  events.forEach((event, index) => {
    const y = routeTop + index * rowHeight;
    const stop = event.kind === "end"
      ? drawSummaryStation(context, event, width, y, rowHeight, index === activeIndex)
      : drawStation(context, event, index, width, y, rowHeight, centerX, index === activeIndex);
    stop.cameraX = stop.cardX + stop.cardWidth / 2;
    stop.cameraY = stop.cardY + stop.cardHeight / 2;
    arrowStops.push(stop);
  });

  return { routeTop, rowHeight, centerX, arrowStops };
}

function pushFrame(frames, context, canvas, delay) {
  const pixels = quantizeFrame(context.getImageData(0, 0, canvas.width, canvas.height));
  frames.push({
    left: 0,
    top: 0,
    width: canvas.width,
    height: canvas.height,
    delay,
    transparent: false,
    compressed: compressLzw(pixels),
  });
}

export function pushGifFrame(frames, context, canvas, delay = 16) {
  pushFrame(frames, context, canvas, delay);
}

export function createGifFile(frames, width, height, filename) {
  return new File([toGifBytes(frames, width, height)], filename, { type: "image/gif" });
}

function drawProgressBar(context, x, y, width, progress, color, height = 3) {
  roundedRect(context, x, y, width, height, height / 2);
  context.fillStyle = "#ffffff30";
  context.fill();
  if (progress > 0) {
    roundedRect(context, x, y, Math.max(height, width * Math.min(1, progress)), height, height / 2);
    context.fillStyle = color;
    context.fill();
  }
}

function drawStoryDetail(context, event, index, total, story, cards, visibleCards, width, height) {
  const color = eventColor(event.progress);
  const panelX = 2080;
  const panelY = 190;
  const panelWidth = width - panelX - 100;
  const panelHeight = height - panelY - 180;
  roundedRect(context, panelX, panelY, panelWidth, panelHeight, 38);
  context.fillStyle = "#151a30";
  context.fill();
  context.strokeStyle = "#ffffff20";
  context.lineWidth = 3;
  context.stroke();
  context.strokeStyle = color;
  context.lineWidth = 8;
  context.beginPath();
  context.moveTo(panelX + panelWidth - 4, panelY + 38);
  context.lineTo(panelX + panelWidth - 4, panelY + panelHeight - 38);
  context.stroke();

  const right = panelX + panelWidth - 90;
  const textWidth = panelWidth - 180;
  const isEnd = event.kind === "end";
  context.direction = "rtl";
  context.textAlign = "right";
  context.fillStyle = "#80dfd7";
  context.font = "bold 48px Tahoma, Arial, sans-serif";
  context.fillText(
    isEnd ? "حصاد اليوم" : `المحطة ${formatArabicNumber(index + 1)} من ${formatArabicNumber(total)}`,
    right,
    panelY + 108,
  );
  context.fillStyle = "#aeb8ce";
  context.font = "38px Tahoma, Arial, sans-serif";
  context.fillText(isEnd ? story.dateLabel : eventKind(event), right, panelY + 174);

  const titleY = panelY + 320;
  context.fillStyle = "#f4f4ff";
  context.font = "bold 88px Tahoma, Arial, sans-serif";
  const titleLines = drawTextLines(
    context,
    event.mapTitle ?? event.title ?? "محطة اليوم",
    right,
    titleY,
    textWidth,
    110,
    2,
  );

  const statusY = titleY + titleLines * 110 + 70;
  context.fillStyle = color;
  context.font = "bold 46px Tahoma, Arial, sans-serif";
  context.fillText(isEnd ? `إنجاز اليوم ${formatArabicNumber(story.score)}٪` : eventStatus(event.status), right, statusY);

  context.strokeStyle = "#ffffff24";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(panelX + 90, statusY + 110);
  context.lineTo(right, statusY + 110);
  context.stroke();

  const detailStart = statusY + 220;
  const detailBottom = panelY + panelHeight - 120;
  const sectionY = detailStart - 48;
  const gap = 18;
  const cardHeight = Math.min(340, (detailBottom - detailStart - gap * (cards.length - 1)) / cards.length);
  context.fillStyle = "#dce4f6";
  context.direction = "rtl";
  context.textAlign = "right";
  context.font = "bold 32px Tahoma, Arial, sans-serif";
  context.fillText(
    `تفاصيل المحطة · ${formatArabicNumber(visibleCards)} من ${formatArabicNumber(cards.length)}`,
    right,
    sectionY,
  );
  cards.slice(0, visibleCards).forEach((card, cardIndex) => {
    const cardY = detailStart + cardIndex * (cardHeight + gap);
    const cardX = panelX + 75;
    const cardWidth = panelWidth - 150;
    roundedRect(context, cardX, cardY, cardWidth, cardHeight, 20);
    context.fillStyle = cardIndex === visibleCards - 1 ? "#242441" : "#1b2036";
    context.fill();
    context.strokeStyle = "#ffffff1c";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = card.color ?? color;
    context.fillRect(cardX + cardWidth - 8, cardY + 20, 6, cardHeight - 40);
    context.direction = "rtl";
    context.textAlign = "right";
    context.fillStyle = "#f4f4ff";
    context.font = `bold ${Math.max(28, Math.min(46, cardHeight * 0.3))}px Tahoma, Arial, sans-serif`;
    context.fillText(card.title, right - 4, cardY + Math.floor(cardHeight * 0.42), textWidth - 30);
    if (card.body) {
      context.fillStyle = card.color ?? "#c5cde0";
      const bodySize = Math.max(22, Math.min(34, cardHeight * 0.14));
      context.font = `${bodySize}px Tahoma, Arial, sans-serif`;
      const bodyLineHeight = bodySize * 1.2;
      const bodyY = cardY + Math.floor(cardHeight * 0.65);
      const bodyLines = Math.max(1, Math.floor((cardHeight * 0.96 - (bodyY - cardY)) / bodyLineHeight) + 1);
      drawTextLines(context, card.body, right - 4, bodyY, textWidth - 30, bodyLineHeight, bodyLines);
    }
  });

  const percent = isEnd
    ? Math.max(0, Math.min(1, Number(story.score) / 100 || 0))
    : Math.max(0, Math.min(1, Number(event.progress) || 0));
  const barY = panelY + panelHeight - 76;
  drawProgressBar(context, panelX + 90, barY, panelWidth - 180, percent, color, 18);
}

function drawStoryFrame(context, output, map, story, events, index, cards, visibleCards) {
  const activeEvent = events[index];
  const width = output.width;
  const height = output.height;

  drawBackground(context, width, height);
  context.drawImage(map, 10, 110, map.width, map.height);
  context.direction = "rtl";
  context.textAlign = "right";
  context.fillStyle = "#80dfd7";
  context.font = "bold 48px Tahoma, Arial, sans-serif";
  context.fillText("مِحوَر · خارطة اليوم", width - 95, 92);
  context.fillStyle = "#f4f4ff";
  context.font = "bold 62px Tahoma, Arial, sans-serif";
  context.fillText(`يوم ${story.name}`, width - 95, 158);
  drawStoryDetail(context, activeEvent, index, events.length, story, cards, visibleCards, width, height);
  const isFinalCard = visibleCards === cards.length;
  pushFrame(output.frames, context, output.canvas, isFinalCard ? index === events.length - 1 ? 360 : 220 : 110);
}

export async function animatedDayStoryFile(story) {
  await document.fonts?.ready;
  const width = 3840;
  const height = 2160;
  const events = story.events.length ? story.events : [{
    kind: "end",
    mapTitle: "يوم هادئ",
    detail: "لا توجد محطات مسجلة لهذا اليوم.",
    status: "pending",
    progress: 0,
    summary: { completed: 0 },
  }];
  const maxFrames = Math.floor(800_000_000 / (width * height));
  if (events.length > maxFrames) {
    throw new Error("عدد محطات اليوم يتجاوز الحد الآمن لمشاركة GIF بدقة 4K. قسّم اليوم إلى فترتين.");
  }
  const maxCardsPerEvent = Math.min(6, Math.floor(maxFrames / events.length));
  const cardsByEvent = events.map((event) => storyDetailCards(story, event, maxCardsPerEvent));
  const frameCount = cardsByEvent.reduce((total, cards) => total + cards.length, 0);
  if (width * height * frameCount > 800_000_000) {
    throw new Error("تفاصيل هذا اليوم أكثر من الحد الآمن لفيديو GIF بدقة 4K. جرّب مشاركة اليوم على فترتين.");
  }
  const map = document.createElement("canvas");
  map.width = 2000;
  map.height = 2020;
  const mapContext = map.getContext("2d", { willReadFrequently: true });
  if (!mapContext) throw new Error("تعذّر تجهيز لوحة الخارطة.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("تعذّر تجهيز إطارات GIF المتحركة.");
  const output = { canvas, width, height, frames: [] };
  const mapScale = map.width / 800;
  for (let index = 0; index < events.length; index += 1) {
    mapContext.clearRect(0, 0, map.width, map.height);
    mapContext.save();
    mapContext.scale(mapScale, mapScale);
    drawMap(mapContext, story, map.width / mapScale, map.height / mapScale, events, index);
    mapContext.restore();
    const cards = cardsByEvent[index];
    for (let visibleCards = 1; visibleCards <= cards.length; visibleCards += 1) {
      drawStoryFrame(context, output, map, story, events, index, cards, visibleCards);
      if (visibleCards % 2 === 0 && (visibleCards < cards.length || index < events.length - 1)) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }
  const frames = output.frames;
  const bytes = toGifBytes(frames, width, height);
  return new File([bytes], `mihwar-day-${story.date.replaceAll("-", "")}.gif`, { type: "image/gif" });
}

export async function shareOrDownloadStoryFile(file, title, text) {
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title, text, files: [file] });
      return "shared";
    } catch (error) {
      if (error.name === "AbortError") return "cancelled";
      console.error("تعذّرت مشاركة ملف المسار:", error);
    }
  }
  downloadFile(file);
  return "downloaded";
}
