const METHODS = {
  mwl: { name: "رابطة العالم الإسلامي", fajr: 18, isha: 17 },
  isna: { name: "أمريكا الشمالية", fajr: 15, isha: 15 },
  egypt: { name: "الهيئة المصرية", fajr: 19.5, isha: 17.5 },
  ummAlQura: { name: "أم القرى", fajr: 18.5, ishaInterval: 90 },
  karachi: { name: "كراتشي", fajr: 18, isha: 18 },
};

const METHOD_LABELS = {
  auto: "تلقائي حسب المنطقة الزمنية",
  ...Object.fromEntries(Object.entries(METHODS).map(([id, method]) => [id, method.name])),
};

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function julianDay(date) {
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  const day = date.getDate();
  if (month <= 2) {
    year -= 1;
    month += 12;
  }
  const century = Math.floor(year / 100);
  const correction = 2 - century + Math.floor(century / 4);
  return Math.floor(365.25 * (year + 4716))
    + Math.floor(30.6001 * (month + 1))
    + day + correction - 1524.5;
}

function solarPosition(julianDate) {
  const days = julianDate - 2451545;
  const meanAnomaly = radians(357.529 + 0.98560028 * days);
  const meanLongitude = 280.459 + 0.98564736 * days;
  const eclipticLongitude = radians(
    meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly),
  );
  const obliquity = radians(23.439 - 0.00000036 * days);
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const rightAscensionHours = ((rightAscension * 180 / Math.PI / 15) + 24) % 24;
  const meanLongitudeHours = ((meanLongitude / 15) % 24 + 24) % 24;
  const equationOfTime = ((meanLongitudeHours - rightAscensionHours + 12) % 24) - 12;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  return { equationOfTime, declination };
}

function hourAngle(latitude, declination, altitude) {
  const numerator = Math.sin(radians(altitude))
    - Math.sin(radians(latitude)) * Math.sin(declination);
  const denominator = Math.cos(radians(latitude)) * Math.cos(declination);
  const cosine = numerator / denominator;
  return cosine < -1 || cosine > 1 ? null : Math.acos(cosine) * 180 / Math.PI / 15;
}

function normalizeHours(hours) {
  return ((hours % 24) + 24) % 24;
}

export function prayerMethodForTimeZone(timeZone) {
  if (/^(Asia\/Riyadh|Asia\/Makkah)$/.test(timeZone)) return "ummAlQura";
  if (/^Africa\/Cairo$/.test(timeZone)) return "egypt";
  if (/^Asia\/(Karachi|Islamabad)$/.test(timeZone)) return "karachi";
  if (/^(America\/|US\/)/.test(timeZone)) return "isna";
  return "mwl";
}

export function prayerMethodLabel(method) {
  return METHOD_LABELS[method] ?? METHOD_LABELS.mwl;
}

export function calculatePrayerTimes(dateValue, latitude, longitude, timeZone, selectedMethod = "auto") {
  const date = new Date(`${dateValue}T12:00:00`);
  if (Number.isNaN(date.getTime()) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("تاريخ أو إحداثيات الموقع غير صالحة لحساب مواقيت الصلاة.");
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error("إحداثيات الموقع خارج النطاق الجغرافي الصحيح.");
  }

  const methodId = selectedMethod === "auto"
    ? prayerMethodForTimeZone(timeZone)
    : Object.hasOwn(METHODS, selectedMethod) ? selectedMethod : "mwl";
  const method = METHODS[methodId];
  const { equationOfTime, declination } = solarPosition(julianDay(date));
  const timeZoneOffset = -date.getTimezoneOffset() / 60;
  const solarNoon = 12 + timeZoneOffset - longitude / 15 - equationOfTime;
  const atAltitude = (altitude) => {
    const angle = hourAngle(latitude, declination, altitude);
    return angle === null ? null : normalizeHours(solarNoon + angle);
  };
  const beforeAltitude = (altitude) => {
    const angle = hourAngle(latitude, declination, altitude);
    return angle === null ? null : normalizeHours(solarNoon - angle);
  };
  const asrFactor = 1;
  const asrAltitude = Math.atan(
    1 / (asrFactor + Math.tan(Math.abs(radians(latitude) - declination))),
  ) * 180 / Math.PI;
  const maghrib = atAltitude(-0.833);

  return {
    method: methodId,
    times: [
      { name: "الفجر", time: beforeAltitude(-method.fajr) },
      { name: "الشروق", time: beforeAltitude(-0.833) },
      { name: "الظهر", time: normalizeHours(solarNoon + 2 / 60) },
      { name: "العصر", time: atAltitude(asrAltitude) },
      { name: "المغرب", time: maghrib },
      {
        name: "العشاء",
        time: method.ishaInterval
          ? maghrib === null ? null : normalizeHours(maghrib + method.ishaInterval / 60)
          : atAltitude(-method.isha),
      },
    ],
  };
}

export function formatPrayerTime(hours) {
  if (!Number.isFinite(hours)) return "—";
  const minutes = Math.round(hours * 60) % (24 * 60);
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}`.replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);
}
