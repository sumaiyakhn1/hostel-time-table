import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import defaultSchoolLogo from "./GITA_NIKETAN_AWASIYA_VIDYALAYA-logo.png";
import {
  isFirebaseConfigured,
  saveCurrentAdjustment,
  subscribeToCurrentAdjustment,
  saveAdjustmentRecord,
  subscribeToRecords,
  deleteAdjustmentRecord,
  type CurrentAdjustment,
} from "./firebase";

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const isLocalHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

// Use VITE_API_URL from .env.local / Vercel env vars first.
// On local development, fallback to localhost backend when VITE_API_URL is not set.
const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (isLocalHost
    ? "http://localhost:5000"
    : "https://hostel-time-table.onrender.com");

const AUTO_SAVE_DELAY = 2000;
const BREAK_AFTER_IDX = 4;
const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const DEFAULT_TIMINGS = {
  periods: [
    { label: "Period 1", start: "08:40", end: "09:20" },
    { label: "Period 2", start: "09:20", end: "10:00" },
    { label: "Period 3", start: "10:00", end: "10:40" },
    { label: "Period 4", start: "10:50", end: "11:30" },
    { label: "Period 5", start: "11:30", end: "12:05" },
    { label: "Period 6", start: "12:25", end: "13:05" },
    { label: "Period 7", start: "13:05", end: "13:40" },
    { label: "Period 8", start: "13:40", end: "14:15" },
    { label: "Period 9", start: "14:15", end: "14:25" },
  ],
  majorBreak: { start: "12:05", end: "12:25" },
};

// ── localStorage KEYS ─────────────────────────────────────────────────────────
const LS_SCHOOL_KEY = "tas_school_info_v3";
const LS_LOGO_KEY = "tas_school_logo";
const LS_SHEET_URL_KEY = "tas_sheet_url";
const LS_TIMINGS_KEY = "tas_timings_data";

const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1jsvywGYMQ_dYZb1cpFGsREMA575hbzkDoa2F0R9VkFw/edit?usp=sharing";

// ── INTERFACES ────────────────────────────────────────────────────────────────
interface SchoolInfo {
  name1: string;
  name2: string;
  type: string;
  address: string;
  phone: string;
  logoUrl: string;
}

interface Column {
  id: number;
  selectedTeacher: string;
  substituteTeacher: string[];
  classValues: string[];
}

interface Teacher {
  name: string;
  schedule: Record<string, string[]>;
}

interface AdjustmentRecord {
  id: string;
  date: string;
  day: string;
  timestamp: number;
  columns: Column[];
  totalTeachers: number;
  totalSubstitutes: number;
}

interface PeriodTiming {
  label: string;
  start: string;
  end: string;
}

interface TimingData {
  periods: PeriodTiming[];
  majorBreak: { start: string; end: string };
}

