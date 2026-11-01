const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function concatenate(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function zip(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [filename, content] of files) {
    const name = encoder.encode(filename);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const header = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0), ...u32(checksum), ...u32(data.length),
      ...u32(data.length), ...u16(name.length), ...u16(0),
    ]);
    localParts.push(header, name, data);

    const central = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800),
      ...u16(0), ...u16(0), ...u16(0), ...u32(checksum), ...u32(data.length),
      ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(localOffset),
    ]);
    centralParts.push(central, name);
    localOffset += header.length + name.length + data.length;
  }

  const centralDirectory = concatenate(centralParts);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralDirectory.length), ...u32(localOffset), ...u16(0),
  ]);
  return concatenate([...localParts, centralDirectory, end]);
}

function columnName(index) {
  let value = index + 1;
  let label = "";
  while (value) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function worksheetXml(rows, hasChart = false) {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
      if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      const text = xmlEscape(value);
      const preserve = /^\s|\s$/.test(String(value ?? "")) ? ' xml:space="preserve"' : "";
      return `<c r="${ref}" t="inlineStr"><is><t${preserve}>${text}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${hasChart ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : ""}><sheetData>${rowXml}</sheetData>${hasChart ? '<drawing r:id="rId1"/>' : ""}</worksheet>`;
}

function chartFormula(sheetName, column, firstRow, lastRow) {
  const escapedSheetName = sheetName.replaceAll("'", "''");
  return `'${escapedSheetName}'!$${column}$${firstRow}:$${column}$${lastRow}`;
}

function chartXml(sheet, chartIndex) {
  const { chart } = sheet;
  const name = xmlEscape(chart.title);
  const categories = chartFormula(sheet.name, "A", chart.firstRow, chart.lastRow);
  const values = chartFormula(sheet.name, "B", chart.firstRow, chart.lastRow);
  const seriesTitle = chartFormula(sheet.name, "B", 3, 3);
  const series = `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${seriesTitle}</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>${categories}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${values}</c:f></c:numRef></c:val><c:spPr><a:solidFill><a:srgbClr val="468B6B"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="468B6B"/></a:solidFill></a:ln></c:spPr>${chart.type === "line" ? '<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker><c:smooth val="0"/>' : ""}</c:ser>`;
  const chartType = chart.type === "line"
    ? `<c:lineChart><c:grouping val="standard"/>${series}<c:axId val="${700000 + chartIndex}"/><c:axId val="${800000 + chartIndex}"/></c:lineChart>`
    : `<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="55"/><c:axId val="${700000 + chartIndex}"/><c:axId val="${800000 + chartIndex}"/></c:barChart>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:lang val="ar-SA"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr/><a:r><a:rPr lang="ar-SA" sz="1400" b="1"/><a:t>${name}</a:t></a:r><a:endParaRPr lang="ar-SA"/></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/>${chartType}<c:catAx><c:axId val="${700000 + chartIndex}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type === "line" ? "b" : "l"}"/><c:tickLblPos val="nextTo"/><c:crossAx val="${800000 + chartIndex}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="${800000 + chartIndex}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type === "line" ? "l" : "b"}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="${700000 + chartIndex}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function drawingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="9144000" cy="5486400"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Report Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5486400"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
}

export function createXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("أضف ورقة واحدة على الأقل للتصدير.");
  const safeSheets = sheets.slice(0, 80).map((sheet, index) => ({
    name: String(sheet.name ?? `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${index + 1}`,
    rows: Array.isArray(sheet.rows) ? sheet.rows : [],
    chart: sheet.chart ?? null,
  }));
  const chartSheets = safeSheets.flatMap((sheet, index) => sheet.chart ? [{ sheet, sheetIndex: index + 1, chartIndex: safeSheets.slice(0, index + 1).filter((item) => item.chart).length }] : []);
  const contentOverrides = safeSheets.map((_sheet, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    chartSheets.map(({ chartIndex }) =>
      `<Override PartName="/xl/charts/chart${chartIndex}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing${chartIndex}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join("");
  const workbookSheets = safeSheets.map((sheet, index) =>
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbookRelationships = safeSheets.map((_sheet, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentOverrides}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}</Relationships>`],
    ...safeSheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet.rows, Boolean(sheet.chart))]),
    ...chartSheets.flatMap(({ sheet, sheetIndex, chartIndex }) => [
      [`xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${chartIndex}.xml"/></Relationships>`],
      [`xl/drawings/drawing${chartIndex}.xml`, drawingXml()],
      [`xl/drawings/_rels/drawing${chartIndex}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartIndex}.xml"/></Relationships>`],
      [`xl/charts/chart${chartIndex}.xml`, chartXml(sheet, chartIndex)],
    ]),
  ];
  return new Blob([zip(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function downloadXlsx(filename, sheets) {
  const blob = createXlsx(sheets);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
