// ============================================================
// بندرِ ترم — Term Harbor Course Scheduler
// Core application logic: parsers, merge engine, weekly calendar,
// collision detection, persistence, and timetable export.
// ============================================================

(function () {
  "use strict";

  // ------------------------------------------------------------
  // Configuration & Constants
  // ------------------------------------------------------------
  const DAYS = [
    { key: "sat", name: "شنبه", short: "ش" },
    { key: "sun", name: "یک‌شنبه", short: "ی" },
    { key: "mon", name: "دوشنبه", short: "د" },
    { key: "tue", name: "سه‌شنبه", short: "س" },
    { key: "wed", name: "چهارشنبه", short: "چ" },
    { key: "thu", name: "پنجشنبه", short: "پ" },
  ];

  const START_HOUR = 7;
  const END_HOUR = 20;
  const TOTAL_HOURS = END_HOUR - START_HOUR;
  const STORAGE_KEY = "termharbor_v1";


  // Configure PDF.js worker
  if (window.pdfjsLib) {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.js", window.location.href).href;
    } catch (e) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    }
  }
  // ------------------------------------------------------------
  // State
  // ------------------------------------------------------------
  const state = {
    files: {
      "212": null, // { name, size, rawData }
      "102": null,
      "110": null,
    },
    eligibleCodes: new Set(),
    catalog102: new Map(), // code_group -> object
    catalog110: new Map(), // code_group -> object
    mergedCourses: [],     // Array of enriched eligible course objects
    selectedCodes: new Set(),
    searchQuery: "",
    filterMode: "all",     // 'all' | 'picked' | 'free'
    pdfDetails: new Map(), // code_group -> { prereqs: [], notes: "" }
  };

  // ------------------------------------------------------------
  // Persian Utilities
  // ------------------------------------------------------------
  const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

  function toFa(input) {
    if (input === null || input === undefined) return "";
    return String(input).replace(/\d/g, (d) => FA_DIGITS[parseInt(d, 10)]);
  }

  function toEnDigits(str) {
    if (!str) return "";
    let s = String(str);
    for (let i = 0; i < 10; i++) {
      s = s.replaceAll(FA_DIGITS[i], String(i)).replaceAll(AR_DIGITS[i], String(i));
    }
    return s;
  }

  function normalizePersianText(str) {
    if (!str) return "";
    return String(str)
      .replace(/[\u200c\u200b]/g, "") // remove ZWNJ / zero-width spaces for matching
      .replace(/ي/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/ة/g, "ه")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeDayName(dayStr) {
    const clean = normalizePersianText(dayStr);
    if (/^شنبه/.test(clean)) return "sat";
    if (/^یک\s*شنبه/.test(clean)) return "sun";
    if (/^دو\s*شنبه/.test(clean)) return "mon";
    if (/^سه\s*شنبه/.test(clean)) return "tue";
    if (/^چهار\s*شنبه/.test(clean)) return "wed";
    if (/^پنج\s*شنبه/.test(clean)) return "thu";
    if (/^جمعه/.test(clean)) return "fri";
    return null;
  }

  function timeToMinutes(tStr) {
    const en = toEnDigits(tStr).trim();
    const [h, m] = en.split(":").map((x) => parseInt(x, 10));
    if (isNaN(h)) return null;
    return h * 60 + (m || 0);
  }

  function minutesToTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------
  // PARSER 1: Report 212 (PDF)
  // Extracts eligible course code + group pairs (e.g. "1116057_35")
  // ------------------------------------------------------------
  function readReportLine(items) {
    // PDF.js already orders characters within each chunk. Read chunks RTL,
    // retaining LTR number runs and the report's ~1.37pt word gaps.
    const sorted = [...items].sort((a, b) => b.x - a.x);
    let text = "", previous = null, digits = "";
    for (const item of sorted) {
      const gap = previous ? previous.x - (item.x + item.w) : 0;
      const value = toEnDigits(item.str.normalize("NFKC"));
      if (gap > 0.7 || !/^\d+$/.test(value)) {
        text += digits;
        digits = "";
        if (gap > 0.7) text += " ";
      }
      if (/^\d+$/.test(value)) digits = value + digits;
      else text += value;
      previous = item;
    }
    return (text + digits).replace(/ي|ى/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ").trim();
  }

  async function parseReport212(arrayBuffer) {
    if (!window.pdfjsLib) {
      throw new Error("کتابخانه PDF.js بارگذاری نشده است.");
    }
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const codes = new Set();
    const details = new Map();
    const codeRegex = /^(\d{5,9})[_\-](\d{1,3})$/;

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();

      const items = tc.items.map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
      })).filter((it) => it.str && it.str.trim());

      // 1. Identify all course codes (x >= 520) and their y coordinates
      const codeEntries = [];
      let cur = "";
      let lastX = null, lastY = null, lastW = 0;

      for (const it of items) {
        if (it.x < 520) continue;
        if (lastY !== null && Math.abs(it.y - lastY) <= 3 && it.x >= lastX - 2 && it.x <= lastX + lastW + 6) {
          cur += it.str;
          lastX = it.x;
          lastW = it.w;
        } else {
          if (cur) {
            const en = toEnDigits(cur).trim();
            const m = en.match(codeRegex);
            if (m) {
              const fullCode = `${m[1]}_${m[2].padStart(2, "0")}`;
              codes.add(fullCode);
              codeEntries.push({ code: fullCode, y: lastY });
            }
          }
          cur = it.str;
          lastX = it.x;
          lastY = it.y;
          lastW = it.w;
        }
      }
      if (cur) {
        const en = toEnDigits(cur).trim();
        const m = en.match(codeRegex);
        if (m) {
          const fullCode = `${m[1]}_${m[2].padStart(2, "0")}`;
          codes.add(fullCode);
          codeEntries.push({ code: fullCode, y: lastY });
        }
      }

      // Sort by y descending (top of page to bottom)
      codeEntries.sort((a, b) => b.y - a.y);

      // Report 212: requirements end at x=224; the location column starts at x=226.
      for (let i = 0; i < codeEntries.length; i++) {
        const entry = codeEntries[i];
        const curY = entry.y;
        const nextY = i + 1 < codeEntries.length ? codeEntries[i + 1].y : 0;

        const prereqItems = items.filter(
          (it) => it.x >= 80 && it.x < 224 && it.y <= curY + 2 && it.y > nextY + 2
        );
        const noteItems = items.filter(
          (it) => it.x >= 15 && it.x < 80 && it.y <= curY + 2 && it.y > nextY + 2
        );

        // Group prereq items by horizontal line
        const pLineMap = new Map();
        prereqItems.forEach((it) => {
          let mk = null;
          for (const k of pLineMap.keys()) {
            if (Math.abs(k - it.y) <= 3) {
              mk = k;
              break;
            }
          }
          const key = mk !== null ? mk : it.y;
          if (!pLineMap.has(key)) pLineMap.set(key, []);
          pLineMap.get(key).push(it);
        });

        const parsedPrereqs = [];
        for (const lineItems of pLineMap.values()) {
          const line = readReportLine(lineItems);
          const relation = line.match(/^(پیش\s*نیاز|هم\s*نیاز|معادل)\s*/);
          if (!relation) continue;
          const type = relation[1].startsWith("هم") ? "coreq" : relation[1] === "معادل" ? "equiv" : "prereq";
          const typeLabel = type === "coreq" ? "هم‌نیاز" : type === "equiv" ? "معادل" : "پیش‌نیاز";
          const body = line.slice(relation[0].length);
          const matches = [...body.matchAll(/\b\d{5,9}\b/g)];
          for (let index = 0; index < matches.length; index++) {
            const match = matches[index];
            const code = match[0];
            const name = body.slice(match.index + code.length, matches[index + 1]?.index ?? body.length)
              .replace(/^[\s,،]+|[\s,،]+$/g, "").replace(/\)([^()]*)\(/g, "($1)");
            if (!parsedPrereqs.some(p => p.type === type && p.code === code && p.name === name)) {
              parsedPrereqs.push({ type, typeLabel, code, name });
            }
          }
        }

        // Group note items
        const nLineMap = new Map();
        noteItems.forEach((it) => {
          let mk = null;
          for (const k of nLineMap.keys()) {
            if (Math.abs(k - it.y) <= 3) {
              mk = k;
              break;
            }
          }
          const key = mk !== null ? mk : it.y;
          if (!nLineMap.has(key)) nLineMap.set(key, []);
          nLineMap.get(key).push(it);
        });

        const noteLines = [];
        for (const lineItems of nLineMap.values()) {
          const line = readReportLine(lineItems);
          if (line && !line.includes("توضیحات")) noteLines.push(line);
        }

        if (parsedPrereqs.length > 0 || noteLines.length > 0) {
          details.set(entry.code, {
            prereqs: parsedPrereqs,
            notes: noteLines.join(" • "),
          });
        }
      }
    }

    if (codes.size === 0) {
      throw new Error("هیچ کد درسی در گزارش ۲۱۲ شناسایی نشد. لطفاً از درستی فایل مطمئن شوید.");
    }

    return { codes, details };
  }

  // ------------------------------------------------------------
  // PARSER 2: Report 102 (Excel)
  // Detailed catalog: professor, schedule, exam, credits, etc.
  // ------------------------------------------------------------
  function parseReport102(arrayBuffer) {
    if (!window.XLSX) {
      throw new Error("کتابخانه SheetJS بارگذاری نشده است.");
    }
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
      throw new Error("فایل اکسل ۱۰۲ خالی است یا سرستون نامعتبر دارد.");
    }

    // Identify header indices dynamically or fallback to standard positional indices
    const header = rows[0].map((h) => normalizePersianText(String(h || "")));
    const colIdx = {
      code: findCol(header, ["شماره و گروه درس", "شماره درس"]),
      name: findCol(header, ["نام درس"]),
      credits: findCol(header, ["کل", "تعداد واحد", "واحد"]),
      practical: findCol(header, ["ع", "عملی"]),
      capacity: findCol(header, ["ظرفیت", "ظر فيت"]),
      enrolled: findCol(header, ["ثبت نام شده"]),
      waitlist: findCol(header, ["تعداد لیست انتظار", "تعداد ليست انتظار"]),
      gender: findCol(header, ["جنس", "جنسیت"]),
      prof: findCol(header, ["نام استاد", "استاد"]),
      schedule: findCol(header, ["زمان و مکان ارائه", "زمان و مكان ارائه"]),
      exam: findCol(header, ["زمان و مکان امتحان", "زمان و مكان امتحان"]),
      restrictions: findCol(header, ["محدودیت اخذ", "محدوديت اخذ"]),
      entryFilter: findCol(header, ["مخصوص ورودی", "مخصوص ورودي"]),
      requiredCourses: findCol(header, ["دروس اجبار/متضاد", "دروس اجبار"]),
      deliveryMode: findCol(header, ["نحوه ارائه درس", "نحوه ارائه"]),
      coursePeriod: findCol(header, ["دوره درس"]),
      faculty: findCol(header, ["دانشکده درس", "دانشكده درس"], 1),
      dept: findCol(header, ["گروه آموزشی درس", "گروه آموزشي درس"], 3),
      notes: findCol(header, ["توضیحات", "توضيحات"]),
    };

    const catalog = new Map();

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[colIdx.code]) continue;

      const rawCode = toEnDigits(String(r[colIdx.code])).trim();
      // Normalize group with leading zero (e.g. 1116057_1 -> 1116057_01)
      const parts = rawCode.split("_");
      if (parts.length !== 2) continue;
      const normalizedCode = `${parts[0]}_${parts[1].padStart(2, "0")}`;

      const scheduleRaw = String(r[colIdx.schedule] || "");
      const examRaw = String(r[colIdx.exam] || "");

      const entry = {
        code: normalizedCode,
        courseCode: parts[0],
        group: parts[1].padStart(2, "0"),
        name: String(r[colIdx.name] || "").trim(),
        credits: parseInt(toEnDigits(r[colIdx.credits]), 10) || 0,
        practicalCredits: parseInt(toEnDigits(r[colIdx.practical]), 10) || 0,
        capacity: parseInt(toEnDigits(r[colIdx.capacity]), 10) || 0,
        enrolled: parseInt(toEnDigits(r[colIdx.enrolled]), 10) || 0,
        waitlist: parseInt(toEnDigits(r[colIdx.waitlist]), 10) || 0,
        gender: String(r[colIdx.gender] || "").trim() || "مختلط",
        professor: String(r[colIdx.prof] || "").trim() || "نامشخص",
        facultyCode: String(r[0] || "").trim(),
        faculty: String(r[1] || r[colIdx.faculty] || "").trim(),
        deptCode: String(r[2] || "").trim(),
        dept: String(r[3] || r[colIdx.dept] || "").trim(),
        notes: String(r[colIdx.notes] || "").trim(),
        restrictions: String(r[colIdx.restrictions] || "").trim(),
        entryFilter: String(r[colIdx.entryFilter] || "").trim(),
        requiredCourses: String(r[colIdx.requiredCourses] || "").trim(),
        deliveryMode: String(r[colIdx.deliveryMode] || "").trim() || "عادی",
        coursePeriod: String(r[colIdx.coursePeriod] || "").trim(),
        sessions: parseSessions(scheduleRaw),
        exam: parseExam(examRaw),
        rawSchedule: scheduleRaw,
        rawExam: examRaw,
      };

      catalog.set(normalizedCode, entry);
    }

    return catalog;
  }

  // ------------------------------------------------------------
  // PARSER 3: Report 110 (Excel)
  // Supplementary room/location & emergency drop rules
  // ------------------------------------------------------------
  function parseReport110(arrayBuffer) {
    if (!window.XLSX) {
      throw new Error("کتابخانه SheetJS بارگذاری نشده است.");
    }
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
      throw new Error("فایل اکسل ۱۱۰ خالی است.");
    }

    const header = rows[0].map((h) => normalizePersianText(String(h || "")));
    const colIdx = {
      code: findCol(header, ["شماره و گروه درس", "شماره درس"]),
      combined: findCol(header, ["زمان و مکان ارائه/ امتحان", "زمان و مكان ارائه/ امتحان"]),
      notes: findCol(header, ["توضیحات", "توضيحات"]),
      emergencyDrop: findCol(header, ["حذف اضطراری", "حذف اضطراري"]),
      otherCenters: findCol(header, ["امکان اخذ درس توسط سایر مراکز", "امكان اخذ درس توسط ساير مراكز"]),
    };

    const catalog = new Map();

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[colIdx.code]) continue;

      const rawCode = toEnDigits(String(r[colIdx.code])).trim();
      const parts = rawCode.split("_");
      if (parts.length !== 2) continue;
      const normalizedCode = `${parts[0]}_${parts[1].padStart(2, "0")}`;

      const combinedRaw = String(r[colIdx.combined] || "");
      const room = extractRoom(combinedRaw);
      const sessions = parseSessions(combinedRaw, room);
      const exam = parseExam(combinedRaw);

      catalog.set(normalizedCode, {
        code: normalizedCode,
        room: room || null,
        emergencyDrop: String(r[colIdx.emergencyDrop] || "").trim(),
        otherCenters: String(r[colIdx.otherCenters] || "").trim(),
        notes110: String(r[colIdx.notes] || "").trim(),
        sessions110: sessions,
        exam110: exam,
        rawCombined: combinedRaw,
      });
    }

    return catalog;
  }

  // Helper to resolve column index by name candidates
  function findCol(headerList, candidates, fallbackIndex = -1) {
    for (const c of candidates) {
      const norm = normalizePersianText(c);
      const idx = headerList.findIndex((h) => h.includes(norm));
      if (idx !== -1) return idx;
    }
    return fallbackIndex;
  }

  // ------------------------------------------------------------
  // Session & Exam Parsers
  // ------------------------------------------------------------
  // Sample: "درس(ت): شنبه 13:00-15:00  درس(ت): دوشنبه 13:00-15:00"
  function parseSessions(str, defaultRoom = null) {
    if (!str) return [];
    const en = toEnDigits(str);
    const sessions = [];

    // Match patterns like: درس(ت): شنبه 13:00-15:00 or درس(ع): چهارشنبه 08:00-11:00
    const regex = /درس\s*\((.*?)\)\s*:\s*([^\d:]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g;
    let m;
    while ((m = regex.exec(en)) !== null) {
      const typeStr = m[1].trim(); // ت (theory), ع (practical)
      const dayRaw = m[2].trim();
      const dayKey = normalizeDayName(dayRaw);
      const start = m[3].trim();
      const end = m[4].trim();

      if (dayKey) {
        sessions.push({
          dayKey,
          dayName: DAYS.find((d) => d.key === dayKey)?.name || dayRaw,
          startTime: start,
          endTime: end,
          startMin: timeToMinutes(start),
          endMin: timeToMinutes(end),
          type: typeStr.includes("ع") ? "practical" : "theory",
          typeLabel: typeStr.includes("ع") ? "عملی" : "نظری",
          room: defaultRoom,
        });
      }
    }

    return sessions;
  }

  // Sample: "تاریخ: 1405/11/12 ساعت: 08:00-10:00" or "امتحان(1405.11.14) ساعت : 11:00-13:00"
  function parseExam(str) {
    if (!str) return null;
    const en = toEnDigits(str);

    // Look for date pattern 140x/xx/xx or 140x.xx.xx
    const dateMatch = en.match(/(14\d{2}[/.]\d{1,2}[/.]\d{1,2})/);
    // Look for hour range xx:xx-xx:xx
    const timeMatch = en.match(/ساعت\s*:?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);

    if (!dateMatch && !timeMatch) return null;

    const normalizedDate = dateMatch ? dateMatch[1].replace(/\./g, "/") : null;
    const startTime = timeMatch ? timeMatch[1] : null;
    const endTime = timeMatch ? timeMatch[2] : null;

    return {
      date: normalizedDate,
      startTime,
      endTime,
      startMin: startTime ? timeToMinutes(startTime) : null,
      endMin: endTime ? timeToMinutes(endTime) : null,
      raw: str,
    };
  }

  // Sample: "مکان: 308" or "مکان: کلاس شماره 106"
  function extractRoom(str) {
    if (!str) return null;
    const m = str.match(/مکان\s*:\s*([^امتحان\n\r]+?)(?=\s*امتحان|$)/);
    if (m && m[1]) {
      return m[1].trim();
    }
    return null;
  }

  // ------------------------------------------------------------
  // MERGE ENGINE
  // Filters by 212 eligible codes, enriches with 102 & 110
  // ------------------------------------------------------------
  function mergeReports() {
    const { eligibleCodes, catalog102, catalog110 } = state;
    if (eligibleCodes.size === 0 || catalog102.size === 0) {
      state.mergedCourses = [];
      return;
    }

    const merged = [];

    eligibleCodes.forEach((code) => {
      const from102 = catalog102.get(code);
      const from110 = catalog110.get(code);

      if (!from102) {
        // Edge case: code is in 212 but not in 102 catalog
        return;
      }

      const pdfInfo = state.pdfDetails ? state.pdfDetails.get(code) : null;
      // Base: from 102
      const course = {
        ...from102,
        room: from110?.room || null,
        emergencyDrop: from110?.emergencyDrop || null,
        otherCenters: from110?.otherCenters || null,
        pdfPrereqs: pdfInfo?.prereqs || [],
        pdfNotes: pdfInfo?.notes || "",
      };
      // If 110 provided room, attach it to all sessions
      if (course.room && course.sessions.length > 0) {
        course.sessions.forEach((s) => (s.room = course.room));
      }

      // If 102 had no sessions but 110 does, use 110's
      if (course.sessions.length === 0 && from110?.sessions110?.length > 0) {
        course.sessions = from110.sessions110;
      }

      // If 102 had no exam but 110 does, use 110's
      if (!course.exam && from110?.exam110) {
        course.exam = from110.exam110;
      }

      merged.push(course);
    });

    // Sort alphabetically by course name, then by group
    merged.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, "fa");
      if (cmp !== 0) return cmp;
      return a.group.localeCompare(b.group);
    });

    state.mergedCourses = merged;
    saveToStorage();
  }

  // ------------------------------------------------------------
  // Date Normalizer
  // Converts 1405.11.3, 1405/11/3, 1405-11-03 to 1405/11/03
  // ------------------------------------------------------------
  function normalizeExamDate(dStr) {
    if (!dStr) return null;
    const clean = toEnDigits(dStr).replace(/[.\-]/g, "/").trim();
    const parts = clean.split("/").filter(Boolean);
    if (parts.length === 3) {
      const y = parts[0];
      const m = parts[1].padStart(2, "0");
      const d = parts[2].padStart(2, "0");
      return `${y}/${m}/${d}`;
    }
    return clean;
  }

  // ------------------------------------------------------------
  // COLLISION DETECTION ENGINE
  // Detects:
  //   1) Duplicate courses: multiple groups of the same course
  //   2) Lecture overlaps: same day and intersecting hours
  //   3) Exam hour overlaps (Critical): same date and overlapping hours
  //   4) Same-day exams (Warning): multiple exams on the same calendar day
  // ------------------------------------------------------------
  function detectCollisions(selectedCourseList) {
    const lectureConflicts = [];
    const examConflicts = [];
    const duplicateConflicts = [];

    // 1. Check for Duplicate Course Codes (same course, multiple groups)
    const courseCodeMap = new Map();
    selectedCourseList.forEach((c) => {
      const base = c.courseCode || c.code.split("_")[0];
      if (!courseCodeMap.has(base)) courseCodeMap.set(base, []);
      courseCodeMap.get(base).push(c);
    });

    courseCodeMap.forEach((groupList, baseCode) => {
      if (groupList.length > 1) {
        for (let i = 0; i < groupList.length; i++) {
          for (let j = i + 1; j < groupList.length; j++) {
            duplicateConflicts.push({
              type: "duplicate",
              severity: "critical",
              course1: groupList[i],
              course2: groupList[j],
              title: `اخذ همزمان دو گروه از درس «${groupList[i].name}»`,
              desc: `گروه ${toFa(groupList[i].group)} و گروه ${toFa(groupList[j].group)} همزمان انتخاب شده‌اند (کد درس: ${toFa(baseCode)}).`,
            });
          }
        }
      }
    });

    // 2. Pairwise lecture and exam checks
    for (let i = 0; i < selectedCourseList.length; i++) {
      for (let j = i + 1; j < selectedCourseList.length; j++) {
        const c1 = selectedCourseList[i];
        const c2 = selectedCourseList[j];

        // A) Lecture overlaps
        for (const s1 of c1.sessions) {
          for (const s2 of c2.sessions) {
            if (s1.dayKey === s2.dayKey && s1.startMin !== null && s2.startMin !== null) {
              const overlapStart = Math.max(s1.startMin, s2.startMin);
              const overlapEnd = Math.min(s1.endMin, s2.endMin);

              if (overlapStart < overlapEnd) {
                const durationMins = overlapEnd - overlapStart;
                lectureConflicts.push({
                  type: "lecture",
                  severity: "critical",
                  course1: c1,
                  course2: c2,
                  session1: s1,
                  session2: s2,
                  dayName: s1.dayName,
                  overlapWindow: `${minutesToTime(overlapStart)} تا ${minutesToTime(overlapEnd)}`,
                  title: `تداخل ساعت کلاس: «${c1.name}» و «${c2.name}»`,
                  desc: `روز ${s1.dayName} در بازهٔ ${toFa(minutesToTime(overlapStart))} تا ${toFa(minutesToTime(overlapEnd))} (${toFa(durationMins)} دقیقه همپوشانی دارند).`,
                });
              }
            }
          }
        }

        // B) Exam conflicts (Direct Hour Collision vs Same-Day Collision)
        const exam1 = c1.exam;
        const exam2 = c2.exam;

        if (exam1 && exam2 && exam1.date && exam2.date) {
          const d1 = normalizeExamDate(exam1.date);
          const d2 = normalizeExamDate(exam2.date);

          if (d1 && d2 && d1 === d2) {
            let isHourOverlap = false;
            let overlapWindow = null;

            if (exam1.startMin !== null && exam2.startMin !== null) {
              const oStart = Math.max(exam1.startMin, exam2.startMin);
              const oEnd = Math.min(exam1.endMin, exam2.endMin);
              if (oStart < oEnd) {
                isHourOverlap = true;
                overlapWindow = `${minutesToTime(oStart)} تا ${minutesToTime(oEnd)}`;
              }
            }

            if (isHourOverlap) {
              // Critical: overlapping exam hours on the same date
              examConflicts.push({
                type: "exam",
                severity: "critical",
                course1: c1,
                course2: c2,
                date: d1,
                title: `تداخل ساعت امتحان (بحرانی): «${c1.name}» و «${c2.name}»`,
                desc: `تاریخ ${toFa(d1)}: ساعات برگزاری آزمون در بازهٔ ${toFa(overlapWindow)} همپوشانی دارد.`,
              });
            } else {
              // Warning: two exams on the same day at different hours
              const t1 = exam1.startTime ? `${exam1.startTime} تا ${exam1.endTime || ""}` : "ساعت نامشخص";
              const t2 = exam2.startTime ? `${exam2.startTime} تا ${exam2.endTime || ""}` : "ساعت نامشخص";
              examConflicts.push({
                type: "exam",
                severity: "warning",
                course1: c1,
                course2: c2,
                date: d1,
                title: `دو امتحان در یک روز: «${c1.name}» و «${c2.name}»`,
                desc: `هر دو آزمون در تاریخ ${toFa(d1)} برگزار می‌شوند (ساعت آزمون اول: ${toFa(t1)} • ساعت آزمون دوم: ${toFa(t2)}).`,
              });
            }
          }
        }
      }
    }

    const totalCount = lectureConflicts.length + examConflicts.length + duplicateConflicts.length;
    const criticalCount =
      lectureConflicts.length +
      duplicateConflicts.length +
      examConflicts.filter((e) => e.severity === "critical").length;

    return {
      lectureConflicts,
      examConflicts,
      duplicateConflicts,
      totalCount,
      criticalCount,
    };
  }

  // ------------------------------------------------------------
  // LOCAL STORAGE PERSISTENCE
  // ------------------------------------------------------------
  function saveToStorage() {
    try {
      const payload = {
        selectedCodes: Array.from(state.selectedCodes),
        mergedCourses: state.mergedCourses,
        filesMeta: {
          "212": state.files["212"] ? { name: state.files["212"].name, size: state.files["212"].size } : null,
          "102": state.files["102"] ? { name: state.files["102"].name, size: state.files["102"].size } : null,
          "110": state.files["110"] ? { name: state.files["110"].name, size: state.files["110"].size } : null,
        },
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn("خطا در ذخیره در حافظه محلی:", e);
    }
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);

      if (data && Array.isArray(data.mergedCourses) && data.mergedCourses.length > 0) {
        state.mergedCourses = data.mergedCourses;
        state.selectedCodes = new Set(data.selectedCodes || []);
        if (data.filesMeta) {
          Object.keys(data.filesMeta).forEach((k) => {
            if (data.filesMeta[k]) {
              updateDropState(k, "is-ok", `بارگذاری‌شده (${data.filesMeta[k].name})`);
            }
          });
        }
        return true;
      }
    } catch (e) {
      console.warn("خطا در بازخوانی حافظه محلی:", e);
    }
    return false;
  }

  function resetStorage() {
    localStorage.removeItem(STORAGE_KEY);
    state.files = { "212": null, "102": null, "110": null };
    state.eligibleCodes.clear();
    state.catalog102.clear();
    state.catalog110.clear();
    state.mergedCourses = [];
    state.selectedCodes.clear();
    state.searchQuery = "";
    state.filterMode = "all";

    ["212", "102", "110"].forEach((k) => updateDropState(k, "", "منتظر فایل"));
    document.getElementById("mergeBar").hidden = true;
    document.getElementById("planner").hidden = true;
    document.getElementById("conflicts").hidden = true;
    document.getElementById("btnExport").disabled = true;
    document.getElementById("btnReset").disabled = true;
    updateStats();
    showToast("اطلاعات برنامه بازنشانی شد.", "is-warn");
  }

  // ------------------------------------------------------------
  // UI Rendering
  // ------------------------------------------------------------
  const colorPalette = [
    { bg: "#1d63ed", fg: "#ffffff" }, // blue
    { bg: "#7c3aed", fg: "#ffffff" }, // violet
    { bg: "#0d9488", fg: "#ffffff" }, // teal
    { bg: "#d97706", fg: "#ffffff" }, // amber dark
    { bg: "#e11d48", fg: "#ffffff" }, // rose
    { bg: "#0284c7", fg: "#ffffff" }, // sky
    { bg: "#4f46e5", fg: "#ffffff" }, // indigo
    { bg: "#059669", fg: "#ffffff" }, // emerald
  ];

  function getCourseColor(code) {
    let hash = 0;
    for (let i = 0; i < code.length; i++) {
      hash = (hash << 5) - hash + code.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % colorPalette.length;
    return colorPalette[idx];
  }

  function updateDropState(kind, stateClass, text, fileName = null, countBadge = null) {
    const el = document.getElementById(`drop${kind}`);
    if (!el) return;
    el.classList.remove("is-ok", "is-err");
    if (stateClass) el.classList.add(stateClass);

    const chip = el.querySelector("[data-state]");
    if (chip) {
      if (stateClass === "is-ok") {
        chip.innerHTML = `
          <svg viewBox="0 0 24 24" class="ic ic-emerald" style="flex:none;"><path d="M20 6 9 17l-5-5"/></svg>
          <span class="drop-chip-text" title="${fileName || text}">${fileName || text}</span>
          ${countBadge ? `<span class="drop-chip-badge">${countBadge}</span>` : ""}
        `;
      } else if (stateClass === "is-err") {
        chip.innerHTML = `
          <svg viewBox="0 0 24 24" class="ic ic-coral" style="flex:none;"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          <span class="drop-chip-text">${text || "خطا در پردازش فایل"}</span>
        `;
      } else {
        const defaultPlaceholders = {
          "212": "انتخاب یا رها کردن فایل PDF",
          "102": "انتخاب یا رها کردن فایل اکسل",
          "110": "انتخاب یا رها کردن فایل اکسل",
        };
        chip.innerHTML = `
          <svg viewBox="0 0 24 24" class="ic" style="flex:none;"><path d="M12 15V3m0 12-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
          <span class="drop-chip-text">${text || defaultPlaceholders[kind]}</span>
        `;
      }
    }
  }

  function updateStats() {
    const totalEligible = state.mergedCourses.length;
    const selected = state.mergedCourses.filter((c) => state.selectedCodes.has(c.code));
    const totalCredits = selected.reduce((sum, c) => sum + (c.credits || 0), 0);
    const conflicts = detectCollisions(selected);

    document.getElementById("statCourses").textContent = toFa(totalEligible);
    document.getElementById("statSelected").textContent = toFa(selected.length);
    document.getElementById("statCredits").textContent = toFa(totalCredits);
    document.getElementById("statConflicts").textContent = toFa(conflicts.totalCount);

    const creditChip = document.getElementById("creditChip");
    if (creditChip) creditChip.textContent = `${toFa(totalCredits)} واحد`;

    const conflictChip = document.getElementById("conflictChip");
    if (conflictChip) {
      if (conflicts.totalCount === 0) {
        conflictChip.textContent = `۰ تداخل`;
        conflictChip.className = "chip chip-conflict is-zero";
      } else {
        const crit = conflicts.criticalCount;
        const warn = conflicts.totalCount - crit;
        let text = `${toFa(conflicts.totalCount)} تداخل`;
        if (crit > 0 && warn > 0) {
          text += ` (${toFa(crit)} بحرانی + ${toFa(warn)} هشدار)`;
        } else if (crit > 0) {
          text += ` (بحرانی)`;
        } else {
          text += ` (هشدار روز)`;
        }
        conflictChip.textContent = text;
        conflictChip.className = `chip chip-conflict ${crit > 0 ? "is-critical" : "is-warning"}`;
      }
    }

    // Update Live Badges in Header
    const navCredits = document.getElementById("navCreditsBadge");
    if (navCredits) {
      if (totalCredits > 0) {
        navCredits.textContent = `${toFa(totalCredits)} واحد`;
        navCredits.hidden = false;
      } else {
        navCredits.hidden = true;
      }
    }

    const navConflict = document.getElementById("navConflictBubble");
    if (navConflict) {
      if (conflicts.totalCount > 0) {
        navConflict.textContent = toFa(conflicts.totalCount);
        navConflict.hidden = false;
      } else {
        navConflict.hidden = true;
      }
    }
  }

  // Render course list in sidebar
  function renderCourseList() {
    const container = document.getElementById("courseList");
    if (!container) return;

    const query = normalizePersianText(state.searchQuery);
    const selected = state.mergedCourses.filter((c) => state.selectedCodes.has(c.code));
    const conflicts = detectCollisions(selected);

    // Identify which course codes have collisions
    const conflictingCodes = new Set();
    conflicts.lectureConflicts.forEach((c) => {
      conflictingCodes.add(c.course1.code);
      conflictingCodes.add(c.course2.code);
    });
    conflicts.examConflicts.forEach((c) => {
      conflictingCodes.add(c.course1.code);
      conflictingCodes.add(c.course2.code);
    });

    let list = state.mergedCourses.filter((c) => {
      if (!query) return true;
      const haystack = normalizePersianText(
        `${c.name} ${c.code} ${c.professor} ${c.faculty} ${c.dept}`
      );
      return haystack.includes(query);
    });

    if (state.filterMode === "picked") {
      list = list.filter((c) => state.selectedCodes.has(c.code));
    } else if (state.filterMode === "free") {
      // Courses that don't collide with currently picked
      list = list.filter((c) => {
        if (state.selectedCodes.has(c.code)) return true;
        const testPick = [...selected, c];
        const testConflicts = detectCollisions(testPick);
        return testConflicts.totalCount === conflicts.totalCount;
      });
    }

    const countEl = document.getElementById("listCount");
    if (countEl) countEl.textContent = `${toFa(list.length)} درس`;
    const mCourses = document.getElementById("mCoursesBadge");
    if (mCourses) mCourses.textContent = toFa(list.length);
    const mPicked = document.getElementById("mPickedBadge");
    if (mPicked) mPicked.textContent = toFa(state.selectedCodes.size);
    if (list.length === 0) {
      container.innerHTML = `
        <div class="conflict-empty">
          درسی با این مشخصات یافت نشد.
        </div>
      `;
      return;
    }

    container.innerHTML = list
      .map((c) => {
        const isPicked = state.selectedCodes.has(c.code);
        const hasConflict = isPicked && conflictingCodes.has(c.code);

        const sessionsHtml = c.sessions.length
          ? c.sessions
              .map(
                (s) =>
                  `<span><b>${s.dayName}:</b> ${toFa(s.startTime)} تا ${toFa(s.endTime)} <small>(${s.typeLabel})</small></span>`
              )
              .join("")
          : "<span>زمان ارائه نامشخص</span>";

        const examHtml = c.exam && c.exam.date
          ? `<span class="tag tag-exam"><svg viewBox="0 0 24 24" class="ic"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18"/></svg>امتحان: ${toFa(c.exam.date)}${c.exam.startTime ? ` (${toFa(c.exam.startTime)})` : ""}</span>`
          : "";

        const roomHtml = c.room
          ? `<span class="tag tag-room"><svg viewBox="0 0 24 24" class="ic"><path d="M20 21V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14M3 21h18M9 9h1m4 0h1M9 13h1m4 0h1M9 17h1m4 0h1"/></svg>${toFa(c.room)}</span>`
          : "";

        return `
          <article class="course ${isPicked ? "is-picked" : ""} ${hasConflict ? "is-conflict" : ""}" data-code="${c.code}">
            <div class="course-top">
              <div class="course-title">
                <strong class="course-name-clickable" data-action="details" data-code="${c.code}" title="برای مشاهده جزئیات کلیک کنید">${c.name}</strong>
                <small>گروه ${toFa(c.group)} • کد ${toFa(c.courseCode)}</small>
              </div>
              <div class="course-actions">
                <button type="button" class="btn btn-sm btn-ghost btn-details" data-action="details" data-code="${c.code}" title="مشاهده تمام اطلاعات درس">
                  <svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
                  جزئیات
                </button>
                <button type="button" class="btn btn-sm ${isPicked ? "btn-ghost" : "btn-primary"} course-toggle" data-action="toggle" data-code="${c.code}">
                  ${isPicked ? "حذف" : "افزودن"}
                </button>
              </div>
            </div>

            <div class="course-meta">
              <span class="tag tag-credits">${toFa(c.credits)} واحد</span>
              <span class="tag tag-prof">${c.professor}</span>
              ${roomHtml}
              ${examHtml}
              ${c.capacity ? `<span class="tag">ظرفیت: ${toFa(c.capacity)}</span>` : ""}
            </div>

            <div class="course-sessions">
              ${sessionsHtml}
            </div>
          </article>
        `;
      })
      .join("");
  }
  // Group a day's sessions into overlap clusters so colliding classes
  // render side-by-side in both the live calendar and the export sheet.
  function clusterDaySessions(daySessions) {
    const clusters = [];
    daySessions.forEach((item) => {
      let placed = false;
      for (const cl of clusters) {
        const overlaps = cl.some(
          (other) =>
            Math.max(item.session.startMin, other.session.startMin) <
            Math.min(item.session.endMin, other.session.endMin)
        );
        if (overlaps) {
          cl.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([item]);
    });
    return clusters;
  }

  // Render weekly calendar
  function renderCalendar() {
    const el = document.getElementById("calendar");
    if (!el) return;

    const selected = state.mergedCourses.filter((c) => state.selectedCodes.has(c.code));
    const conflicts = detectCollisions(selected);

    // Set of course codes involved in lecture conflicts
    const conflictingCodes = new Set();
    conflicts.lectureConflicts.forEach((c) => {
      conflictingCodes.add(c.course1.code);
      conflictingCodes.add(c.course2.code);
    });

    // 1. Build Header Row
    let headerHtml = `<div class="cal-head-cell time-cell">ساعت</div>`;
    DAYS.forEach((d) => {
      headerHtml += `
        <div class="cal-head-cell" data-day="${d.key}">
          <span>${d.name}</span>
        </div>
      `;
    });

    // 2. Build Gutter
    let gutterHtml = `<div class="cal-gutter" style="height: ${TOTAL_HOURS * 48}px;">`;
    for (let h = START_HOUR; h < END_HOUR; h++) {
      gutterHtml += `<div class="cal-gutter-hour" style="top: ${(h - START_HOUR) * 48}px;">${toFa(h)}:۰۰</div>`;
    }
    gutterHtml += `</div>`;

    // 3. Build 6 Day Columns
    let colsHtml = "";
    DAYS.forEach((d) => {
      colsHtml += `<div class="cal-col" data-day="${d.key}" style="height: ${TOTAL_HOURS * 48}px;">`;


      // Collect all sessions on this day
      const daySessions = [];
      selected.forEach((course) => {
        course.sessions.forEach((s) => {
          if (s.dayKey === d.key && s.startMin !== null && s.endMin !== null) {
            daySessions.push({ course, session: s });
          }
        });
      });

      // Cluster overlapping sessions so colliding classes sit side-by-side
      const clusters = clusterDaySessions(daySessions);

      // Render placed blocks
      clusters.forEach((cl) => {
        const totalInCluster = cl.length;
        cl.forEach((item, idx) => {
          const { course, session: s } = item;
          const top = ((s.startMin - START_HOUR * 60) / 60) * 48;
          const height = Math.max(26, ((s.endMin - s.startMin) / 60) * 48);
          const palette = getCourseColor(course.code);
          const isConflicted = conflictingCodes.has(course.code) && totalInCluster > 1;

          const widthPercent = 100 / totalInCluster;
          const leftPercent = idx * widthPercent;

          colsHtml += `
            <div class="blk-cal ${isConflicted ? "is-conflict" : ""}"
                 style="top: ${top}px; height: ${height}px; inset-inline-start: calc(${leftPercent}% + 2px); width: calc(${widthPercent}% - 4px); background: ${isConflicted ? "var(--coral)" : palette.bg}; color: ${palette.fg};"
                 data-code="${course.code}"
                 title="${course.name} (${course.professor}) ${toFa(s.startTime)} تا ${toFa(s.endTime)}${s.room ? ` • ${toFa(s.room)}` : ""}">
              <strong>${course.name}</strong>
              <small>${toFa(s.startTime)}-${toFa(s.endTime)}${s.room ? ` • ${toFa(s.room)}` : ""}</small>
            </div>
          `;
        });
      });

      colsHtml += `</div>`;
    });

    el.innerHTML = `
      <div class="cal-head-row">
        ${headerHtml}
      </div>
      <div class="cal-body">
        ${gutterHtml}
        ${colsHtml}
      </div>
    `;
  }

  // Render conflicts tab
  function renderConflicts() {
    const container = document.getElementById("conflictList");
    if (!container) return;

    const selected = state.mergedCourses.filter((c) => state.selectedCodes.has(c.code));
    const conflicts = detectCollisions(selected);

    if (conflicts.totalCount === 0) {
      container.innerHTML = `
        <div class="conflict-empty">
          <svg viewBox="0 0 24 24" class="ic ic-emerald" style="width: 2.2rem; height: 2.2rem; margin-bottom: 8px;"><path d="M20 6 9 17l-5-5"/></svg>
          <div><strong>هیچ تداخلی وجود ندارد!</strong></div>
          <small>برنامهٔ انتخابی شما کاملاً هماهنگ است؛ ساعات کلاس‌ها، تاریخ‌های امتحان و کدهای درسی هیچ همپوشانی ندارند.</small>
        </div>
      `;
      return;
    }

    const allItems = [
      ...conflicts.duplicateConflicts.map((c) => ({
        ...c,
        cssClass: "is-duplicate",
        badgeText: "کد تکراری",
        icon: `<svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
      })),
      ...conflicts.lectureConflicts.map((c) => ({
        ...c,
        cssClass: "is-critical",
        badgeText: "تداخل کلاس",
        icon: `<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
      })),
      ...conflicts.examConflicts.map((c) => ({
        ...c,
        cssClass: c.severity === "critical" ? "is-critical" : "is-warning",
        badgeText: c.severity === "critical" ? "ساعت امتحان" : "همزمانی روز امتحان",
        icon: `<svg viewBox="0 0 24 24" class="ic"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18"/></svg>`,
      })),
    ];

    container.innerHTML = allItems
      .map(
        (c) => `
        <div class="conflict ${c.cssClass}" data-focus="${c.course1.code},${c.course2.code}">
          <span class="kind">
            ${c.icon}
          </span>
          <div class="conflict-body">
            <strong>${c.title}</strong>
            <small>${c.desc}</small>
          </div>
          <span class="conflict-badge">${c.badgeText}</span>
        </div>
      `
      )
      .join("");
  }

  function renderAll() {
    updateStats();
    renderCourseList();
    renderCalendar();
    renderConflicts();
  }


  // ------------------------------------------------------------
  // COURSE DETAILS MODAL
  // Displays every piece of information available for a course
  // ------------------------------------------------------------
  function openCourseDetails(code) {
    const course = state.mergedCourses.find((c) => c.code === code) || state.catalog102.get(code);
    if (!course) return;

    const isPicked = state.selectedCodes.has(course.code);
    const modal = document.getElementById("detailsModal");
    const backdrop = document.getElementById("detailsBackdrop");
    if (!modal || !backdrop) return;

    const enrolled = course.enrolled || 0;
    const capacity = course.capacity || 0;
    const remainingSeats = capacity ? Math.max(0, capacity - enrolled) : null;
    const capacityPercent = capacity > 0 ? Math.min(100, Math.round((enrolled / capacity) * 100)) : 0;

    // Header badges
    const headerBadges = [
      `<span class="pill">کد درس: ${toFa(course.courseCode)}</span>`,
      `<span class="pill">گروه: ${toFa(course.group)}</span>`,
      `<span class="pill pill-coral">استاد: ${course.professor}</span>`,
      course.faculty && isNaN(Number(course.faculty)) ? `<span class="pill">${course.faculty}</span>` : "",
      course.dept && isNaN(Number(course.dept)) ? `<span class="pill">${course.dept}</span>` : "",
    ].filter(Boolean).join("");

    // Sessions HTML
    const sessionsHtml = course.sessions && course.sessions.length > 0
      ? `
        <div class="session-list-modal">
          ${course.sessions.map((s, i) => `
            <div class="session-item-modal">
              <div style="display: flex; align-items: center; gap: 8px;">
                <strong>جلسه ${toFa(i + 1)}: ${s.dayName}</strong>
                <span class="tag tag-credits">${s.typeLabel}</span>
              </div>
              <div style="display: flex; gap: 8px; align-items: center;">
                <span class="tag tag-exam">ساعت ${toFa(s.startTime)} تا ${toFa(s.endTime)}</span>
                <span class="tag tag-room">${s.room ? `مکان: ${toFa(s.room)}` : "محل تشکیل: گروه آموزشی"}</span>
              </div>
            </div>
          `).join("")}
        </div>
      `
      : `
        <div class="exam-notice-box" style="background: var(--paper-2); border-color: var(--line); color: var(--ink-2);">
          <div class="exam-notice-text">
            <strong>فاقد جلسه هفتگی حضوری</strong>
            <small>این عنوان فاقد ساعات کلاسی زمان‌بندی‌شده در گزارش ۱۰۲ است (مانند دروس پروژه، کارآموزی یا سمینار).</small>
          </div>
        </div>
      `;

    // Exam HTML
    const examHtml = course.exam && course.exam.date
      ? `
        <div class="detail-rows">
          <div class="detail-row">
            <span>تاریخ آزمون پایانی:</span>
            <b>${toFa(course.exam.date)} (تقویم شمسی)</b>
          </div>
          <div class="detail-row">
            <span>ساعت برگزاری آزمون:</span>
            <b>${course.exam.startTime ? `${toFa(course.exam.startTime)} تا ${toFa(course.exam.endTime || "")}` : "ساعت نامشخص"}</b>
          </div>
          <div class="detail-row">
            <span>محل آزمون:</span>
            <b>${course.room ? toFa(course.room) : "محل برگزاری متعاقباً اعلام می‌شود"}</b>
          </div>
        </div>
      `
      : `
        <div class="exam-notice-box">
          <svg viewBox="0 0 24 24" class="ic ic-emerald" style="flex:none; width: 1.6rem; height: 1.6rem;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <div class="exam-notice-text">
            <strong>فاقد امتحان کتبی پایان‌ترم</strong>
            <small>نمرهٔ این درس بر پایهٔ کار عملی، ارزیابی مستمر، پروژه یا گزارش آزمایشگاه محاسبه می‌شود.</small>
          </div>
        </div>
      `;


    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-header-text">
          <h2>${course.name}</h2>
          <div class="modal-meta-line">
            ${headerBadges}
          </div>
        </div>
        <button type="button" class="modal-close" data-action="close-modal" aria-label="بستن">✕</button>
      </div>

      <div class="modal-body">
        <div class="details-grid">
          <!-- Card 1: Sessions & Classrooms -->
          <div class="detail-card full-width">
            <h4>
              <svg viewBox="0 0 24 24" class="ic ic-blue"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
              برنامهٔ جلسات هفتگی و محل تشکیل کلاس
            </h4>
            ${sessionsHtml}
          </div>

          <!-- Card 2: Exam -->
          <div class="detail-card">
            <h4>
              <svg viewBox="0 0 24 24" class="ic ic-amber"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18"/></svg>
              مشخصات آزمون و پایان‌ترم
            </h4>
            ${examHtml}
          </div>

          <!-- Card 3: Capacity & Registration Bento -->
          <div class="detail-card">
            <h4>
              <svg viewBox="0 0 24 24" class="ic ic-emerald"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              آمار ظرفیت و وضعیت پذیرش
            </h4>
            <div class="capacity-visual">
              <div class="capacity-labels">
                <span>ثبت‌نام‌شده: <b>${toFa(enrolled)} نفر</b></span>
                <span>ظرفیت کل: <b>${toFa(capacity)} نفر</b></span>
              </div>
              <div class="capacity-meter">
                <div class="capacity-bar" style="width: ${capacityPercent}%;"></div>
              </div>
            </div>
            <div class="mini-stats-grid">
              <div class="mini-stat">
                <small>واحد کل</small>
                <strong>${toFa(course.credits)}</strong>
              </div>
              <div class="mini-stat">
                <small>واحد عملی</small>
                <strong>${toFa(course.practicalCredits)}</strong>
              </div>
              <div class="mini-stat">
                <small>صندلی خالی</small>
                <strong style="color: ${remainingSeats === 0 ? "var(--coral)" : "var(--emerald)"};">${remainingSeats !== null ? toFa(remainingSeats) : "—"}</strong>
              </div>
              <div class="mini-stat">
                <small>پذیرش</small>
                <strong>${course.gender || "مختلط"}</strong>
              </div>
            </div>
          </div>

          <!-- Card 4: Academic Rules & Delivery -->
          <div class="detail-card">
            <h4>
              <svg viewBox="0 0 24 24" class="ic ic-coral"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              ضوابط و شیوهٔ ارائهٔ درس
            </h4>
            <div class="detail-rows">
              <div class="detail-row">
                <span>نحوهٔ ارائه درس:</span>
                <b>${course.deliveryMode || "عادی (حضوری)"}</b>
              </div>
              <div class="detail-row">
                <span>دوره / مقطع تحصیلی:</span>
                <b>${course.coursePeriod || "کارشناسی"}</b>
              </div>
              <div class="detail-row">
                <span>امکان حذف اضطراری (گزارش ۱۱۰):</span>
                <b>${course.emergencyDrop && course.emergencyDrop !== "-" ? course.emergencyDrop : "طبق آیین‌نامه دانشگاه"}</b>
              </div>
              <div class="detail-row">
                <span>اخذ توسط سایر مراکز (گزارش ۱۱۰):</span>
                <b>${course.otherCenters && course.otherCenters !== "-" ? course.otherCenters : "بررسی با آموزش"}</b>
              </div>
              <div class="detail-row">
                <span>مخصوص ورودی:</span>
                <b>${course.entryFilter && course.entryFilter !== "بی اثر" ? course.entryFilter : "همه ورودی‌های مجاز"}</b>
              </div>
              <div class="detail-row">
                <span>دروس همنیاز / متضاد:</span>
                <b>${course.requiredCourses && course.requiredCourses !== "ندارد" ? course.requiredCourses : "فاقد درس همنیاز/متضاد"}</b>
              </div>
            </div>
          </div>

          <!-- Card 5: Restrictions & Eligibility -->
          <div class="detail-card">
            <h4>
              <svg viewBox="0 0 24 24" class="ic ic-amber"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></svg>
              شرایط و محدودیت‌های اخذ درس
            </h4>
            <div style="font-size: 0.84rem; line-height: 1.85; color: var(--ink); background: var(--paper-2); padding: 12px; border-radius: 10px; border: 1.6px dashed var(--line);">
              ${course.restrictions || "هیچ محدودیت رشته‌ای یا مقطعی برای این درس ثبت نشده و برای شما مجاز است."}
            </div>
          </div>

          <!-- Card 6: Notes if any -->
          ${course.notes || course.notes110 ? `
            <div class="detail-card full-width">
              <h4>
                <svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
                توضیحات تکمیلی دانشگاه
              </h4>
              <div style="font-size: 0.85rem; line-height: 1.8; color: var(--ink);">
                ${course.notes ? `<div><b>توضیحات گزارش ۱۰۲:</b> ${course.notes}</div>` : ""}
                ${course.notes110 ? `<div><b>توضیحات گزارش ۱۱۰:</b> ${course.notes110}</div>` : ""}
              </div>
            </div>
          ` : ""}

          <!-- Card 7: Raw Strings from reports -->
          <div class="detail-card full-width">
            <h4>
              <svg viewBox="0 0 24 24" class="ic"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
              متن خام گزارش‌های رسمی دانشگاه
            </h4>
            <div style="font-family: monospace; font-size: 0.76rem; background: var(--paper-2); padding: 12px; border-radius: 10px; border: 1.6px dashed var(--line); display: flex; flex-direction: column; gap: 6px;">
              <div><b>زمان و مکان ارائه (۱۰۲):</b> ${course.rawSchedule || "—"}</div>
              <div><b>زمان و مکان امتحان (۱۰۲):</b> ${course.rawExam || "—"}</div>
              ${course.rawCombined ? `<div><b>زمان، مکان و امتحان تلفیقی (۱۱۰):</b> ${course.rawCombined}</div>` : ""}
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn ${isPicked ? "btn-ghost" : "btn-primary"}" data-action="toggle-from-modal" data-code="${course.code}">
          ${isPicked ? "حذف از برنامه هفتگی" : "افزودن به برنامه هفتگی"}
        </button>
        <button type="button" class="btn btn-ghost" data-action="close-modal">بستن پنجره</button>
      </div>
    `;

    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeCourseDetails() {
    const backdrop = document.getElementById("detailsBackdrop");
    if (backdrop) backdrop.hidden = true;
    document.body.style.overflow = "";
  }

  // ------------------------------------------------------------
  // EXPORT TIMETABLE
  // Generates clean standalone printable timetable view
  // ------------------------------------------------------------
  // Keep the export independent of the main page's styles and font URLs.
  // Inline layout CSS and the embedded Vazirmatn font also work when printed.


  function buildExportGridHtml(selected, conflictingCodes) {
    let headRow = `<div class="wcell whead">ساعت</div>`;
    let bodyRow = `<div class="wcell wcol wtime-col">`;
    for (let h = START_HOUR; h < END_HOUR; h++) {
      bodyRow += `<span class="whour" style="top:${((h - START_HOUR) / TOTAL_HOURS) * 100}%">${toFa(h)}:۰۰</span>`;
    }
    bodyRow += `</div>`;

    DAYS.forEach((day) => {
      headRow += `<div class="wcell whead">${day.name}</div>`;

      const daySessions = [];
      selected.forEach((course) => {
        course.sessions.forEach((s) => {
          if (s.dayKey === day.key && s.startMin !== null && s.endMin !== null) {
            daySessions.push({ course, session: s });
          }
        });
      });

      let blocks = "";
      clusterDaySessions(daySessions).forEach((cl) => {
        const total = cl.length;
        cl.forEach((item, idx) => {
          const { course, session: s } = item;
          const top = ((s.startMin - START_HOUR * 60) / (TOTAL_HOURS * 60)) * 100;
          const height = ((s.endMin - s.startMin) / (TOTAL_HOURS * 60)) * 100;
          const palette = getCourseColor(course.code);
          const conflicted = conflictingCodes.has(course.code) && total > 1;
          blocks += `
            <div class="wblk${conflicted ? " is-conflict" : ""}"
                 style="top:${top}%;height:${height}%;background:${conflicted ? "#fa5238" : palette.bg};inset-inline-start:calc(${(idx * 100) / total}% + 2px);width:calc(${100 / total}% - 4px);">
              <strong>${course.name}</strong>
              <span>${toFa(s.startTime)}–${toFa(s.endTime)}${s.room ? ` • ${toFa(s.room)}` : ""}</span>
            </div>`;
        });
      });

      bodyRow += `<div class="wcell wcol wday-col">${blocks}</div>`;
    });

    return `<div class="wgrid">${headRow}${bodyRow}</div>`;
  }

  async function saveTimetablePng(win, button) {
    const doc = win.document;
    const status = doc.getElementById("pngStatus");
    button.disabled = true;
    status.className = "badge";
    status.textContent = "در حال ساخت تصویر…";
    try {
      await doc.fonts.ready;
      const sheet = doc.querySelector(".sheet");
      const width = Math.ceil(sheet.getBoundingClientRect().width) + 32;
      const height = Math.ceil(sheet.getBoundingClientRect().height) + 32;
      const wrapper = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      wrapper.setAttribute("dir", "rtl");
      wrapper.setAttribute("style", `width:${width}px;padding:16px;background:#e8e5dc;color:#0f1f33;font-family:Vazirmatn, sans-serif;--ink:#0f1f33;--ink2:#475a70;--paper:#f8f5ee;--line:rgba(15,31,51,.14);`);
      const styles = doc.querySelector("style").cloneNode(true);
      wrapper.append(styles, sheet.cloneNode(true));
      const content = new XMLSerializer().serializeToString(wrapper);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${content}</foreignObject></svg>`;
      const image = new win.Image();
      // A self-contained data URL keeps canvas readable on file:// too.
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = doc.createElement("canvas");
      canvas.width = width * 2;
      canvas.height = height * 2;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNG encoding failed")), "image/png");
      });
      const url = win.URL.createObjectURL(blob);
      const link = doc.createElement("a");
      link.href = url;
      link.download = "term-harbor-timetable.png";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 60000);
      status.className = "badge b-ok";
      status.textContent = "تصویر PNG آماده شد.";
    } catch (error) {
      console.error("PNG export failed", error);
      status.className = "badge b-danger";
      status.textContent = "ساخت تصویر ناموفق بود. دوباره تلاش کنید.";
    } finally {
      button.disabled = false;
    }
  }

  function exportTimetable() {
    const selected = state.mergedCourses.filter((c) => state.selectedCodes.has(c.code));
    if (selected.length === 0) {
      showToast("هیچ درسی در برنامه انتخاب نشده است.", "is-warn");
      return;
    }
    const win = window.open("", "_blank");
    if (!win) {
      showToast("لطفاً اجازه باز شدن پنجره پاپ‌آپ را بدهید.", "is-warn");
      return;
    }
    win.document.title = "در حال آماده‌سازی برنامه…";

    const totalCredits = selected.reduce((sum, c) => sum + (c.credits || 0), 0);
    const conflicts = detectCollisions(selected);
    const conflictingCodes = new Set();
    conflicts.lectureConflicts.forEach((c) => {
      conflictingCodes.add(c.course1.code);
      conflictingCodes.add(c.course2.code);
    });

    const gridHtml = buildExportGridHtml(selected, conflictingCodes);
    const today = toFa(new Date().toLocaleDateString("fa-IR"));

    const rowsHtml = selected
      .map((c, i) => `
        <tr>
          <td>${toFa(i + 1)}</td>
          <td>${toFa(c.courseCode)}</td>
          <td>${toFa(c.group)}</td>
          <td class="c-name">${c.name}</td>
          <td>${toFa(c.credits)}</td>
          <td>${c.professor}</td>
          <td>${c.room ? toFa(c.room) : "—"}</td>
          <td class="c-sessions">${c.sessions.map((s) => `${s.dayName} ${toFa(s.startTime)}–${toFa(s.endTime)}`).join("<br>") || "—"}</td>
          <td>${c.exam && c.exam.date ? `${toFa(c.exam.date)}<br><small>${toFa(c.exam.startTime || "")}${c.exam.endTime ? `–${toFa(c.exam.endTime)}` : ""}</small>` : "—"}</td>
        </tr>
      `)
      .join("");

    const conflictBadge = conflicts.totalCount > 0
      ? `<span class="badge b-danger">⚠ ${toFa(conflicts.totalCount)} تداخل</span>`
      : `<span class="badge b-ok">✓ بدون تداخل</span>`;

    const printDoc = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<title>برنامهٔ هفتگی دروس — بندرِ ترم</title>
<style>
${embeddedFontCss}
:root { --ink:#0f1f33; --ink2:#475a70; --paper:#f8f5ee; --line:rgba(15,31,51,.14); }
* { box-sizing:border-box; }
body { margin:0; padding:28px 18px; background:#e8e5dc; color:var(--ink); font-family:'Vazirmatn','Segoe UI',Tahoma,sans-serif; -webkit-font-smoothing:antialiased; }
.win-actions { max-width:1060px; margin:0 auto 16px; display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.win-actions button { font:inherit; font-weight:800; cursor:pointer; border:2px solid var(--ink); border-radius:11px; padding:9px 20px; background:#fff; color:var(--ink); box-shadow:3px 3px 0 var(--ink); transition:transform .1s, box-shadow .1s; }
.win-actions button:hover { transform:translate(-1px,-1px); box-shadow:4px 4px 0 var(--ink); }
.win-actions .act-print { background:var(--coral,#fa5238); color:#fff; }
#pngStatus { margin-inline-start:auto; font-size:.8rem; line-height:1.8; max-width:100%; }
#pngStatus:empty { display:none; }
.sheet { max-width:1060px; margin:0 auto; background:#fff; border:2px solid var(--ink); border-radius:18px; box-shadow:8px 8px 0 rgba(15,31,51,.16); overflow:hidden; }
.sheet-head { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding:20px 24px; background:var(--paper); border-bottom:2px solid var(--ink); }
.sh-brand { display:flex; align-items:center; gap:14px; }
.sh-mark { width:44px; height:44px; flex:none; border:2px solid var(--ink); border-radius:12px; background:#fff; box-shadow:2.5px 2.5px 0 var(--ink); display:grid; grid-template-columns:1fr 1fr; gap:3px; padding:6px; }
.sh-mark i { border-radius:3px; }
.sh-brand h1 { margin:0; font-size:1.28rem; font-weight:900; line-height:1.4; }
.sh-sub { margin:0; font-size:.78rem; font-weight:700; color:var(--ink2); }
.sh-badges { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.badge { display:inline-flex; align-items:center; gap:6px; border:1.6px solid var(--ink); border-radius:999px; padding:5px 14px; font-size:.76rem; font-weight:800; background:#fff; box-shadow:2px 2px 0 var(--ink); }
.badge.b-ok { background:rgba(16,185,129,.14); border-color:rgba(13,148,136,.45); color:#067647; box-shadow:2px 2px 0 rgba(13,148,136,.45); }
.badge.b-danger { background:rgba(250,82,56,.12); border-color:rgba(225,29,72,.5); color:#b42318; box-shadow:2px 2px 0 rgba(225,29,72,.5); }
.sheet-body { padding:22px 24px; }
.sec-title { display:flex; align-items:center; gap:10px; margin:0 0 12px; font-size:1rem; font-weight:900; }
.sec-title::before { content:""; width:9px; height:22px; flex:none; border:1.6px solid var(--ink); border-radius:4px; background:#fbbf24; }
table.tbl { width:100%; border-collapse:separate; border-spacing:0; border:2px solid var(--ink); border-radius:12px; overflow:hidden; }
.tbl th, .tbl td { border-bottom:1.4px solid var(--line); padding:8px 6px; text-align:center; font-size:.8rem; line-height:1.7; }
.tbl thead th { background:var(--paper); border-bottom:1.6px solid var(--ink); font-size:.74rem; font-weight:900; }
.tbl tbody tr:nth-child(even) td { background:#fbfaf7; }
.tbl tbody tr:last-child td { border-bottom:0; }
.tbl td.c-name { text-align:start; font-weight:800; }
.tbl small { font-weight:700; color:var(--ink2); }
.wgrid { display:grid; grid-template-columns:54px repeat(6,1fr); border:2px solid var(--ink); border-radius:12px; overflow:hidden; }
.wcell { border-inline-start:1.6px solid var(--ink); }
.wgrid > .wcell:first-child { border-inline-start:0; }
.whead { background:var(--ink); color:#fff; text-align:center; padding:8px 2px; font-size:.78rem; font-weight:800; }
 .wcol { position:relative; height:calc(${TOTAL_HOURS} * var(--hour-height, 44px)); background-image:repeating-linear-gradient(to bottom, transparent 0 calc(var(--hour-height, 44px) - 1px), var(--line) calc(var(--hour-height, 44px) - 1px) var(--hour-height, 44px)); }
 .whour { position:absolute; inset-inline-start:6px; padding-top:2px; font-size:.65rem; font-weight:800; color:var(--ink2); }
.wblk { position:absolute; inset-inline-start:2px; border-radius:8px; padding:3px 6px; color:#fff; overflow:hidden; box-shadow:2px 2px 0 rgba(15,31,51,.35); line-height:1.45; }
.wblk strong { display:block; font-size:.62rem; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wblk span { display:block; font-size:.56rem; opacity:.94; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wblk.is-conflict { outline:2px dashed #fff; outline-offset:-4px; }
.sheet-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:14px 24px; border-top:2px solid var(--ink); background:var(--paper); font-size:.72rem; font-weight:700; color:var(--ink2); }
.legend { display:flex; gap:14px; flex-wrap:wrap; }
.legend span { display:inline-flex; align-items:center; gap:6px; }
.legend i { width:12px; height:12px; flex:none; border:1.4px solid var(--ink); border-radius:4px; }
@media print {
  @page { size:A4 landscape; margin:9mm; }
  body { padding:0; background:#fff; }
  .win-actions { display:none; }
  .sheet { max-width:none; border-radius:0; box-shadow:none; }
  .sheet-head { padding:6px 14px; }
  .sheet-body { padding:6px 14px; }
  .sheet-footer { padding:6px 14px; }
  .wgrid { --hour-height:24px; }
  .whead { padding:4px 2px; }
  .tbl th, .tbl td { padding:3px 4px; font-size:9px; }
  .wblk { box-shadow:none; }
  * { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
  tr, .wgrid { break-inside:avoid; }
  .sec-title { margin-bottom:6px; break-after:avoid; }
}
</style>
</head>
<body>
  <div class="win-actions">
    <button type="button" class="act-print" onclick="window.print()">چاپ / ذخیرهٔ PDF</button>
    <button type="button" id="btnPng">ذخیرهٔ PNG</button>
    <button type="button" onclick="window.close()">بستن</button>
    <span id="pngStatus" class="badge" role="status" aria-live="polite" aria-atomic="true"></span>
  </div>

  <div class="sheet">
    <header class="sheet-head">
      <div class="sh-brand">
        <span class="sh-mark"><i style="background:#1d63ed"></i><i style="background:#fbbf24"></i><i style="background:#fa5238"></i><i style="background:#10b981"></i></span>
        <div>
          <h1>برنامهٔ هفتگی دروس دانشگاه</h1>
          <p class="sh-sub">استخراج‌شده از بندرِ ترم • ${today}</p>
        </div>
      </div>
      <div class="sh-badges">
        <span class="badge">${toFa(selected.length)} درس</span>
        <span class="badge">${toFa(totalCredits)} واحد</span>
        ${conflictBadge}
      </div>
    </header>

    <div class="sheet-body">
      <h2 class="sec-title">جدول دروس انتخابی</h2>
      <table class="tbl">
        <colgroup>
          <col style="width:5%"><col style="width:9%"><col style="width:6%"><col style="width:20%"><col style="width:6%"><col style="width:12%"><col style="width:8%"><col style="width:21%"><col style="width:13%">
        </colgroup>
        <thead>
          <tr>
            <th>ردیف</th><th>کد درس</th><th>گروه</th><th>نام درس</th><th>واحد</th><th>استاد</th><th>کلاس/مکان</th><th>جلسات هفتگی</th><th>زمان امتحان</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <h2 class="sec-title" style="margin-top:22px;">شبکهٔ زمانی هفتگی</h2>
      ${gridHtml}
    </div>

    <footer class="sheet-footer">
      <div class="legend">
        <span><i style="background:#1d63ed"></i>کلاس هفتگی</span>
        <span><i style="background:#fa5238"></i>تداخل زمانی</span>
      </div>
      <span>ساخته‌شده با بندرِ ترم</span>
    </footer>
  </div>
</body>
</html>`;

    win.document.open();
    win.document.write(printDoc);
    win.document.close();
    const pngButton = win.document.getElementById("btnPng");
    pngButton.addEventListener("click", () => saveTimetablePng(win, pngButton));
    win.focus();
  }

  // ------------------------------------------------------------
  // Toast notifications
  // ------------------------------------------------------------
  function showToast(msg, kind = "") {
    const wrap = document.getElementById("toasts");
    if (!wrap) return;
    const toast = document.createElement("div");
    toast.className = `toast ${kind}`;
    toast.textContent = msg;
    wrap.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = "opacity 0.3s, transform 0.3s";
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // ------------------------------------------------------------
  // Event Handlers & Initialization
  // ------------------------------------------------------------
  function setupUploadHandlers() {
    ["212", "102", "110"].forEach((kind) => {
      const drop = document.getElementById(`drop${kind}`);
      const input = drop.querySelector("input[type=file]");

      input.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        updateDropState(kind, "", "در حال پردازش…");

        try {
          const buf = await file.arrayBuffer();

          if (kind === "212") {
            const { codes, details } = await parseReport212(buf);
            state.eligibleCodes = codes;
            state.pdfDetails = details;
            state.files["212"] = { name: file.name, size: file.size, raw: buf };
            updateDropState(kind, "is-ok", "آماده شد", file.name, `${toFa(codes.size)} درس`);
            showToast(`گزارش ۲۱۲ با موفقیت پردازش شد (${toFa(codes.size)} درس شناسایی شد).`, "is-ok");
          } else if (kind === "102") {
            const catalog = parseReport102(buf);
            state.catalog102 = catalog;
            state.files["102"] = { name: file.name, size: file.size, raw: buf };
            updateDropState(kind, "is-ok", "آماده شد", file.name, `${toFa(catalog.size)} ردیف`);
            showToast(`کاتالوگ ۱۰۲ با موفقیت پردازش شد (${toFa(catalog.size)} ردیف).`, "is-ok");
          } else if (kind === "110") {
            const catalog = parseReport110(buf);
            state.catalog110 = catalog;
            state.files["110"] = { name: file.name, size: file.size, raw: buf };
            updateDropState(kind, "is-ok", "آماده شد", file.name, `${toFa(catalog.size)} ردیف`);
            showToast(`گزارش ۱۱۰ با موفقیت اضافه شد.`, "is-ok");
          }

          // Trigger merge if mandatory files are loaded (212 + 102)
          if (state.eligibleCodes.size > 0 && state.catalog102.size > 0) {
            mergeReports();
            renderAll();

            const mergeBar = document.getElementById("mergeBar");
            const mergeText = document.getElementById("mergeText");
            mergeBar.hidden = false;
            mergeText.textContent = `ادغام موفق: ${toFa(state.mergedCourses.length)} درس مجاز با اطلاعات اساتید و ساعات کلاسی غنی شدند.`;

            document.getElementById("planner").hidden = false;
            document.getElementById("conflicts").hidden = false;
            document.getElementById("btnExport").disabled = false;
            document.getElementById("btnReset").disabled = false;
          }
        } catch (err) {
          console.error(err);
          updateDropState(kind, "is-err", "خطا در پردازش");
          showToast(`خطا در خواندن فایل: ${err.message}`, "is-warn");
        }
      });
    });
  }

  function setupInteractions() {
    // Course list click: toggle course selection
    // Course list click: toggle course selection or open details
    document.getElementById("courseList").addEventListener("click", (e) => {
      const detailsBtn = e.target.closest("[data-action='details']");
      if (detailsBtn) {
        const code = detailsBtn.dataset.code;
        if (code) openCourseDetails(code);
        return;
      }

      const btn = e.target.closest("[data-action='toggle']");
      if (!btn) return;
      const code = btn.dataset.code;
      if (!code) return;

      if (state.selectedCodes.has(code)) {
        state.selectedCodes.delete(code);
      } else {
        state.selectedCodes.add(code);
      }

      saveToStorage();
      renderAll();
    });

    // Calendar block click: focus course in list or open popover
    // Calendar block click: open full course details modal
    document.getElementById("calendar").addEventListener("click", (e) => {
      const blk = e.target.closest(".blk-cal");
      if (blk) {
        const code = blk.dataset.code;
        if (code) {
          openCourseDetails(code);
        }
        return;
      }
    });

    // Conflict item click: scroll to and highlight both courses
    document.getElementById("conflictList").addEventListener("click", (e) => {
      const item = e.target.closest("[data-focus]");
      if (!item) return;
      const codes = item.dataset.focus.split(",");
      codes.forEach((c) => {
        const el = document.querySelector(`.course[data-code='${c}']`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("is-flash");
          setTimeout(() => el.classList.remove("is-flash"), 1400);
        }
      });
    });

    // Mobile View Switcher (for phones/small screens)
    const mTabs = document.getElementById("mobileViewTabs");
    const plannerGrid = document.querySelector(".planner-grid");
    if (mTabs && plannerGrid) {
      if (!plannerGrid.dataset.activeTab) {
        plannerGrid.dataset.activeTab = "courses";
      }

      mTabs.addEventListener("click", (e) => {
        const tabBtn = e.target.closest(".m-tab");
        if (!tabBtn) return;
        const targetView = tabBtn.dataset.tab;
        if (!targetView) return;

        mTabs.querySelectorAll(".m-tab").forEach((b) => b.classList.remove("is-active"));
        tabBtn.classList.add("is-active");
        plannerGrid.dataset.activeTab = targetView;
      });
    }

    // Search box
    const searchInput = document.getElementById("search");
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderCourseList();
    });

    // Segmented filter buttons (all / picked / free)
    document.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.filterMode = btn.dataset.filter;
        renderCourseList();
      });
    });

    // Export button
    document.getElementById("btnExport").addEventListener("click", exportTimetable);

    // Reset button
    document.getElementById("btnReset").addEventListener("click", () => {
      if (confirm("آیا مطمئن هستید که می‌خواهید تمام داده‌ها و درس‌های انتخابی پاک شوند؟")) {
        resetStorage();
      }
    });
    // Modal backdrop click & button actions
    const backdrop = document.getElementById("detailsBackdrop");
    if (backdrop) {
      backdrop.addEventListener("click", (e) => {
        if (e.target.closest("[data-action='close-modal']") || e.target === backdrop) {
          closeCourseDetails();
        }

        const toggleBtn = e.target.closest("[data-action='toggle-from-modal']");
        if (toggleBtn) {
          const code = toggleBtn.dataset.code;
          if (!code) return;
          if (state.selectedCodes.has(code)) {
            state.selectedCodes.delete(code);
          } else {
            state.selectedCodes.add(code);
          }
          saveToStorage();
          renderAll();
          // Update modal button appearance in place
          const isPicked = state.selectedCodes.has(code);
          toggleBtn.className = `btn ${isPicked ? "btn-ghost" : "btn-primary"}`;
          toggleBtn.textContent = isPicked ? "حذف از برنامه هفتگی" : "افزودن به برنامه هفتگی";
        }
      });
    }

    // Keyboard Escape closes details modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeCourseDetails();
      }
    });

  }

  function init() {
    setupUploadHandlers();
    setupInteractions();

    // Check for cached state in LocalStorage
    const restored = loadFromStorage();
    if (restored) {
      document.getElementById("planner").hidden = false;
      document.getElementById("conflicts").hidden = false;
      document.getElementById("mergeBar").hidden = false;
      document.getElementById("mergeText").textContent = `اطلاعات از قبل ذخیره‌شده بازیابی شد (${toFa(state.mergedCourses.length)} درس مجاز).`;
      document.getElementById("btnExport").disabled = false;
      document.getElementById("btnReset").disabled = false;
      renderAll();
      showToast("اطلاعات برنامه از حافظهٔ دستگاه بازیابی شد.", "is-ok");
    }
  }

  // Expose parser hook on window for test automation
  window.__termHarbor = {
    state,
    parseReport212,
    parseReport102,
    parseReport110,
    mergeReports,
    detectCollisions,
    renderAll,
    openCourseDetails,
    closeCourseDetails,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();