function loadTimings(): TimingData {
  try {
    const saved = localStorage.getItem(LS_TIMINGS_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return DEFAULT_TIMINGS;
}

// ── localStorage HELPERS ──────────────────────────────────────────────────────
function saveSchoolInfo(info: SchoolInfo) {
  const { logoUrl, ...rest } = info;
  localStorage.setItem(LS_SCHOOL_KEY, JSON.stringify(rest));
  if (logoUrl) localStorage.setItem(LS_LOGO_KEY, logoUrl);
}

function loadSchoolInfo(): SchoolInfo {
  const defaults: SchoolInfo = {
    name1: "",
    name2: "GITA NIKETAN AWASIYA VIDYALAYA",
    type: "",
    address: "Salarpur Road, Kurukshetra (Haryana)",
    phone: "Ph: 01744-270896, 259084",
    logoUrl: defaultSchoolLogo,
  };
  try {
    const saved = localStorage.getItem(LS_SCHOOL_KEY);
    const logo = localStorage.getItem(LS_LOGO_KEY) || defaultSchoolLogo;
    if (saved) return { ...defaults, ...JSON.parse(saved), logoUrl: logo };
  } catch {}
  return defaults;
}

function loadSheetUrl(): string {
  return localStorage.getItem(LS_SHEET_URL_KEY) || DEFAULT_SHEET_URL;
}

// ── UTILITY FUNCTIONS ─────────────────────────────────────────────────────────
function getTodayDay(): string {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return days[new Date().getDay()] ?? "Monday";
}

function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  for (const line of csvText.split("\n")) {
    if (!line.trim()) continue;
    const cols: string[] = [];
    let cur = "",
      inQ = false;
    for (const ch of line) {
      if (ch === '"') {
        inQ = !inQ;
      } else if (ch === "," && !inQ) {
        cols.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

function isDay(val: string) {
  return /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(
    val.trim(),
  );
}

function isClass(val: string) {
  return /^(I{1,3}|IV|V|VI{0,3}|VIII|IX|X{1,2}|XI{0,2}|XII|\d{1,2})[\s\-]?[A-Z]\d?$/i.test(
    val.trim(),
  );
}

function isTeacherName(val: string) {
  const v = val.trim();
  if (v.length < 4) return false;
  if (/^\d+$/.test(v)) return false;
  if (isClass(v) || isDay(v)) return false;
  if (
    /^(days|periods?|load|sr\.?no?|s\.no|name|teacher|subject|class|time|date|schedule|free|off|break|recess|lunch|assembly|diary)$/i.test(
      v,
    )
  )
    return false;
  if (/^\d+[\.\)]\s*/.test(v)) return false;
  const letters = (v.match(/[a-zA-Z]/g) || []).length;
  return letters / v.length >= 0.65;
}

function extractTeachers(rows: string[][]): Teacher[] {
  const teachers: Teacher[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const fc = (row[0] ?? "").trim(),
      sc = (row[1] ?? "").trim();
    let name = "";
    if (isTeacherName(fc)) name = fc;
    else if (isTeacherName(sc) && !isTeacherName(fc)) name = sc;
    else {
      const s = fc.replace(/^[\d.\-\s]+/, "").trim();
      if (isTeacherName(s) && s.length > 3) name = s;
    }
    if (name && !seen.has(name.toLowerCase())) {
      const schedule: Record<string, string[]> = {};
      let j = i + 1,
        daysFound = 0;
      while (j < rows.length && daysFound < 8) {
        const r = rows[j];
        const dc = (r[0] ?? "").trim();
        if (isDay(dc)) {
          const dk = dc.charAt(0).toUpperCase() + dc.slice(1).toLowerCase();
          const periods: string[] = [];
          for (let p = 1; p <= 9; p++) periods.push((r[p] ?? "").trim());
          schedule[dk] = periods;
          daysFound++;
        } else if (isTeacherName(dc) || isTeacherName((r[1] ?? "").trim()))
          break;
        j++;
      }
      if (daysFound > 0) {
        seen.add(name.toLowerCase());
        teachers.push({ name, schedule });
        i = j;
        continue;
      }
    }
    i++;
  }
  return teachers.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

function isPeriodFree(teacher: Teacher, day: string, idx: number) {
  const v = (teacher.schedule[day]?.[idx] ?? "").trim();
  return v === "" || v.toLowerCase() === "free" || v === "—" || v === "-";
}

function getFreePeriodCounts(
  teacher: Teacher,
  day: string,
  periodsLength: number,
) {
  let before = 0,
    after = 0;
  for (let i = 0; i <= BREAK_AFTER_IDX; i++)
    if (isPeriodFree(teacher, day, i)) before++;
  for (let i = BREAK_AFTER_IDX + 1; i < periodsLength - 1; i++)
    if (isPeriodFree(teacher, day, i)) after++;
  return { before, after };
}

function getAvailableSubstitutes(
  teachers: Teacher[],
  columns: Column[],
  currentColId: number,
  periodIdx: number,
  day: string,
  periodsLength: number,
) {
  const absent = new Set(columns.map((c) => c.selectedTeacher).filter(Boolean));
  const alreadySub = new Set(
    columns
      .filter((c) => c.id !== currentColId)
      .map((c) => c.substituteTeacher[periodIdx])
      .filter(Boolean),
  );
  return teachers
    .filter(
      (t) =>
        !absent.has(t.name) &&
        !alreadySub.has(t.name) &&
        isPeriodFree(t, day, periodIdx),
    )
    .map((t) => {
      const { before, after } = getFreePeriodCounts(t, day, periodsLength);
      return { ...t, freeBefore: before, freeAfter: after };
    });
}

// ── BUILD PRINT HTML ──────────────────────────────────────────────────────────
function buildPrintHTML(
  columns: Column[],
  date: string,
  selectedDay: string,
  schoolInfo: SchoolInfo,
  periods: { label: string; time: string }[],
  majorBreak: { start: string; end: string },
) {
  const totalCols = columns.length;
  // Adjusted width calculation: limit width for single/few teachers to prevent covering entire page
  let teacherW = Math.floor(82 / Math.max(totalCols, 1));
  if (totalCols === 1) teacherW = 40;
  else if (totalCols === 2) teacherW = 35;

  const logoHTML = schoolInfo.logoUrl
    ? `<img src="${schoolInfo.logoUrl}" class="school-logo" alt="logo"/>`
    : `<div class="school-logo-placeholder">🏫</div>`;

  const headerHTML = `
    <div class="school-header">
      ${logoHTML}
      <div class="school-info">
        <div class="school-name-main">${schoolInfo.name1 ? schoolInfo.name1 + " " : ""}<span>${schoolInfo.name2}</span></div>
        ${schoolInfo.type ? `<div class="school-type">${schoolInfo.type}</div>` : ""}
        <div class="school-address">${schoolInfo.address}</div>
        <div class="school-address">${schoolInfo.phone}</div>
      </div>
    </div>
    <div class="reg-title">Teacher's Adjustment Register (Session: 2026-27)</div>
    <div class="date-bar">
      <span>Date: <strong>${date}</strong></span>
      <span>Day: <strong>${selectedDay}</strong></span>
    </div>`;

  const theadHTML = `
    <tr>
      <th colspan="3" rowspan="2" style="width:18%;text-align:center;vertical-align:middle;font-size:11px;letter-spacing:0.5px;">Period / Time</th>
      <th colspan="${totalCols}" style="text-align:center;font-size:14px;letter-spacing:2px;font-weight:900;background:#1e293b;border-bottom:2px solid #475569!important;">TEACHERS ON LEAVE</th>
    </tr>
    <tr>
      ${columns
        .map(
          (col) => `
        <th style="width:${teacherW}%;background:#1e3a5f;padding:3px 2px!important;">
          <div style="font-size:12px;font-weight:800;color:white;line-height:1.1;">${col.selectedTeacher || "— Not Selected —"}</div>
          <div style="font-size:9px;font-weight:400;color:#93c5fd;margin-top:1px;">${selectedDay}</div>
        </th>`,
        )
        .join("")}
    </tr>`;

  let tbodyHTML = "";
  periods.forEach((period, pIdx) => {
    tbodyHTML += `<tr>
      <td rowspan="3" class="period-cell" style="width:5%;text-align:center;background:#e2e8f0;color:black;"><span class="p-label" style="color:black;">${period.label}</span></td>
      <td rowspan="3" class="period-cell" style="width:7%;text-align:center;background:#e2e8f0;"><span class="p-time" style="color:#475569;">${period.time}</span></td>
      <td class="row-class" style="width:6%;">📚 Class</td>
      ${columns
        .map((col) => {
          const cv = col.classValues[pIdx] ?? "";
          const isFree =
            col.selectedTeacher &&
            (cv.trim() === "" || cv.trim().toLowerCase() === "free");
          return `<td style="width:${teacherW}%;text-align:center;">${isFree ? `<span class="val-free">Free</span>` : `<span class="val-class">${cv || ""}</span>`}</td>`;
        })
        .join("")}
    </tr>`;
    tbodyHTML += `<tr>
      <td class="row-sub">👤 Teacher</td>
      ${columns
        .map((col) => {
          const cv = col.classValues[pIdx] ?? "";
          const isFree = col.selectedTeacher
            ? cv.trim() === "" || cv.trim().toLowerCase() === "free"
            : true;
          const sub = col.substituteTeacher[pIdx] || "";
          return `<td style="text-align:center;">${isFree ? `<span class="val-free"></span>` : `<span class="val-sub">${sub}</span>`}</td>`;
        })
        .join("")}
    </tr>`;
    tbodyHTML += `<tr>
      <td class="row-sign">✍️ Sign</td>
      ${columns.map(() => `<td><span class="sign-space"></span></td>`).join("")}
    </tr>`;
    if (pIdx === BREAK_AFTER_IDX) {
      tbodyHTML += `<tr class="break-row"><td colspan="${3 + totalCols}">━━━ MAJOR BREAK (${majorBreak.start} – ${majorBreak.end}) ━━━</td></tr>`;
    }
  });

  const tfootHTML = `
    <tr class="footer-row">
      <td colspan="${3 + totalCols}" style="padding:5px 8px!important;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span>PRINCIPAL</span>
          <span>TIME-TABLE ADJUSTMENT INCHARGE</span>
        </div>
      </td>
    </tr>`;

  return `${headerHTML}<table><thead>${theadHTML}</thead><tbody>${tbodyHTML}</tbody><tfoot>${tfootHTML}</tfoot></table>`;
}

// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [currentPage, setCurrentPage] = useState<"home" | "records">("home");
  // ── Teacher column pagination ──────────────────────────────────────────────
  const TEACHERS_PER_PAGE = 5;
  const [tablePageIdx, setTablePageIdx] = useState(0);

  const [schoolInfo, setSchoolInfo] = useState<SchoolInfo>(() =>
    loadSchoolInfo(),
  );
  const [showSchoolEdit, setShowSchoolEdit] = useState(false);
  const [showSheetEdit, setShowSheetEdit] = useState(false);
  const [showTimeEdit, setShowTimeEdit] = useState(false);
  const [timings, setTimings] = useState<TimingData>(() => loadTimings());
  const PERIODS = timings.periods.map((p) => ({
    label: p.label,
    time: p.start && p.end ? `${p.start}-${p.end}` : p.start || p.end || "—",
  }));

  const [sheetUrl, setSheetUrl] = useState<string>(loadSheetUrl);
  const [sheetUrlDraft, setSheetUrlDraft] = useState<string>(loadSheetUrl);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [selectedDay, setSelectedDay] = useState<string>(getTodayDay());
  const [date, setDate] = useState<string>(
    new Date().toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }),
  );
  const [columns, setColumns] = useState<Column[]>([
    {
      id: 1,
      selectedTeacher: "",
      substituteTeacher: Array(9).fill(""),
      classValues: Array(9).fill(""),
    },
  ]);

  const [records, setRecords] = useState<AdjustmentRecord[]>([]);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Database Sync State ────────────────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<
    "connected" | "syncing" | "offline" | "local"
  >("local");
  const isAutoSyncRef = useRef(false);
  // isSavingRef: true jab local change pending ho ya save ho raha ho — poller ko DB se overwrite karne se rokta hai
  const isSavingRef = useRef(false);

  // ── Persist basic states (always keep local copy as fallback) ─────────────
  useEffect(() => {
    saveSchoolInfo(schoolInfo);
  }, [schoolInfo]);
  useEffect(() => {
    localStorage.setItem(LS_TIMINGS_KEY, JSON.stringify(timings));
  }, [timings]);

  // ── Fetch Records from Database ──────────────────────────────────────────
  const fetchRecordsFromDB = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/adjustments`);
      const json = await res.json();
      if (json.success) {
        setRecords(
          json.data.map((r: AdjustmentRecord) => ({
            ...r,
            id: r.id || r.date,
          })),
        );

        // AUTO-SYNC: Sync absent teachers so everyone can see them automatically
        // isSavingRef check: agar local change pending hai to DB se overwrite mat karo
        const todayRecord = json.data.find(
          (r: AdjustmentRecord) => r.date === date,
        );
        if (todayRecord && !isSavingRef.current) {
          setColumns((prevCols) => {
            const dbColsStr = JSON.stringify(todayRecord.columns);
            const prevColsStr = JSON.stringify(prevCols);
            if (dbColsStr !== prevColsStr) {
              isAutoSyncRef.current = true;
              return JSON.parse(dbColsStr);
            }
            return prevCols;
          });
          if (selectedDay !== todayRecord.day) {
            setSelectedDay(todayRecord.day);
          }
        }
      }
    } catch (err) {
      console.error("Failed to load records from DB:", err);
    }
  };

  useEffect(() => {
    fetchRecordsFromDB();
    const intervalId = setInterval(fetchRecordsFromDB, 5000);
    return () => clearInterval(intervalId);
  }, [date]); // Re-run and sync to the currently viewed date

  // ── Auto-Save to Database ─────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;

    if (isAutoSyncRef.current) {
      isAutoSyncRef.current = false;
      return;
    }

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);

    // Poller ko rok do jab tak save complete na ho
    isSavingRef.current = true;
    setSyncStatus("local");
    autoSaveTimer.current = setTimeout(() => {
      handleSaveToDatabase(true);
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [columns, date, selectedDay, loaded]);

  // ── Manual Save to Database ─────────────────────────────────────────────
  const handleSaveToDatabase = async (isAutoSave = false) => {
    setSaveStatus("saving");
    setSyncStatus("syncing");

    try {
      let totalSubs = 0;
      columns.forEach((col) => {
        totalSubs += col.substituteTeacher.filter(
          (s) => s.trim() !== "",
        ).length;
      });

      const record: AdjustmentRecord = {
        id: date,
        date,
        day: selectedDay,
        timestamp: Date.now(),
        columns: JSON.parse(JSON.stringify(columns)),
        totalTeachers: columns.filter((c) => c.selectedTeacher).length,
        totalSubstitutes: totalSubs,
      };

      const res = await fetch(`${API_BASE_URL}/api/adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });

      const json = await res.json();
      if (json.success) {
        setSaveStatus("saved");
        setSyncStatus("connected");
        isSavingRef.current = false; // Save complete — poller ab sync kar sakta hai
        fetchRecordsFromDB(); // Refresh records
        setTimeout(() => setSaveStatus("idle"), 3000);
        if (!isAutoSave) {
          alert("✅ Data successfully saved to Database!");
        }
      } else {
        throw new Error(json.message);
      }
    } catch (err) {
      console.error("Save error:", err);
      setSaveStatus("idle");
      setSyncStatus("offline");
      isSavingRef.current = false; // Error pe bhi flag reset karo
      if (!isAutoSave) {
        alert("❌ Failed to save to database. Is the backend running?");
      }
    }
  };

  // ── Fetch sheet ────────────────────────────────────────────────────────────
  const fetchSheet = useCallback(async (url: string) => {
    setLoading(true);
    setError("");
    setLoaded(false);
    try {
      const sheetId = url.split("/d/")[1]?.split("/")[0];
      if (!sheetId) throw new Error("Bad URL");
      const res = await fetch(
        `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`,
      );
      if (!res.ok) throw new Error("Fetch failed");
      const text = await res.text();
      const rows = parseCSV(text);
      const extracted = extractTeachers(rows);
      if (extracted.length === 0) {
        setError("No teacher data found. Is the sheet publicly shared?");
        return;
      }
      setTeachers(extracted);
      setLoaded(true);
      console.log(
        "📄 Google Sheet data fetched successfully (%d teachers)",
        extracted.length,
      );
    } catch {
      setError(
        "Sheet failed to load. Is it publicly shared? (Anyone with link → Viewer)",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSheet(sheetUrl);
  }, []);

  // ── Print area update ──────────────────────────────────────────────────────
  useEffect(() => {
    const pa = document.getElementById("print-area");
    if (!pa || !loaded) return;
    pa.innerHTML = buildPrintHTML(
      columns,
      date,
      selectedDay,
      schoolInfo,
      PERIODS,
      timings.majorBreak,
    );
  }, [
    columns,
    date,
    selectedDay,
    loaded,
    schoolInfo,
    PERIODS,
    timings.majorBreak,
  ]);

  // ── Logo handlers ──────────────────────────────────────────────────────────
  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      setSchoolInfo((prev) => ({ ...prev, logoUrl: result }));
      localStorage.setItem(LS_LOGO_KEY, result);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleRemoveLogo = () => {
    setSchoolInfo((prev) => ({ ...prev, logoUrl: "" }));
    localStorage.removeItem(LS_LOGO_KEY);
  };

  // ── Sheet URL handler ──────────────────────────────────────────────────────
  const handleSaveSheetUrl = () => {
    const trimmed = sheetUrlDraft.trim();
    if (!trimmed) return;
    setSheetUrl(trimmed);
    localStorage.setItem(LS_SHEET_URL_KEY, trimmed);
    setShowSheetEdit(false);
    fetchSheet(trimmed);
  };

  // ── Reset adjustment data ──────────────────────────────────────────────────
  const handleResetData = () => {
    if (
      !confirm(
        "⚠️ Do you want to clear adjustment data?\n\n(Teacher selections, date, day)\n\nSchool info and logo will remain safe.",
      )
    )
      return;
    setColumns([
      {
        id: 1,
        selectedTeacher: "",
        substituteTeacher: Array(9).fill(""),
        classValues: Array(9).fill(""),
      },
    ]);
    setDate(
      new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }),
    );
    setSelectedDay(getTodayDay());
  };

  // ── Records handlers ───────────────────────────────────────────────────────
  const handleDeleteRecord = async (id: string) => {
    if (!confirm("⚠️ Do you want to delete this record?")) return;
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/adjustments?date=${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
      );
      const json = await res.json();
      if (json.success) {
        setRecords((prev) => prev.filter((r) => r.id !== id));
        fetchRecordsFromDB();
        alert("✅ Record deleted!");
      } else {
        alert("❌ Failed to delete record.");
      }
    } catch (err) {
      console.error(err);
      alert("❌ Could not connect to database.");
    }
  };

  const handleLoadRecord = (record: AdjustmentRecord) => {
    if (
      !confirm(
        `📥 Load this record?\n\nDate: ${record.date}\nDay: ${record.day}\n\nCurrent adjustment data will be replaced!`,
      )
    )
      return;
    setDate(record.date);
    setSelectedDay(record.day);
    setColumns(JSON.parse(JSON.stringify(record.columns)));
    setCurrentPage("home");
    alert("✅ Record loaded successfully!");
  };

  const handlePrintRecord = (record: AdjustmentRecord) => {
    const win = window.open("", "_blank", "width=1200,height=900");
    if (!win) {
      alert("Popup blocked! Please allow popups for this site.");
      return;
    }
    win.document.write(
      buildMultiPagePrintDoc(record.columns, record.date, record.day),
    );
    win.document.close();
    win.focus();
    setTimeout(() => {
      win.print();
    }, 500);
  };

  // ── Column / teacher handlers ──────────────────────────────────────────────
  const handleTeacherSelect = (colId: number, name: string) =>
    setColumns((prev) =>
      prev.map((col) => {
        if (col.id !== colId) return col;
        const t = teachers.find((t) => t.name === name);
        const ds =
          t?.schedule[selectedDay] ??
          t?.schedule[Object.keys(t?.schedule ?? {})[0]] ??
          [];
        return {
          ...col,
          selectedTeacher: name,
          classValues: Array(9)
            .fill("")
            .map((_, i) => ds[i] ?? ""),
          substituteTeacher: Array(9).fill(""),
        };
      }),
    );

  const handleGlobalDayChange = (day: string) => {
    setSelectedDay(day);
    setColumns((prev) =>
      prev.map((col) => {
        const t = teachers.find((t) => t.name === col.selectedTeacher);
        if (!t) return { ...col, substituteTeacher: Array(9).fill("") };
        const ds = t.schedule[day] ?? [];
        return {
          ...col,
          classValues: Array(9)
            .fill("")
            .map((_, i) => ds[i] ?? ""),
          substituteTeacher: Array(9).fill(""),
        };
      }),
    );
  };

  const updateClassValue = (colId: number, pIdx: number, val: string) =>
    setColumns((prev) =>
      prev.map((col) => {
        if (col.id !== colId) return col;
        const cv = [...col.classValues];
        cv[pIdx] = val;
        return { ...col, classValues: cv };
      }),
    );

  const updateSubstitute = (colId: number, pIdx: number, val: string) =>
    setColumns((prev) =>
      prev.map((col) => {
        if (col.id !== colId) return col;
        const st = [...col.substituteTeacher];
        st[pIdx] = val;
        return { ...col, substituteTeacher: st };
      }),
    );

  const addColumn = () => {
    const nextId = Math.max(...columns.map((c) => c.id)) + 1;
    setColumns((prev) => [
      ...prev,
      {
        id: nextId,
        selectedTeacher: "",
        substituteTeacher: Array(9).fill(""),
        classValues: Array(9).fill(""),
      },
    ]);
  };

  const removeColumn = (colId: number) => {
    if (columns.length === 1) return;
    setColumns((prev) => prev.filter((c) => c.id !== colId));
  };

  // ── Build a full standalone multi-page HTML document for print/PDF ──────────
  const buildMultiPagePrintDoc = (
    printCols: Column[] = columns,
    printDate: string = date,
    printDay: string = selectedDay,
  ) => {
    // Split all columns into chunks of TEACHERS_PER_PAGE
    const chunks: Column[][] = [];
    for (let i = 0; i < printCols.length; i += TEACHERS_PER_PAGE) {
      chunks.push(printCols.slice(i, i + TEACHERS_PER_PAGE));
    }

    // Shared CSS for all pages
    const css = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      @page { size: A4 portrait; margin: 5mm 6mm; }
      html, body { background: white; font-family: Arial, sans-serif; }

      /* Each .print-page fills exactly one A4 landscape sheet */
      .print-page {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100vh;
        page-break-after: always;
        overflow: hidden;
      }
      .print-page:last-child { page-break-after: auto; }

      /* School Header */
      .school-header { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 3px 0; border-bottom: 2px solid #1e293b; margin-bottom: 2px; flex-shrink: 0; }
      .school-logo { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #1e293b; object-fit: cover; flex-shrink: 0; }
      .school-logo-placeholder { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #1e293b; display: flex; align-items: center; justify-content: center; font-size: 20px; background: #f1f5f9; flex-shrink: 0; }
      .school-info { text-align: center; }
      .school-name-main { font-size: 20px; font-weight: 900; letter-spacing: 0.5px; line-height: 1.1; color: #1e293b; }
      .school-name-main span { color: #dc2626; }
      .school-type { font-size: 12px; font-weight: 700; color: #1d4ed8; letter-spacing: 2px; }
      .school-address { font-size: 11px; color: #64748b; line-height: 1.3; }

      /* Title & Date */
      .reg-title { text-align: center; font-size: 14px; font-weight: 800; letter-spacing: 1px; color: #1e293b; margin: 2px 0 1px; text-transform: uppercase; border-top: 1px solid #cbd5e1; border-bottom: 1px solid #cbd5e1; padding: 2px 0; flex-shrink: 0; }
      .date-bar { display: flex; justify-content: space-between; font-size: 12px; color: #334155; margin: 2px 0 3px; padding: 0 2px; flex-shrink: 0; }

      /* Table stretches to fill remaining height */
      table { width: auto; min-width: 65%; max-width: 100%; border-collapse: collapse; font-size: 12px; border: 1.5px solid #1e293b; table-layout: fixed; flex: 1 1 auto; min-height: 0; }
      tbody { height: 100%; }
      tbody tr { height: 1px; }
      th, td { border: 0.5px solid #94a3b8; padding: 2px 3px; vertical-align: middle; line-height: 1.15; overflow: hidden; }
      thead th { background: #1e293b !important; color: white !important; padding: 3px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

      .period-cell { background: #e2e8f0 !important; color: #1e293b !important; text-align: center; vertical-align: middle; padding: 1px !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .p-label { font-size: 12px; font-weight: 800; color: #1e293b; display: block; }
      .p-time { font-size: 9px; color: #475569; display: block; line-height: 1; }

      .row-class { background: #fffbeb !important; font-size: 10px; font-weight: 700; color: #92400e; white-space: nowrap; text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .row-sub { background: #f0fdf4 !important; font-size: 10px; font-weight: 700; color: #166534; white-space: nowrap; text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .row-sign { background: #faf5ff !important; font-size: 10px; font-weight: 700; color: #6b21a8; white-space: nowrap; text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

      .val-free { color: #94a3b8; font-style: italic; font-size: 10px; }
      .val-class { font-weight: 400; color: #1e3a5f; font-size: 12px; }
      .val-sub { font-weight: 900; color: #166534; font-size: 12px; }
      .sign-space { display: block; height: 100%; }

      .break-row td { background: #fef9c3 !important; text-align: center; font-weight: 800; font-size: 11px; color: #854d0e; padding: 1px !important; letter-spacing: 0.5px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .footer-row td { background: #f8fafc !important; font-weight: 700; font-size: 13px; color: #334155; padding: 4px 6px !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    `;

    // Build one <div class="print-page"> per chunk
    const pages = chunks
      .map(
        (chunk) =>
          `<div class="print-page">${buildPrintHTML(chunk, printDate, printDay, schoolInfo, PERIODS, timings.majorBreak)}</div>`,
      )
      .join("\n");

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><style>${css}</style></head>
<body>${pages}</body>
</html>`;
  };

  const handlePrint = () => {
    const win = window.open("", "_blank", "width=1200,height=900");
    if (!win) {
      alert("Popup blocked! Please allow popups for this site.");
      return;
    }
    win.document.write(buildMultiPagePrintDoc());
    win.document.close();
    win.focus();
    setTimeout(() => {
      win.print();
    }, 500);
  };

  // ── Shared Print Styles ──
  const printStyles = `
    .pdf-page { width: 210mm; padding: 10mm; background: white; margin: 0 auto; font-family: Arial, sans-serif; color: black; }
    .school-header { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 5px 0; border-bottom: 2px solid #1e293b; margin-bottom: 5px; }
    .school-logo { width: 50px; height: 50px; border-radius: 50%; border: 2px solid #1e293b; object-fit: cover; }
    .school-logo-placeholder { width: 50px; height: 50px; border-radius: 50%; border: 2px solid #1e293b; display: flex; align-items: center; justify-content: center; font-size: 24px; background: #f1f5f9; }
    .school-info { text-align: center; }
    .school-name-main { font-size: 22px; font-weight: 900; color: #1e293b; }
    .school-name-main span { color: #dc2626; }
    .school-type { font-size: 13px; font-weight: 700; color: #1d4ed8; letter-spacing: 2px; }
    .school-address { font-size: 12px; color: #64748b; }
    .reg-title { text-align: center; font-size: 16px; font-weight: 800; color: #1e293b; margin: 5px 0; text-transform: uppercase; border-top: 1px solid #cbd5e1; border-bottom: 1px solid #cbd5e1; padding: 3px 0; }
    .date-bar { display: flex; justify-content: space-between; font-size: 13px; color: #334155; margin-bottom: 5px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; border: 1.5px solid #1e293b; table-layout: fixed; }
    th, td { border: 0.5px solid #94a3b8; padding: 4px; vertical-align: middle; text-align: center; }
    thead th { background: #1e293b !important; color: white !important; }
    .period-cell { background: #e2e8f0 !important; color: #1e293b !important; font-weight: bold; }
    .row-class { background: #fffbeb !important; font-weight: bold; color: #92400e; }
    .row-sub { background: #f0fdf4 !important; font-weight: bold; color: #166534; }
    .val-class { font-weight: 400; color: #1e3a5f; font-size: 13px; }
    .val-sub { font-weight: 900; color: #166534; font-size: 13px; }
    .break-row td { background: #fef9c3 !important; font-weight: 800; color: #854d0e; }
    .footer-row td { background: #f8fafc !important; font-weight: 700; padding: 10px !important; }
  `;

  const handleDownloadPDF = () => {
    const win = window.open("", "_blank", "width=1200,height=900");
    if (!win) {
      alert("Popup blocked! Please allow popups for this site.");
      return;
    }

    const docHtml = buildMultiPagePrintDoc();

    // Add html2pdf CDN and download logic
    const enhancedHtml = docHtml
      .replace(
        "</head>",
        `
        <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
        <script>
          async function downloadAsPDF() {
            const btn = document.querySelector('.no-print');
            const originalDisplay = btn.style.display;
            btn.style.display = 'none';
            
            // Add a small delay for the UI to update
            await new Promise(r => setTimeout(r, 100));

            const opt = {
              margin: [0, 0, 0, 0],
              filename: 'Adjustment_Report_${date.replace(/\//g, "-")}.pdf',
              image: { type: 'jpeg', quality: 0.98 },
              html2canvas: { 
                scale: 2, 
                useCORS: true, 
                letterRendering: true,
                backgroundColor: '#ffffff'
              },
              jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
              pagebreak: { mode: ['css', 'legacy'] }
            };

            try {
              await html2pdf().set(opt).from(document.body).save();
            } catch (err) {
              console.error(err);
              alert("Direct download failed. Please use the 'Print / Save as PDF' button instead.");
            } finally {
              btn.style.display = originalDisplay;
            }
          }
        </script>
      </head>
    `,
      )
      .replace(
        "<body>",
        `
      <body>
        <div class="no-print" style="position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; gap: 10px;">
          <button onclick="downloadAsPDF()" style="background: #10b981; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
            📥 Download PDF
          </button>
          <button onclick="window.print()" style="background: #ef4444; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
            🖨️ Print / Save as PDF
          </button>
          <button onclick="window.close()" style="background: #64748b; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer;">
            Close
          </button>
        </div>
        <style>
          @media print { .no-print { display: none !important; } }
        </style>
    `,
      );

    win.document.write(enhancedHtml);
    win.document.close();
    win.focus();
  };

  const handlePrintAnalyticReport = (title: string, contentId: string) => {
    const content = document.getElementById(contentId);
    if (!content) return;

    const win = window.open("", "_blank", "width=1200,height=900");
    if (!win) return;

    // Get all style tags and link tags to ensure Tailwind and other styles are copied
    const styles = Array.from(
      document.querySelectorAll("style, link[rel='stylesheet']"),
    )
      .map((s) => s.outerHTML)
      .join("\n");

    const winHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${title}</title>
          ${styles}
          <style>
            @page { size: A4 portrait; margin: 10mm; }
            body { padding: 0; margin: 0; background: white !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            .print-container { padding: 30px; width: 100%; max-width: 210mm; margin: 0 auto; overflow: visible !important; }
            .no-print { display: flex; justify-content: flex-end; margin-bottom: 20px; }
            @media print { 
              body > * { display: block !important; }
              .no-print { display: none !important; }
              body { padding: 0; }
              .print-container { padding: 0; margin: 0; max-width: 100%; width: 100%; display: block !important; }
            }
            #print-content { opacity: 1 !important; visibility: visible !important; }
            /* Force visibility for Tailwind classes */
            [class*="hidden"] { display: block !important; }
            [class*="opacity-0"] { opacity: 1 !important; }
            
            table { width: 100% !important; border-collapse: collapse !important; border: 1px solid #cbd5e1 !important; margin-top: 10px; table-layout: auto !important; }
            th, td { border: 1px solid #cbd5e1 !important; padding: 12px 8px !important; text-align: left; vertical-align: middle; }
            th { background-color: #f1f5f9 !important; font-weight: bold; }
            
            .bg-yellow-50 { background-color: #fefce8 !important; }
            .bg-slate-50 { background-color: #f8fafc !important; }
            .bg-orange-50 { background-color: #fff7ed !important; }
            .bg-blue-100 { background-color: #dbeafe !important; }
            .bg-blue-600 { background-color: #2563eb !important; }
            .text-blue-800 { color: #1e40af !important; }
            .text-slate-800 { color: #1e293b !important; }
            .text-red-700 { color: #b91c1c !important; }
          </style>
        </head>
        <body>
          <div class="print-container">
            <div class="no-print">
              <button onclick="window.print()" style="background: #2563eb; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                🖨️ Print Report
              </button>
            </div>
            <div id="print-content">
              <div style="text-align:center; margin-bottom: 30px; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px;">
                <h1 style="font-size: 26px; color: #1e293b; margin-bottom: 10px;">${title}</h1>
                <h2 style="font-size: 18px; color: #ef4444; margin: 0;">${schoolInfo.name1} ${schoolInfo.name2}</h2>
                <p style="color: #64748b; font-size: 13px; margin: 5px 0;">${schoolInfo.address}</p>
                <p style="color: #64748b; font-size: 12px;">Report Generated: ${new Date().toLocaleString("en-IN")}</p>
              </div>
              <div id="main-content-target"></div>
              <div style="margin-top: 80px; display: flex; justify-content: space-between; font-weight: bold; font-size: 14px;">
                <div style="border-top: 2px solid #334155; padding-top: 10px; width: 220px; text-align: center;">PRINCIPAL</div>
                <div style="border-top: 2px solid #334155; padding-top: 10px; width: 220px; text-align: center;">INCHARGE</div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
    win.document.write(winHtml);
    const target = win.document.getElementById("main-content-target");
    if (target) {
      target.innerHTML = content.innerHTML;
    }
    win.document.close();
    win.focus();
    setTimeout(() => {
      win.print();
    }, 500);
  };

  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-slate-100" style={{ fontSize: "15px" }}>
      {/* ── SCHOOL HEADER ── */}
      <div className="bg-white border-b-4 border-slate-800 shadow-md">
        <div className="max-w-screen-xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          {/* Logo + School Name */}
          <div className="flex items-center gap-4">
            <div className="relative flex-shrink-0">
              <div
                className="w-20 h-20 rounded-full border-4 border-slate-800 overflow-hidden flex items-center justify-center bg-slate-100 cursor-pointer hover:opacity-80 transition"
                onClick={() => logoInputRef.current?.click()}
                title="Click to change logo"
              >
                {schoolInfo.logoUrl ? (
                  <img
                    src={schoolInfo.logoUrl}
                    alt="logo"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span style={{ fontSize: "32px" }}>🏫</span>
                )}
              </div>
              {schoolInfo.logoUrl && (
                <button
                  onClick={handleRemoveLogo}
                  title="Remove logo"
                  className="absolute -top-1 -right-1 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition shadow"
                  style={{ fontSize: "13px", lineHeight: "1" }}
                >
                  ✕
                </button>
              )}
            </div>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleLogoUpload}
            />

            <div>
              <div
                style={{
                  fontSize: "24px",
                  fontWeight: 900,
                  letterSpacing: "1px",
                  lineHeight: 1.1,
                }}
              >
                {schoolInfo.name1 && (
                  <span className="text-slate-900">{schoolInfo.name1} </span>
                )}
                <span className="text-red-600">{schoolInfo.name2}</span>
              </div>
              {schoolInfo.type && (
                <div
                  style={{
                    fontSize: "15px",
                    fontWeight: 700,
                    color: "#1d4ed8",
                    letterSpacing: "3px",
                  }}
                >
                  {schoolInfo.type}
                </div>
              )}
              <div style={{ fontSize: "13px", color: "#64748b" }}>
                {schoolInfo.address}
              </div>
              <div style={{ fontSize: "13px", color: "#64748b" }}>
                {schoolInfo.phone}
              </div>
            </div>
          </div>

          {/* Right side */}
          <div className="text-right flex-shrink-0">
            <div
              style={{ fontSize: "18px", fontWeight: 800, color: "#1e293b" }}
              className="uppercase tracking-wide"
            >
              Teacher's Adjustment System
            </div>
            <div style={{ fontSize: "13px", color: "#64748b" }}>
              Academic Year 2026-27
            </div>
            {/* ── Sync Status Badge ── */}
            <div className="mt-1 flex justify-end">
              {syncStatus === "connected" && (
                <span className="inline-flex items-center gap-1.5 bg-green-50 border border-green-300 text-green-700 text-xs font-bold px-3 py-1 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
                  🌐 Connected to Database
                </span>
              )}
              {syncStatus === "syncing" && (
                <span className="inline-flex items-center gap-1.5 bg-yellow-50 border border-yellow-300 text-yellow-700 text-xs font-bold px-3 py-1 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-yellow-400 animate-ping inline-block"></span>
                  ⏳ Saving...
                </span>
              )}
              {syncStatus === "offline" && (
                <span className="inline-flex items-center gap-1.5 bg-red-50 border border-red-300 text-red-700 text-xs font-bold px-3 py-1 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-red-500 inline-block"></span>
                  📴 Database Offline
                </span>
              )}
              {syncStatus === "local" && (
                <span className="inline-flex items-center gap-1.5 bg-slate-100 border border-slate-300 text-slate-600 text-xs font-semibold px-3 py-1 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-slate-400 inline-block"></span>
                  💾 Unsaved Changes
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2 mt-2">
              <div className="flex gap-2 justify-end flex-wrap">
                <button
                  onClick={() => {
                    setSheetUrlDraft(sheetUrl);
                    setShowSheetEdit(!showSheetEdit);
                    setShowSchoolEdit(false);
                  }}
                  className="bg-green-700 text-white px-4 py-1.5 rounded-lg text-sm font-semibold hover:bg-green-600 transition"
                >
                  📊 Edit Google Sheet
                </button>
                <button
                  onClick={() => {
                    setShowTimeEdit(!showTimeEdit);
                    setShowSheetEdit(false);
                    setShowSchoolEdit(false);
                  }}
                  className="bg-red-700 text-white px-4 py-1.5 rounded-lg text-sm font-semibold hover:bg-red-600 transition"
                >
                  {showTimeEdit ? "✅ Close Edit" : "⏱️ Edit Period Times"}
                </button>
                {/* <button
                  onClick={() => {
                    setShowSchoolEdit(!showSchoolEdit);
                    setShowSheetEdit(false);
                  }}
                  className="bg-slate-800 text-white px-4 py-1.5 rounded-lg text-sm font-semibold hover:bg-slate-600 transition"
                >
                  {showSchoolEdit ? "✅ Close Edit" : "✏️ Edit School Info"}
                </button> */}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleResetData}
                  className="bg-orange-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-orange-700 transition"
                  title="Clear only adjustment data"
                >
                  🔄 Reset Adjustments
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Sheet URL Edit Panel */}
        {showSheetEdit && (
          <div className="max-w-screen-xl mx-auto px-6 pb-5">
            <div className="bg-green-50 border border-green-300 rounded-xl p-4">
              <h3
                className="font-bold text-green-800 mb-3"
                style={{ fontSize: "15px" }}
              >
                📊 Google Sheet URL Edit
              </h3>
              <p className="text-green-700 text-xs mb-3">
                Sheet publicly shared honi chahiye —{" "}
                <strong>"Anyone with link → Viewer"</strong>
              </p>
              <div className="flex gap-2 flex-wrap">
                <input
                  type="text"
                  value={sheetUrlDraft}
                  onChange={(e) => setSheetUrlDraft(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  className="flex-1 min-w-0 border-2 border-green-400 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                  style={{ fontSize: "13px" }}
                />
                <button
                  onClick={handleSaveSheetUrl}
                  className="bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-bold hover:bg-green-600 transition whitespace-nowrap"
                >
                  💾 Save & Load
                </button>
                <button
                  onClick={() => setShowSheetEdit(false)}
                  className="bg-slate-400 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-slate-500 transition"
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-green-600 mt-2">
                Current:{" "}
                <span className="font-mono text-green-800 break-all">
                  {sheetUrl}
                </span>
              </p>
            </div>
          </div>
        )}

        {/* School Info Edit Panel */}
        {showSchoolEdit && (
          <div className="max-w-screen-xl mx-auto px-6 pb-5">
            <div className="bg-slate-50 border border-slate-300 rounded-xl p-4">
              <h3
                className="font-bold text-slate-700 mb-3"
                style={{ fontSize: "15px" }}
              >
                ✏️ School Information Edit
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {(
                  [
                    ["School Name Part 1", "name1"],
                    ["School Name Part 2 (Red)", "name2"],
                    ["School Type", "type"],
                    ["Address", "address"],
                    ["Phone", "phone"],
                  ] as [string, keyof SchoolInfo][]
                ).map(([label, key]) => (
                  <div key={key}>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">
                      {label}
                    </label>
                    <input
                      value={schoolInfo[key] as string}
                      onChange={(e) =>
                        setSchoolInfo((p) => ({ ...p, [key]: e.target.value }))
                      }
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                    />
                  </div>
                ))}
                <div className="flex flex-col gap-2">
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Logo
                  </label>
                  <button
                    onClick={() => logoInputRef.current?.click()}
                    className="bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700"
                  >
                    📷 {schoolInfo.logoUrl ? "Change Logo" : "Upload Logo"}
                  </button>
                  {schoolInfo.logoUrl && (
                    <button
                      onClick={handleRemoveLogo}
                      className="bg-red-500 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-red-600"
                    >
                      🗑️ Remove Logo
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-3">
                💾 Sab changes automatically save hote hain — page refresh ke
                baad bhi rahenge
              </p>
            </div>
          </div>
        )}

        {/* Period Times Edit Panel */}
        {showTimeEdit && (
          <div className="max-w-screen-xl mx-auto px-6 pb-5">
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm max-w-lg">
              <h3 className="font-bold text-red-800 mb-2 text-xl">
                Edit Period Times
              </h3>
              <p className="text-slate-500 text-sm mb-6">
                Format: HH:MM (e.g. 08:00). Saved on this device.
              </p>

              <div className="flex flex-col gap-3">
                {timings.periods.slice(0, 5).map((p, idx) => (
                  <div key={idx} className="flex items-center gap-4">
                    <span className="w-24 font-bold text-slate-800">
                      {p.label}
                    </span>
                    <input
                      type="text"
                      value={p.start}
                      onChange={(e) => {
                        const newPeriods = [...timings.periods];
                        newPeriods[idx].start = e.target.value;
                        setTimings({ ...timings, periods: newPeriods });
                      }}
                      className="w-24 border border-slate-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-red-400"
                    />
                    <span className="text-slate-400">-</span>
                    <input
                      type="text"
                      value={p.end}
                      onChange={(e) => {
                        const newPeriods = [...timings.periods];
                        newPeriods[idx].end = e.target.value;
                        setTimings({ ...timings, periods: newPeriods });
                      }}
                      className="w-24 border border-slate-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-red-400"
                    />
                  </div>
                ))}

                <div className="bg-red-50 border border-red-200 border-dashed rounded flex items-center gap-4 p-3 my-1">
                  <span className="w-24 font-bold text-red-700">
                    Major Break
                  </span>
                  <input
                    type="text"
                    value={timings.majorBreak.start}
                    onChange={(e) =>
                      setTimings({
                        ...timings,
                        majorBreak: {
                          ...timings.majorBreak,
                          start: e.target.value,
                        },
                      })
                    }
                    className="w-24 border border-slate-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-red-400 bg-white"
                  />
                  <span className="text-slate-400">-</span>
                  <input
                    type="text"
                    value={timings.majorBreak.end}
                    onChange={(e) =>
                      setTimings({
                        ...timings,
                        majorBreak: {
                          ...timings.majorBreak,
                          end: e.target.value,
                        },
                      })
                    }
                    className="w-24 border border-slate-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-red-400 bg-white"
                  />
                </div>

                {timings.periods.slice(5).map((p, i) => {
                  const idx = i + 5;
                  return (
                    <div key={idx} className="flex items-center gap-4">
                      <span className="w-24 font-bold text-slate-800">
                        {p.label}
                      </span>
                      <input
                        type="text"
                        value={p.start}
                        onChange={(e) => {
                          const newPeriods = [...timings.periods];
                          newPeriods[idx].start = e.target.value;
                          setTimings({ ...timings, periods: newPeriods });
                        }}
                        className="w-24 border border-slate-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-red-400"
                      />
                      <span className="text-slate-400">-</span>
                      <input
                        type="text"
                        value={p.end}
                        onChange={(e) => {
                          const newPeriods = [...timings.periods];
                          newPeriods[idx].end = e.target.value;
                          setTimings({ ...timings, periods: newPeriods });
                        }}
                        className="w-24 border border-slate-300 rounded px-2 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-red-400"
                      />
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-between items-center mt-6 pt-4 border-t border-slate-200">
                <button
                  onClick={() => {
                    if (
                      confirm(
                        "Are you sure you want to reset to default times?",
                      )
                    ) {
                      setTimings(DEFAULT_TIMINGS);
                    }
                  }}
                  className="text-red-700 font-bold hover:underline"
                >
                  Reset
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowTimeEdit(false)}
                    className="bg-slate-300 text-slate-700 px-6 py-2 rounded font-bold hover:bg-slate-400 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setShowTimeEdit(false)}
                    className="bg-emerald-600 text-white px-8 py-2 rounded font-bold hover:bg-emerald-700 transition"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="max-w-screen-xl mx-auto px-6">
          <div className="flex gap-1 border-b-2 border-slate-200">
            <button
              onClick={() => setCurrentPage("home")}
              className={`px-6 py-3 font-bold text-sm transition ${currentPage === "home" ? "bg-slate-800 text-white border-b-4 border-slate-800" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              🏠 Adjustment Form
            </button>
            <button
              onClick={() => setCurrentPage("records")}
              className={`px-6 py-3 font-bold text-sm transition relative ${currentPage === "records" ? "bg-blue-600 text-white border-b-4 border-blue-600" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              📋 Records
              {records.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                  {records.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="max-w-screen-xl mx-auto p-4 md:p-6">
        {/* HOME PAGE */}
        {currentPage === "home" && (
          <>
            {loading && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
                <div className="spinner mb-4"></div>
                <p
                  className="text-slate-600 font-semibold"
                  style={{ fontSize: "16px" }}
                >
                  ⏳ Timetable data is loading…
                </p>
                <p className="text-slate-400 mt-1" style={{ fontSize: "13px" }}>
                  Fetching data from Google Sheet, please wait…
                </p>
              </div>
            )}

            {!loading && error && (
              <div className="bg-white rounded-xl border border-red-200 shadow-sm p-8 text-center">
                <div className="text-5xl mb-4">⚠️</div>
                <p
                  className="text-red-700 font-bold mb-2"
                  style={{ fontSize: "16px" }}
                >
                  {error}
                </p>
                <p className="text-slate-500 mb-4" style={{ fontSize: "13px" }}>
                  Sheet publicly shared honi chahiye — "Anyone with link →
                  Viewer"
                </p>
                <div className="flex gap-3 justify-center flex-wrap">
                  <button
                    onClick={() => fetchSheet(sheetUrl)}
                    className="bg-slate-800 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-slate-600"
                  >
                    🔄 Retry
                  </button>
                  <button
                    onClick={() => {
                      setSheetUrlDraft(sheetUrl);
                      setShowSheetEdit(true);
                    }}
                    className="bg-green-700 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-green-600"
                  >
                    📊 Edit Sheet URL
                  </button>
                </div>
              </div>
            )}

            {!loading && loaded && (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <h2
                      style={{ fontSize: "17px" }}
                      className="font-bold text-slate-900 uppercase tracking-wide"
                    >
                      Teacher's Adjustment Register
                    </h2>
                    <p
                      style={{ fontSize: "13px" }}
                      className="text-slate-500 mt-1 flex items-center gap-2 flex-wrap"
                    >
                      ✅ <strong>{teachers.length} teachers</strong> loaded
                      &nbsp;·&nbsp; Date:{" "}
                      <span className="font-semibold text-slate-700">
                        {date}
                      </span>
                      {saveStatus === "saving" && (
                        <span className="text-yellow-600 font-semibold animate-pulse">
                          💾 Saving...
                        </span>
                      )}
                      {saveStatus === "saved" && (
                        <span className="text-green-600 font-semibold">
                          ✅ Saved!
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      style={{ fontSize: "14px" }}
                      className="border border-slate-300 rounded-lg px-3 py-2 w-32"
                    />
                    <select
                      value={selectedDay}
                      onChange={(e) => handleGlobalDayChange(e.target.value)}
                      style={{ fontSize: "14px" }}
                      className="border border-slate-300 rounded-lg px-3 py-2 font-semibold text-slate-700"
                    >
                      {DAYS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={addColumn}
                      style={{ fontSize: "14px" }}
                      className="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700"
                    >
                      + Add Column
                    </button>
                    <button
                      onClick={handlePrint}
                      style={{ fontSize: "14px" }}
                      className="bg-slate-800 text-white px-4 py-2 rounded-lg font-semibold hover:bg-slate-600"
                    >
                      🖨️ Print
                    </button>
                    <button
                      onClick={handleDownloadPDF}
                      style={{ fontSize: "14px" }}
                      className="bg-red-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-red-700 flex items-center gap-2"
                    >
                      📄 PDF Preview
                    </button>
                  </div>
                </div>

                {/* ── Teacher Page Navigation ─────────────────────── */}
                {(() => {
                  const totalPages = Math.ceil(
                    columns.length / TEACHERS_PER_PAGE,
                  );
                  if (totalPages <= 1) return null;
                  return (
                    <div className="flex items-center justify-between mb-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-blue-800 font-bold text-sm">
                          📄 Page:
                        </span>
                        {Array.from({ length: totalPages }, (_, i) => (
                          <button
                            key={i}
                            onClick={() => setTablePageIdx(i)}
                            className={`w-8 h-8 rounded-lg font-bold text-sm transition ${
                              tablePageIdx === i
                                ? "bg-blue-600 text-white shadow"
                                : "bg-white text-blue-600 border border-blue-300 hover:bg-blue-100"
                            }`}
                          >
                            {i + 1}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-blue-600 text-xs font-semibold">
                          Showing teachers{" "}
                          {tablePageIdx * TEACHERS_PER_PAGE + 1}–
                          {Math.min(
                            (tablePageIdx + 1) * TEACHERS_PER_PAGE,
                            columns.length,
                          )}{" "}
                          of {columns.length}
                        </span>
                        <button
                          disabled={tablePageIdx === 0}
                          onClick={() => setTablePageIdx((p) => p - 1)}
                          className="px-3 py-1 rounded-lg bg-white border border-blue-300 text-blue-700 font-bold text-sm hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          ← Prev
                        </button>
                        <button
                          disabled={tablePageIdx >= totalPages - 1}
                          onClick={() => setTablePageIdx((p) => p + 1)}
                          className="px-3 py-1 rounded-lg bg-white border border-blue-300 text-blue-700 font-bold text-sm hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Next →
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Legend */}
                {/* <div className="mb-4 flex items-center gap-2 flex-wrap">
                  <span
                    style={{ fontSize: "13px" }}
                    className="bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-medium"
                  >
                    💡 <strong>Name (before,after)</strong> = free lectures before
                    and after break
                  </span>
                  <span
                    style={{ fontSize: "13px" }}
                    className="bg-yellow-50 text-yellow-700 px-3 py-1.5 rounded-full font-medium border border-yellow-200"
                  >
                    Break = After 5th period
                  </span>
                  <span
                    style={{ fontSize: "13px" }}
                    className="bg-green-50 text-green-700 px-3 py-1.5 rounded-full font-medium border border-green-200"
                  >
                    💾 Changes auto-save hote hain (2 sec baad)
                  </span>
                </div> */}

                {/* Table with paginated columns */}
                {(() => {
                  const visibleColumns = columns.slice(
                    tablePageIdx * TEACHERS_PER_PAGE,
                    (tablePageIdx + 1) * TEACHERS_PER_PAGE,
                  );
                  return (
                    <div className="overflow-x-auto">
                      <table
                        className="w-full border-collapse"
                        style={{ fontSize: "14px" }}
                      >
                        <thead>
                          <tr className="bg-white text-black">
                            <th
                              colSpan={3}
                              rowSpan={2}
                              className="border border-slate-700 px-3 py-3 text-center font-semibold uppercase align-middle"
                            >
                              Period / Time
                            </th>
                            <th
                              colSpan={visibleColumns.length}
                              className="border border-slate-700 px-3 py-2 text-center font-bold uppercase"
                              style={{ fontSize: "16px", letterSpacing: "3px" }}
                            >
                              TEACHERS ON LEAVE
                            </th>
                          </tr>
                          <tr className="bg-white text-black">
                            {visibleColumns.map((col) => (
                              <th
                                key={col.id}
                                className="border border-slate-700 px-3 py-2 min-w-[220px]"
                              >
                                <div className="flex items-center justify-between">
                                  <div className="text-left">
                                    <div
                                      style={{ fontSize: "14px" }}
                                      className="font-bold"
                                    >
                                      {col.selectedTeacher ||
                                        "— Select Teacher —"}
                                    </div>
                                    {col.selectedTeacher && (
                                      <div
                                        style={{
                                          fontSize: "11px",
                                          color: "#64748b",
                                        }}
                                      >
                                        {selectedDay}
                                      </div>
                                    )}
                                  </div>
                                  {columns.length > 1 && (
                                    <button
                                      onClick={() => removeColumn(col.id)}
                                      className="text-red-500 hover:text-red-700 ml-2 flex-shrink-0"
                                      style={{ fontSize: "18px" }}
                                    >
                                      ✕
                                    </button>
                                  )}
                                </div>
                              </th>
                            ))}
                          </tr>
                          <tr className="bg-blue-50">
                            <td
                              colSpan={3}
                              className="border border-slate-300 px-3 py-2 font-bold text-slate-700 text-center"
                              style={{ fontSize: "14px" }}
                            >
                              Absent Teacher
                            </td>
                            {visibleColumns.map((col) => (
                              <td
                                key={col.id}
                                className="border border-slate-300 px-2 py-2"
                              >
                                <select
                                  value={col.selectedTeacher}
                                  onChange={(e) =>
                                    handleTeacherSelect(col.id, e.target.value)
                                  }
                                  style={{ fontSize: "14px" }}
                                  className="w-full border-2 border-blue-400 rounded-lg px-2 py-2 bg-white text-blue-900 font-bold"
                                >
                                  <option value="">
                                    -- Select Absent Teacher --
                                  </option>
                                  {teachers.map((t) => (
                                    <option key={t.name} value={t.name}>
                                      {t.name}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  value={col.selectedTeacher}
                                  onChange={(e) =>
                                    handleTeacherSelect(col.id, e.target.value)
                                  }
                                  style={{ fontSize: "12px", marginTop: "6px" }}
                                  className="w-full border border-slate-300 rounded-md px-1 py-1 bg-slate-50 text-slate-700 focus:outline-none"
                                >
                                  <option value="">
                                    -- Manual Select (All with load) --
                                  </option>
                                  {teachers.map((t) => {
                                    const { before, after } =
                                      getFreePeriodCounts(
                                        t,
                                        selectedDay,
                                        PERIODS.length,
                                      );
                                    return (
                                      <option key={t.name} value={t.name}>
                                        {t.name} ({before},{after})
                                      </option>
                                    );
                                  })}
                                </select>
                              </td>
                            ))}
                          </tr>
                        </thead>

                        <tbody>
                          {PERIODS.map((period, pIdx) => (
                            <React.Fragment key={pIdx}>
                              {/* CLASS ROW */}
                              <tr>
                                <td
                                  rowSpan={3}
                                  className="border border-slate-300 text-center bg-white text-black font-bold px-1 py-2"
                                  style={{ width: "50px" }}
                                >
                                  <div
                                    style={{ fontSize: "15px" }}
                                    className="font-extrabold"
                                  >
                                    {period.label}
                                  </div>
                                </td>
                                <td
                                  rowSpan={3}
                                  className="border border-slate-300 text-center bg-white text-slate-600 px-1 py-2"
                                  style={{ width: "70px", fontSize: "11px" }}
                                >
                                  {period.time}
                                </td>
                                <td
                                  className="border border-slate-300 px-2 py-2 font-bold text-amber-800 uppercase bg-amber-50 whitespace-nowrap"
                                  style={{ fontSize: "13px", width: "70px" }}
                                >
                                  📚 Class
                                </td>
                                {visibleColumns.map((col) => {
                                  const classVal = col.classValues[pIdx] ?? "";
                                  const isFree =
                                    col.selectedTeacher &&
                                    (classVal.trim() === "" ||
                                      classVal.trim().toLowerCase() === "free");
                                  return (
                                    <td
                                      key={col.id}
                                      className="border border-slate-300 px-2 py-1"
                                    >
                                      {isFree ? (
                                        <div
                                          className="w-full text-center font-bold px-2 py-2 rounded-md bg-slate-100 text-slate-400 border-2 border-dashed border-slate-300"
                                          style={{ fontSize: "14px" }}
                                        >
                                          Free
                                        </div>
                                      ) : (
                                        <input
                                          type="text"
                                          value={classVal}
                                          onChange={(e) =>
                                            updateClassValue(
                                              col.id,
                                              pIdx,
                                              e.target.value,
                                            )
                                          }
                                          placeholder={
                                            col.selectedTeacher ? "" : "—"
                                          }
                                          style={{ fontSize: "15px" }}
                                          className={`w-full text-center font-extrabold px-2 py-2 rounded-md border-2 focus:outline-none ${classVal ? "bg-blue-50 border-blue-400 text-blue-900" : "bg-white border-slate-200 text-slate-300"}`}
                                        />
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>

                              {/* SUB ROW */}
                              <tr>
                                <td
                                  className="border border-slate-300 px-2 py-2 font-bold text-green-800 uppercase bg-green-50 whitespace-nowrap"
                                  style={{ fontSize: "13px" }}
                                >
                                  👤 Sub.
                                </td>
                                {visibleColumns.map((col) => {
                                  const classVal = col.classValues[pIdx] ?? "";
                                  const isFree = col.selectedTeacher
                                    ? classVal.trim() === "" ||
                                      classVal.trim().toLowerCase() === "free"
                                    : true;
                                  const avail = getAvailableSubstitutes(
                                    teachers,
                                    columns,
                                    col.id,
                                    pIdx,
                                    selectedDay,
                                    PERIODS.length,
                                  );
                                  const cur = col.substituteTeacher[pIdx] || "";
                                  const isValid =
                                    cur && avail.some((t) => t.name === cur);
                                  return (
                                    <td
                                      key={col.id}
                                      className="border border-slate-300 px-2 py-1"
                                    >
                                      {isFree || !col.selectedTeacher ? (
                                        <div
                                          className="w-full text-center text-slate-300 italic py-2"
                                          style={{ fontSize: "13px" }}
                                        >
                                          — Free —
                                        </div>
                                      ) : (
                                        <div>
                                          <select
                                            value={cur}
                                            onChange={(e) =>
                                              updateSubstitute(
                                                col.id,
                                                pIdx,
                                                e.target.value,
                                              )
                                            }
                                            style={{ fontSize: "13px" }}
                                            className={`w-full border rounded-md px-2 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-green-400 ${cur ? "border-green-400 bg-green-50 text-green-800 font-semibold" : "border-slate-300"}`}
                                          >
                                            <option value="">
                                              {avail.length === 0
                                                ? "⚠️ No free teacher"
                                                : `-- Select Sub (${avail.length} free) --`}
                                            </option>
                                            {cur && !isValid && (
                                              <option
                                                value={cur}
                                                style={{ color: "orange" }}
                                              >
                                                ⚠️ {cur} (now busy)
                                              </option>
                                            )}
                                            {avail.map((t) => (
                                              <option
                                                key={t.name}
                                                value={t.name}
                                              >
                                                {t.name} ({t.freeBefore},
                                                {t.freeAfter})
                                              </option>
                                            ))}
                                          </select>
                                          <select
                                            value={cur}
                                            onChange={(e) =>
                                              updateSubstitute(
                                                col.id,
                                                pIdx,
                                                e.target.value,
                                              )
                                            }
                                            style={{
                                              fontSize: "11px",
                                              marginTop: "4px",
                                            }}
                                            className="w-full border border-slate-300 rounded-md px-1 py-1 bg-slate-50 text-slate-600 focus:outline-none"
                                          >
                                            <option value="">
                                              -- Manual Select (All) --
                                            </option>
                                            {teachers.map((t) => {
                                              const { before, after } =
                                                getFreePeriodCounts(
                                                  t,
                                                  selectedDay,
                                                  PERIODS.length,
                                                );
                                              return (
                                                <option
                                                  key={t.name}
                                                  value={t.name}
                                                >
                                                  {t.name} ({before},{after})
                                                </option>
                                              );
                                            })}
                                          </select>
                                          <div className="mt-1 flex justify-between px-1">
                                            {avail.length === 0 ? (
                                              <span
                                                style={{ fontSize: "12px" }}
                                                className="text-red-500 font-semibold"
                                              >
                                                ⚠️ None free!
                                              </span>
                                            ) : (
                                              <span
                                                style={{ fontSize: "12px" }}
                                                className="text-green-600"
                                              >
                                                {avail.length} available
                                              </span>
                                            )}
                                            <span
                                              style={{ fontSize: "11px" }}
                                              className="text-slate-400"
                                            >
                                              (before,after)
                                            </span>
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>

                              {/* SIGN ROW */}
                              <tr>
                                <td
                                  className="border border-slate-300 px-2 py-2 font-bold text-purple-800 uppercase bg-purple-50 whitespace-nowrap"
                                  style={{ fontSize: "13px" }}
                                >
                                  ✍️ Sign
                                </td>
                                {visibleColumns.map((col) => {
                                  const cv = col.classValues[pIdx] ?? "";
                                  const isFree =
                                    cv.trim() === "" ||
                                    cv.trim().toLowerCase() === "free";
                                  return (
                                    <td
                                      key={col.id}
                                      className={`border border-slate-300 px-2 py-6 ${isFree ? "bg-slate-50" : ""}`}
                                    />
                                  );
                                })}
                              </tr>

                              {pIdx === BREAK_AFTER_IDX && (
                                <tr>
                                  <td
                                    colSpan={3 + visibleColumns.length}
                                    className="border border-yellow-400 text-center font-bold py-2"
                                    style={{
                                      background: "#fef9c3",
                                      color: "#854d0e",
                                      fontSize: "13px",
                                    }}
                                  >
                                    ━━━ MAJOR BREAK ({timings.majorBreak.start}{" "}
                                    – {timings.majorBreak.end}) ━━━
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          ))}
                        </tbody>

                        <tfoot>
                          <tr className="bg-slate-100">
                            <td
                              colSpan={3 + visibleColumns.length}
                              className="border border-slate-300 px-4 py-3 font-semibold text-slate-600"
                              style={{ fontSize: "14px" }}
                            >
                              <div className="flex justify-between">
                                <span>PRINCIPAL</span>
                                <span>TIME-TABLE ADJUSTMENT INCHARGE</span>
                              </div>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  );
                })()}

                {/* Save to Database Button */}
                <div className="mt-8 mb-4 flex flex-col items-center justify-center border-t border-slate-200 pt-6">
                  <button
                    onClick={() => handleSaveToDatabase(false)}
                    disabled={saveStatus === "saving"}
                    className="bg-emerald-600 text-white px-10 py-3 rounded-xl font-bold text-lg hover:bg-emerald-700 shadow-lg transform transition hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3"
                  >
                    {saveStatus === "saving" ? (
                      <>
                        <span className="animate-spin text-xl">⏳</span>
                        Saving to Database...
                      </>
                    ) : (
                      <>
                        <span className="text-xl">💾</span>
                        Save Adjustments to Database
                      </>
                    )}
                  </button>
                  {saveStatus === "saved" && (
                    <p className="text-green-600 font-bold mt-3 animate-pulse">
                      ✅ Data successfully saved!
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* RECORDS PAGE */}
        {currentPage === "records" && (
          <RecordsPage
            records={records}
            onDelete={handleDeleteRecord}
            onLoad={handleLoadRecord}
            onPrint={handlePrintRecord}
            onPrintAnalytics={handlePrintAnalyticReport}
            periods={PERIODS}
          />
        )}
      </div>
      <div
        id="print-area"
        style={{ position: "absolute", left: "-9999px", top: "-9999px" }}
      ></div>
    </div>
  );
}

// ── RECORDS PAGE COMPONENT (UPGRADED WITH DATE & LEADERBOARD) ─────────────────
function RecordsPage({
  records,
  onDelete,
  onLoad,
  onPrint,
  onPrintAnalytics,
  periods,
}: {
  records: AdjustmentRecord[];
  onDelete: (id: string) => void;
  onLoad: (record: AdjustmentRecord) => void;
  onPrint: (record: AdjustmentRecord) => void;
  onPrintAnalytics: (title: string, contentId: string) => void;
  periods: { label: string; time: string }[];
}) {
  const [filterView, setFilterView] = useState<
    "all" | "day" | "week" | "month"
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"list" | "stats">("list");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 1. Filter Logic
  const filteredRecords = useMemo(() => {
    return records.filter((record) => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !record.date.toLowerCase().includes(q) &&
          !record.day.toLowerCase().includes(q) &&
          !record.columns.some((c) =>
            c.selectedTeacher.toLowerCase().includes(q),
          )
        )
          return false;
      }
      if (filterView === "day") {
        const today = new Date().toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
        return record.date === today;
      }
      if (filterView === "week")
        return record.timestamp >= Date.now() - 7 * 24 * 60 * 60 * 1000;
      if (filterView === "month")
        return record.timestamp >= Date.now() - 30 * 24 * 60 * 60 * 1000;
      return true;
    });
  }, [records, filterView, searchQuery]);

  // 2. Stats Calculation for Top Header
  const totalTeachersAbsent = filteredRecords.reduce(
    (sum, r) => sum + r.totalTeachers,
    0,
  );
  const totalSubstitutions = filteredRecords.reduce(
    (sum, r) => sum + r.totalSubstitutes,
    0,
  );

  // 3. Detailed Stats for "Leaderboard"
  const substituteStats = useMemo(() => {
    const counts: Record<string, number> = {};
    filteredRecords.forEach((record) => {
      record.columns.forEach((col) => {
        col.substituteTeacher.forEach((sub) => {
          if (sub && sub.trim() !== "") {
            counts[sub.trim()] = (counts[sub.trim()] || 0) + 1;
          }
        });
      });
    });
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [filteredRecords]);

  const parseINDate = (dateString: string) => {
    const parts = dateString.split("/").map((p) => Number(p));
    if (parts.length !== 3) return null;
    return new Date(parts[2], parts[1] - 1, parts[0]);
  };

  const formatExportHeader = (dateString: string) => {
    const date = parseINDate(dateString);
    if (!date || Number.isNaN(date.getTime())) return dateString;
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = String(date.getFullYear()).slice(-2);
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
    }).format(date);
    return `${day}.${month}.${year} ${weekday}`;
  };

  const escapeCsv = (value: string | number) => {
    const str = String(value ?? "");
    if (/[,\n"]/g.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const handleExportMonthlyReport = () => {
    if (filteredRecords.length === 0) {
      alert("No records available to export.");
      return;
    }

    const uniqueDates = Array.from(
      new Set(filteredRecords.map((record) => record.date)),
    ).sort((a, b) => {
      const da = parseINDate(a);
      const db = parseINDate(b);
      if (!da || !db) return a.localeCompare(b);
      return da.getTime() - db.getTime();
    });

    // Is week (last 7 days) ke records — Load column ke liye
    const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weeklyRecords = records.filter((r) => r.timestamp >= weekStart);

    // Weekly load per teacher calculate karo
    const weeklyLoadByTeacher: Record<string, number> = {};
    weeklyRecords.forEach((record) => {
      record.columns.forEach((col) => {
        col.substituteTeacher.forEach((sub) => {
          const name = sub?.trim();
          if (!name) return;
          weeklyLoadByTeacher[name] = (weeklyLoadByTeacher[name] || 0) + 1;
        });
      });
    });

    const teacherNames = Array.from(
      filteredRecords.reduce((set, record) => {
        record.columns.forEach((col) => {
          col.substituteTeacher.forEach((sub) => {
            const name = sub?.trim();
            if (name) set.add(name);
          });
        });
        return set;
      }, new Set<string>()),
    ).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

    const countsByTeacher: Record<string, Record<string, number>> = {};
    teacherNames.forEach((name) => {
      countsByTeacher[name] = {};
      uniqueDates.forEach((date) => {
        countsByTeacher[name][date] = 0;
      });
    });

    filteredRecords.forEach((record) => {
      record.columns.forEach((col) => {
        col.substituteTeacher.forEach((sub) => {
          const name = sub?.trim();
          if (!name) return;
          countsByTeacher[name] = countsByTeacher[name] || {};
          countsByTeacher[name][record.date] =
            (countsByTeacher[name][record.date] || 0) + 1;
        });
      });
    });

    // Get week range label for header
    const weekEndDate = new Date();
    const weekStartDate = new Date(weekStart);
    const weekLabel = `Week Load (${weekStartDate.getDate()}/${weekStartDate.getMonth() + 1} - ${weekEndDate.getDate()}/${weekEndDate.getMonth() + 1})`;

    const headers = [
      "SR.No",
      "Name",
      weekLabel,
      ...uniqueDates.map(formatExportHeader),
      "Total",
    ];
    const rows = teacherNames.map((name, idx) => {
      const dailyCounts = uniqueDates.map(
        (date) => countsByTeacher[name][date] ?? 0,
      );
      const total = dailyCounts.reduce((sum, value) => sum + value, 0);
      // Load = is week ka total substitute count (all records se, sirf last 7 days)
      const weeklyLoad = weeklyLoadByTeacher[name] || 0;
      return [idx + 1, name, weeklyLoad, ...dailyCounts, total];
    });

    const csv = [headers, ...rows]
      .map((row) => row.map((value) => escapeCsv(value)).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute(
      "download",
      `Adjustment_Monthly_Report_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Stats Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl shadow-lg p-6 text-white">
        <h1 className="text-2xl font-bold mb-4">
          📋 Adjustment Records & Analytics
        </h1>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white/20 rounded-lg p-4 backdrop-blur">
            <div className="text-3xl font-bold">{filteredRecords.length}</div>
            <div className="text-sm opacity-90">Filtered Records</div>
          </div>
          <div className="bg-white/20 rounded-lg p-4 backdrop-blur">
            <div className="text-3xl font-bold">{totalTeachersAbsent}</div>
            <div className="text-sm opacity-90">Teachers Absent</div>
          </div>
          <div className="bg-white/20 rounded-lg p-4 backdrop-blur">
            <div className="text-3xl font-bold">{totalSubstitutions}</div>
            <div className="text-sm opacity-90">Total Adjustments Made</div>
          </div>
        </div>
        <div className="mt-4 flex gap-2 flex-wrap">
          <button
            onClick={() =>
              onPrintAnalytics(
                `Adjustment Report - ${filterView.toUpperCase()}`,
                activeTab === "list"
                  ? "analytics-list-content"
                  : "analytics-stats-content",
              )
            }
            className="bg-white text-blue-700 px-6 py-2 rounded-lg font-bold hover:bg-blue-50 transition flex items-center gap-2"
          >
            🖨️ Print Analytic Report (${filterView.toUpperCase()})
          </button>
          <button
            onClick={handleExportMonthlyReport}
            className="bg-emerald-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-emerald-700 transition flex items-center gap-2"
          >
            📥 Download Excel Report
          </button>
        </div>
      </div>

      {/* Filters + Search */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 flex-wrap">
            {(["all", "day", "week", "month"] as const).map((v) => {
              const labels = {
                all: "📅 All Time",
                day: "📆 Today",
                week: "📊 This Week",
                month: "📈 This Month",
              };
              const colors = {
                all: "bg-blue-600",
                day: "bg-green-600",
                week: "bg-orange-600",
                month: "bg-purple-600",
              };
              return (
                <button
                  key={v}
                  onClick={() => setFilterView(v)}
                  className={`px-4 py-2 rounded-lg font-semibold text-sm transition ${filterView === v ? `${colors[v]} text-white` : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
                >
                  {labels[v]}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder="🔍 Search date, teacher..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 min-w-[250px] border-2 border-slate-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
      </div>

      {/* Inner Tabs for View Switch */}
      <div className="flex gap-2 mb-2">
        <button
          onClick={() => setActiveTab("list")}
          className={`px-5 py-2 font-bold rounded-t-lg transition ${activeTab === "list" ? "bg-white text-blue-700 shadow-sm" : "bg-slate-200 text-slate-500 hover:bg-slate-300"}`}
        >
          📜 Record Details
        </button>
        <button
          onClick={() => setActiveTab("stats")}
          className={`px-5 py-2 font-bold rounded-t-lg transition ${activeTab === "stats" ? "bg-white text-blue-700 shadow-sm" : "bg-slate-200 text-slate-500 hover:bg-slate-300"}`}
        >
          🏆 Teacher Analytics (Leaderboard)
        </button>
      </div>

      {/* ── TAB 1: RECORD LIST WITH DETAILED TABLE ── */}
      {activeTab === "list" && (
        <div id="analytics-list-content">
          {filteredRecords.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
              <div className="text-6xl mb-4">📭</div>
              <h3 className="text-xl font-bold text-slate-700 mb-2">
                No Records Found
              </h3>
              <p className="text-slate-500">
                Update via the adjustment form, or change the filter.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredRecords.map((record) => (
                <div
                  key={record.id}
                  className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 transition hover:shadow-md"
                >
                  {/* Top Bar Summary */}
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-2xl">📋</span>
                        <div>
                          <h3 className="font-bold text-lg text-slate-900">
                            {record.date} — {record.day}
                          </h3>
                          <p className="text-sm text-slate-500">
                            Saved on{" "}
                            {new Date(record.timestamp).toLocaleString("en-IN")}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-3 text-sm">
                        <span className="bg-red-50 text-red-700 px-3 py-1 rounded-full font-semibold border border-red-200">
                          👤 {record.totalTeachers} Absent
                        </span>
                        <span className="bg-green-50 text-green-700 px-3 py-1 rounded-full font-semibold border border-green-200">
                          ✅ {record.totalSubstitutes} Adjusted
                        </span>
                      </div>
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() =>
                          setExpandedId(
                            expandedId === record.id ? null : record.id,
                          )
                        }
                        className="bg-purple-100 text-purple-700 border border-purple-300 px-4 py-2 rounded-lg text-sm font-bold hover:bg-purple-200 transition"
                      >
                        {expandedId === record.id
                          ? "🔼 Hide Details"
                          : "🔽 View Details"}
                      </button>
                      <button
                        onClick={() => onLoad(record)}
                        className="bg-blue-600  text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700  transition"
                      >
                        📥 Load
                      </button>
                      <button
                        onClick={() => onPrint(record)}
                        className="bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-slate-600 transition"
                      >
                        🖨️ Print
                      </button>
                      <button
                        onClick={() => onDelete(record.id || record.date)}
                        className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 transition"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>

                  {/* 🆕 DETAILED EXPANDED TABLE WITH DATE */}
                  {expandedId === record.id && (
                    <div className="mt-5 border-t-2 border-slate-100 pt-4">
                      <h4 className="font-bold text-slate-800 mb-3 text-sm uppercase tracking-wide">
                        Detailed Adjustments
                      </h4>

                      <div className="overflow-x-auto rounded-lg border border-slate-200">
                        <table className="w-full text-left text-sm border-collapse bg-white">
                          <thead className="bg-slate-800 text-white">
                            <tr>
                              <th className="p-3 border border-slate-700 w-[15%]">
                                📅 Date & Day
                              </th>
                              <th className="p-3 border border-slate-700 w-[20%]">
                                👤 Absent Teacher
                              </th>
                              <th className="p-3 border border-slate-700 w-[20%]">
                                ⏰ Period / Time
                              </th>
                              <th className="p-3 border border-slate-700 w-[15%]">
                                📚 Class
                              </th>
                              <th className="p-3 border border-slate-700">
                                ✅ Substituted By
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {record.columns.filter((c) => c.selectedTeacher)
                              .length === 0 ? (
                              <tr>
                                <td
                                  colSpan={5}
                                  className="p-4 text-center text-slate-500 italic"
                                >
                                  No absent teachers selected for this day.
                                </td>
                              </tr>
                            ) : (
                              record.columns
                                .filter((c) => c.selectedTeacher)
                                .map((col) => {
                                  const rowsForTeacher = periods
                                    .map((period, pIdx) => {
                                      const cv = col.classValues[pIdx];
                                      const sub = col.substituteTeacher[pIdx];
                                      const isFree =
                                        !cv ||
                                        cv.trim() === "" ||
                                        cv.trim().toLowerCase() === "free";

                                      if (isFree) return null;

                                      return (
                                        <tr
                                          key={`${col.id}-${pIdx}`}
                                          className="hover:bg-slate-50"
                                        >
                                          <td className="p-3 border border-slate-200">
                                            <div className="font-bold text-slate-800">
                                              {record.date}
                                            </div>
                                            <div className="text-xs text-slate-500">
                                              {record.day}
                                            </div>
                                          </td>

                                          <td className="p-3 border border-slate-200 font-bold text-red-700">
                                            {col.selectedTeacher}
                                          </td>
                                          <td className="p-3 border border-slate-200 text-slate-600">
                                            <strong>{period.label}</strong>{" "}
                                            <br />
                                            <span className="text-xs">
                                              {period.time}
                                            </span>
                                          </td>
                                          <td className="p-3 border border-slate-200 font-semibold text-blue-900 bg-blue-50">
                                            {cv}
                                          </td>
                                          <td className="p-3 border border-slate-200">
                                            {sub ? (
                                              <span className="bg-green-100 text-green-800 px-3 py-1 rounded-full font-bold border border-green-300 inline-block">
                                                {sub}
                                              </span>
                                            ) : (
                                              <span className="text-orange-500 italic font-semibold">
                                                ⚠️ Pending / No Sub
                                              </span>
                                            )}
                                          </td>
                                        </tr>
                                      );
                                    })
                                    .filter(Boolean);

                                  if (rowsForTeacher.length === 0) {
                                    return (
                                      <tr key={`empty-${col.id}`}>
                                        <td className="p-3 border border-slate-200">
                                          <div className="font-bold text-slate-800">
                                            {record.date}
                                          </div>
                                          <div className="text-xs text-slate-500">
                                            {record.day}
                                          </div>
                                        </td>
                                        <td className="p-3 border border-slate-200 font-bold text-red-700">
                                          {col.selectedTeacher}
                                        </td>
                                        <td
                                          colSpan={3}
                                          className="p-3 border border-slate-200 text-slate-500 italic text-center"
                                        >
                                          No assigned classes today (All free)
                                        </td>
                                      </tr>
                                    );
                                  }

                                  return rowsForTeacher;
                                })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB 2: TEACHER ANALYTICS / LEADERBOARD ── */}
      {activeTab === "stats" && (
        <div
          id="analytics-stats-content"
          className="bg-white rounded-xl shadow-sm border border-slate-200 p-6"
        >
          <div className="flex items-center justify-between mb-6 border-b pb-4">
            <div>
              <h2 className="text-xl font-bold text-slate-800">
                🏆 Substitute Teachers Leaderboard
              </h2>
              <p className="text-slate-500 text-sm">
                Based on currently selected filter:{" "}
                <strong className="text-blue-600 uppercase">
                  {filterView}
                </strong>
              </p>
            </div>
            <div className="bg-blue-50 text-blue-800 px-4 py-2 rounded-lg font-bold border border-blue-200">
              Total Adjusted Classes: {totalSubstitutions}
            </div>
          </div>

          {substituteStats.length === 0 ? (
            <div className="text-center py-10 text-slate-500 italic">
              No adjustments recorded for this period.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse rounded-lg overflow-hidden border border-slate-200">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="p-4 border-b border-slate-200 font-bold w-16 text-center">
                      Rank
                    </th>
                    <th className="p-4 border-b border-slate-200 font-bold">
                      Teacher Name
                    </th>
                    <th className="p-4 border-b border-slate-200 font-bold w-1/4 text-center">
                      Adjustments Taken
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {substituteStats.map((stat, idx) => {
                    let rankBadge = (
                      <span className="font-bold text-slate-500">
                        #{idx + 1}
                      </span>
                    );
                    let rowBg = "bg-white";

                    if (idx === 0) {
                      rankBadge = <span className="text-2xl">🥇</span>;
                      rowBg = "bg-yellow-50";
                    } else if (idx === 1) {
                      rankBadge = <span className="text-2xl">🥈</span>;
                      rowBg = "bg-slate-50";
                    } else if (idx === 2) {
                      rankBadge = <span className="text-2xl">🥉</span>;
                      rowBg = "bg-orange-50";
                    }

                    return (
                      <tr
                        key={stat.name}
                        className={`border-b border-slate-100 hover:bg-blue-50 transition ${rowBg}`}
                      >
                        <td className="p-4 text-center">{rankBadge}</td>
                        <td className="p-4 font-bold text-slate-800 text-lg">
                          {stat.name}
                        </td>
                        <td className="p-4 text-center">
                          <span className="bg-blue-100 text-blue-800 font-black px-4 py-1.5 rounded-full border border-blue-300">
                            {stat.count} Classes
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
