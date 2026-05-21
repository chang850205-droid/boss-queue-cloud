
import React, { useEffect, useMemo, useRef, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCe2KTRR-T7aFuKjVeZizyPRJ34jGw91BQ",
  authDomain: "cpa-office.firebaseapp.com",
  projectId: "cpa-office",
  storageBucket: "cpa-office.firebasestorage.app",
  messagingSenderId: "812656677185",
  appId: "1:812656677185:web:6d5f5a5e35fede088ad1c0",
  measurementId: "G-CXBWS22F6B",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const NS = "boss_queue_default";
const DEFAULT_PIN = "1234";

const meetingTypes = ["簽核文件", "工作回報", "請示決策", "財務/款項", "人事問題", "其他"];
const appointmentTypes = ["初次諮詢", "稅務諮詢", "帳務討論", "財務規劃", "簽約/合約", "其他"];
const urgencyMap = {
  normal: { label: "一般", priority: 2 },
  urgent: { label: "急件", priority: 1 },
  critical: { label: "非常急", priority: 0 },
};
const statusMap = { waiting: "等待中", serving: "洽談中", done: "已完成", skipped: "已跳過", cancelled: "已取消" };
const apptStatusMap = { pending: "待確認", confirmed: "已確認", completed: "已完成", cancelled: "已取消" };

const defaultSettings = {
  companyName: "張會預約",
  bossName: "老闆",
  announcement: "請留意目前叫號，輪到時請至老闆辦公室。",
  allowUrgentPriority: true,
  requireDepartment: false,
  maxWaitingDisplay: 8,
  adminPin: DEFAULT_PIN,
};

function todayKey(date = new Date()) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }).replaceAll("-", "");
}
function todayText(date = new Date()) {
  return date.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" });
}
function nowText() {
  return new Date().toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit" });
}
function num(value, fallback = 5) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function text(value, fallback = "") {
  return String(value ?? fallback).trim();
}
function uid() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
function colTickets() {
  return collection(db, "queueSystems", NS, "tickets");
}
function docTicket(id) {
  return doc(db, "queueSystems", NS, "tickets", id);
}
function docCounter(dateKey) {
  return doc(db, "queueSystems", NS, "counters", dateKey);
}
function docSettings() {
  return doc(db, "queueSystems", NS, "meta", "settings");
}
function colAppointments() {
  return collection(db, "queueSystems", NS, "appointments");
}
function docAppointment(id) {
  return doc(db, "queueSystems", NS, "appointments", id);
}
function normalizeTicket(item, index = 0) {
  return {
    id: String(item.id || `ticket-${index}`),
    ticketNo: String(item.ticketNo || `A${String(index + 1).padStart(3, "0")}`),
    name: text(item.name, "未命名") || "未命名",
    department: text(item.department, "未填部門") || "未填部門",
    phone: text(item.phone),
    type: meetingTypes.includes(item.type) ? item.type : "其他",
    urgency: urgencyMap[item.urgency] ? item.urgency : "normal",
    minutes: num(item.minutes, 5),
    note: text(item.note),
    status: ["waiting", "serving", "done", "skipped", "cancelled"].includes(item.status) ? item.status : "waiting",
    createdAt: Number(item.createdAt || Date.now()),
    updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
    dateKey: String(item.dateKey || todayKey()),
    createdTime: String(item.createdTime || nowText()),
    calledTime: item.calledTime || "",
    finishedTime: item.finishedTime || "",
    skippedTime: item.skippedTime || "",
    cancelledTime: item.cancelledTime || "",
  };
}
function normalizeAppointment(item, index = 0) {
  return {
    id: String(item.id || `appointment-${index}`),
    clientName: text(item.clientName, "未命名客戶") || "未命名客戶",
    phone: text(item.phone),
    email: text(item.email),
    type: appointmentTypes.includes(item.type) ? item.type : "其他",
    date: text(item.date),
    time: text(item.time),
    minutes: num(item.minutes, 30),
    note: text(item.note),
    status: ["pending", "confirmed", "completed", "cancelled"].includes(item.status) ? item.status : "pending",
    createdAt: Number(item.createdAt || Date.now()),
    updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
  };
}
function sortWaiting(tickets, allowPriority) {
  return tickets
    .filter((t) => t.status === "waiting")
    .sort((a, b) => {
      if (!allowPriority) return a.createdAt - b.createdAt;
      return (urgencyMap[a.urgency]?.priority ?? 2) - (urgencyMap[b.urgency]?.priority ?? 2) || a.createdAt - b.createdAt;
    });
}
function canNotify() {
  return typeof window !== "undefined" && "Notification" in window;
}
function notificationPermission() {
  return canNotify() ? Notification.permission : "unsupported";
}
async function askNotification() {
  if (!canNotify()) return "unsupported";
  if (Notification.permission === "default") return await Notification.requestPermission();
  return Notification.permission;
}
function beep() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 180);
  } catch {}
}
function calendarDates(date, time, minutes) {
  if (!date || !time) return "";
  const start = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(start.getTime())) return "";
  const end = new Date(start.getTime() + num(minutes, 30) * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/[.]\d{3}Z$/, "Z");
  return `${fmt(start)}/${fmt(end)}`;
}
function googleCalendarUrl(appt, settings) {
  const dates = calendarDates(appt.date, appt.time, appt.minutes);
  if (!dates) return "";
  const details = [
    `客戶：${appt.clientName}`,
    appt.phone ? `電話：${appt.phone}` : "",
    appt.email ? `Email：${appt.email}` : "",
    appt.note ? `備註：${appt.note}` : "",
  ].filter(Boolean).join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${appt.clientName}｜${appt.type}`,
    dates,
    details,
    location: `${settings.bossName}辦公室`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
function exportCsv(filename, header, rows) {
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const css = {
  page: { minHeight: "100vh", background: "linear-gradient(135deg,#f8fafc,#eef2ff)", padding: 24, color: "#0f172a", fontFamily: "Arial,'Microsoft JhengHei',sans-serif" },
  wrap: { maxWidth: 1240, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" },
  title: { fontSize: 34, fontWeight: 900, margin: 0 },
  muted: { color: "#64748b", lineHeight: 1.6 },
  nav: { display: "flex", gap: 8, flexWrap: "wrap" },
  btn: { border: "1px solid #cbd5e1", background: "white", color: "#0f172a", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  active: { border: "1px solid #0f172a", background: "#0f172a", color: "white", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  ok: { border: "1px solid #16a34a", background: "#16a34a", color: "white", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  danger: { border: "1px solid #dc2626", background: "#dc2626", color: "white", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  disabled: { opacity: 0.45, cursor: "not-allowed" },
  card: { background: "rgba(255,255,255,.95)", border: "1px solid #e2e8f0", borderRadius: 22, padding: 20, boxShadow: "0 8px 24px rgba(15,23,42,.06)" },
  section: { marginTop: 24 },
  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginTop: 24 },
  stat: { fontSize: 28, fontWeight: 900, marginTop: 4 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 14 },
  fieldLabel: { fontSize: 13, color: "#475569", fontWeight: 800, marginBottom: 6 },
  input: { width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 14, padding: "12px 14px", fontSize: 15, background: "white" },
  board: { display: "grid", gridTemplateColumns: "minmax(280px,1fr) minmax(340px,2fr)", gap: 18, marginTop: 24 },
  currentNo: { fontSize: 86, fontWeight: 900, letterSpacing: 3, margin: "18px 0", lineHeight: 1 },
  ticket: { background: "white", border: "1px solid #e2e8f0", borderRadius: 18, padding: 16, marginBottom: 10 },
  ticketNo: { fontSize: 30, fontWeight: 900, letterSpacing: 1 },
  badge: { display: "inline-block", borderRadius: 999, padding: "5px 9px", fontSize: 13, fontWeight: 900, background: "#e2e8f0" },
  note: { background: "#f8fafc", color: "#475569", borderRadius: 12, padding: 10, marginTop: 10, fontSize: 14, lineHeight: 1.5 },
  statusOk: { background: "#dcfce7", border: "1px solid #86efac", color: "#166534", borderRadius: 16, padding: 12, marginTop: 12 },
  statusBad: { background: "#fee2e2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 16, padding: 12, marginTop: 12 },
  toast: { position: "fixed", right: 20, bottom: 20, zIndex: 9999, background: "#0f172a", color: "white", borderRadius: 18, padding: "14px 16px", boxShadow: "0 16px 40px rgba(15,23,42,.28)", maxWidth: 360, lineHeight: 1.5 },
  table: { width: "100%", borderCollapse: "collapse", background: "white" },
  th: { textAlign: "left", padding: 12, background: "#f1f5f9" },
  td: { padding: 12, borderTop: "1px solid #e2e8f0" },
};

function Button({ children, active, success, danger, disabled, onClick }) {
  const style = danger ? css.danger : success ? css.ok : active ? css.active : css.btn;
  return <button style={{ ...style, ...(disabled ? css.disabled : {}) }} disabled={disabled} onClick={onClick}>{children}</button>;
}
function Field({ label, children }) {
  return <div><div style={css.fieldLabel}>{label}</div>{children}</div>;
}
function Input({ value, setValue, placeholder, type = "text" }) {
  return <input type={type} style={css.input} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />;
}
function TextArea({ value, setValue, placeholder }) {
  return <textarea style={{ ...css.input, minHeight: 86, resize: "vertical" }} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />;
}
function Select({ value, setValue, children }) {
  return <select style={css.input} value={value} onChange={(e) => setValue(e.target.value)}>{children}</select>;
}
function Stat({ label, value }) {
  return <div style={css.card}><div style={css.muted}>{label}</div><div style={css.stat}>{value}</div></div>;
}
function TicketCard({ item, index, action, compact = false }) {
  return (
    <div style={css.ticket}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={css.ticketNo}>{item.ticketNo}</span>
            <span style={css.badge}>{urgencyMap[item.urgency]?.label || "一般"}</span>
            <span style={css.badge}>{statusMap[item.status] || item.status}</span>
          </div>
          <div style={{ marginTop: 5, fontWeight: 900 }}>{item.name}｜{item.department}</div>
          <div style={{ ...css.muted, fontSize: 14, marginTop: 4 }}>{item.type}・預估 {item.minutes} 分鐘・取號 {item.createdTime}</div>
          {!compact && item.phone ? <div style={{ ...css.muted, fontSize: 14, marginTop: 4 }}>手機：{item.phone}</div> : null}
          {!compact && item.note ? <div style={css.note}>{item.note}</div> : null}
        </div>
        {typeof index === "number" ? <div style={{ textAlign: "right", ...css.muted }}>順位<br /><b style={{ color: "#0f172a", fontSize: 22 }}>{index + 1}</b></div> : null}
      </div>
      {action ? <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>{action}</div> : null}
    </div>
  );
}
function AppointmentCard({ item, settings, onUpdate }) {
  return (
    <div style={css.ticket}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={css.ticketNo}>{item.date} {item.time}</span>
        <span style={css.badge}>{apptStatusMap[item.status] || item.status}</span>
      </div>
      <div style={{ marginTop: 5, fontWeight: 900 }}>{item.clientName}｜{item.type}</div>
      <div style={{ ...css.muted, fontSize: 14, marginTop: 4 }}>{item.minutes} 分鐘｜{item.phone || "未填電話"}｜{item.email || "未填 Email"}</div>
      {item.note ? <div style={css.note}>{item.note}</div> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <Button success onClick={() => onUpdate(item.id, { status: "confirmed" })}>確認</Button>
        <Button onClick={() => window.open(googleCalendarUrl(item, settings), "_blank")}>加入 Google 行事曆</Button>
        <Button onClick={() => onUpdate(item.id, { status: "completed" })}>完成</Button>
        <Button danger onClick={() => onUpdate(item.id, { status: "cancelled" })}>取消</Button>
      </div>
    </div>
  );
}
function PinGate({ settings, onUnlock }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  return (
    <section style={{ ...css.card, ...css.section, maxWidth: 520 }}>
      <h2 style={{ marginTop: 0 }}>管理者登入</h2>
      <p style={css.muted}>老闆後台、紀錄、預約管理與系統設定需要輸入管理密碼。</p>
      <Field label="管理密碼"><Input type="password" value={pin} setValue={setPin} placeholder="請輸入管理密碼" /></Field>
      {error ? <div style={{ color: "#dc2626", marginTop: 10 }}>{error}</div> : null}
      <div style={{ marginTop: 14 }}><Button active onClick={() => pin === String(settings.adminPin || DEFAULT_PIN) ? onUnlock() : setError("密碼錯誤，預設是 1234。")}>登入</Button></div>
    </section>
  );
}

export default function App() {
  const [settings, setSettings] = useState(defaultSettings);
  const [tickets, setTickets] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [view, setView] = useState("staff");
  const [unlocked, setUnlocked] = useState(false);
  const [syncStatus, setSyncStatus] = useState("checking");
  const [errorMessage, setErrorMessage] = useState("");
  const [toast, setToast] = useState("");
  const [permission, setPermission] = useState(notificationPermission());
  const seenTickets = useRef(new Set());
  const lastServing = useRef("");
  const lastIdleNotify = useRef(0);

  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [phone, setPhone] = useState("");
  const [type, setType] = useState("簽核文件");
  const [urgency, setUrgency] = useState("normal");
  const [minutes, setMinutes] = useState("5");
  const [note, setNote] = useState("");
  const [lastTicket, setLastTicket] = useState(null);

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [apptType, setApptType] = useState("初次諮詢");
  const [apptDate, setApptDate] = useState("");
  const [apptTime, setApptTime] = useState("");
  const [apptMinutes, setApptMinutes] = useState("30");
  const [apptNote, setApptNote] = useState("");
  const [lastAppointment, setLastAppointment] = useState(null);

  const [newPin, setNewPin] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

  function notify(title, body) {
    setToast(`${title}：${body}`);
    setTimeout(() => setToast(""), 5000);
    if (canNotify() && Notification.permission === "granted") {
      try { new Notification(title, { body }); } catch {}
    }
    beep();
  }
  async function enableNotifications() {
    const p = await askNotification();
    setPermission(p);
    if (p === "granted") notify("通知已啟用", "有人取號、叫號或新增預約時，這台裝置會提醒。");
    else alert("通知未啟用，仍會顯示右下角畫面提醒。");
  }

  useEffect(() => {
    const today = todayKey();
    const unsubTickets = onSnapshot(query(colTickets(), where("dateKey", "==", today)), (snap) => {
      const rows = snap.docs.map((d, i) => normalizeTicket({ id: d.id, ...d.data() }, i));
      if (seenTickets.current.size > 0) {
        rows.filter((t) => !seenTickets.current.has(t.id) && t.status === "waiting")
          .forEach((t) => notify("有人取號了", `${t.ticketNo}｜${t.name}｜${t.type}`));
      }
      seenTickets.current = new Set(rows.map((t) => t.id));
      setTickets(rows);
      setSyncStatus("online");
      setErrorMessage("");
    }, (err) => {
      setSyncStatus("error");
      setErrorMessage(err.message);
    });

    const unsubSettings = onSnapshot(docSettings(), async (snap) => {
      if (snap.exists()) setSettings({ ...defaultSettings, ...snap.data() });
      else await setDoc(docSettings(), defaultSettings, { merge: true });
    });

    const unsubAppts = onSnapshot(colAppointments(), (snap) => {
      setAppointments(snap.docs.map((d, i) => normalizeAppointment({ id: d.id, ...d.data() }, i)));
    });

    return () => {
      unsubTickets();
      unsubSettings();
      unsubAppts();
    };
  }, []);

  const todayTickets = useMemo(() => tickets.filter((t) => t.dateKey === todayKey()), [tickets]);
  const waiting = useMemo(() => sortWaiting(todayTickets, settings.allowUrgentPriority), [todayTickets, settings.allowUrgentPriority]);
  const serving = useMemo(() => todayTickets.find((t) => t.status === "serving"), [todayTickets]);
  const done = useMemo(() => todayTickets.filter((t) => t.status === "done"), [todayTickets]);
  const skipped = useMemo(() => todayTickets.filter((t) => t.status === "skipped"), [todayTickets]);
  const cancelled = useMemo(() => todayTickets.filter((t) => t.status === "cancelled"), [todayTickets]);
  const totalWaitingMinutes = waiting.reduce((sum, t) => sum + num(t.minutes, 5), 0);
  const upcomingAppointments = useMemo(() => {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
    return appointments.filter((a) => a.date >= today && a.status !== "cancelled");
  }, [appointments]);

  useEffect(() => {

  const timer = setInterval(() => {

    if (waiting.length === 0) return;

    const oldest = waiting[0];

    const waitingMinutes = Math.floor(
      (Date.now() - oldest.createdAt) / 60000
    );

    // 避免每分鐘一直跳
    if (
      waitingMinutes >= 10 &&
      waitingMinutes > lastIdleNotify.current
    ) {

      lastIdleNotify.current = waitingMinutes;

      notify(
        "⏰ 老闆提醒",
        `目前 ${waiting.length} 人等待，最久已等 ${waitingMinutes} 分鐘`
      );

    }

  },60000);

  return () => clearInterval(timer);

},[waiting]);

  async function addTicket() {
    if (!name.trim()) return alert("請填寫姓名");
    if (settings.requireDepartment && !department.trim()) return alert("請填寫部門");
    const dateKey = todayKey();
    const createdAt = Date.now();
    const id = uid();
    let item = null;
    try {
      await runTransaction(db, async (tx) => {
        const counterRef = docCounter(dateKey);
        const counterSnap = await tx.get(counterRef);
        const next = (counterSnap.exists() ? num(counterSnap.data().count, 0) : 0) + 1;
        item = {
          id,
          ticketNo: `A${String(next).padStart(3, "0")}`,
          name: name.trim(),
          department: department.trim() || "未填部門",
          phone: phone.trim(),
          type,
          urgency,
          minutes: num(minutes, 5),
          note: note.trim(),
          status: "waiting",
          createdAt,
          updatedAt: createdAt,
          dateKey,
          createdTime: nowText(),
        };
        tx.set(counterRef, { count: next, updatedAt: createdAt, dateKey }, { merge: true });
        tx.set(docTicket(id), clean(item));
      });
      setLastTicket(item);
      setName(""); setDepartment(""); setPhone(""); setType("簽核文件"); setUrgency("normal"); setMinutes("5"); setNote("");
      setView("ticketDone");
    } catch (err) {
      alert(`取號失敗：${err.message}`);
    }
  }

  async function addAppointment() {
    if (!clientName.trim()) return alert("請填寫客戶姓名");
    if (!apptDate || !apptTime) return alert("請選擇預約日期與時間");
    const conflict = appointments.some((a) => a.date === apptDate && a.time === apptTime && a.status !== "cancelled");
    if (conflict && !window.confirm("這個時段已經有人預約，確定仍要新增嗎？")) return;
    const createdAt = Date.now();
    const id = uid();
    const item = {
      id,
      clientName: clientName.trim(),
      phone: clientPhone.trim(),
      email: clientEmail.trim(),
      type: apptType,
      date: apptDate,
      time: apptTime,
      minutes: num(apptMinutes, 30),
      note: apptNote.trim(),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    try {
      await setDoc(docAppointment(id), clean(item));
      setLastAppointment(item);
      setClientName(""); setClientPhone(""); setClientEmail(""); setApptType("初次諮詢"); setApptDate(""); setApptTime(""); setApptMinutes("30"); setApptNote("");
      setView("appointmentDone");
      notify("新增客戶預約", `${item.clientName}｜${item.date} ${item.time}｜${item.type}`);
    } catch (err) {
      alert(`新增預約失敗：${err.message}`);
    }
  }

  async function updateTicket(id, patch) {
    try { await updateDoc(docTicket(id), clean({ ...patch, updatedAt: Date.now() })); }
    catch (err) { alert(`更新失敗：${err.message}`); }
  }
  async function updateAppointment(id, patch) {
    try { await updateDoc(docAppointment(id), clean({ ...patch, updatedAt: Date.now() })); }
    catch (err) { alert(`更新預約失敗：${err.message}`); }
  }
  async function callNext() {
    const next = waiting[0];
    if (!next) return;
    try {
      if (serving) await updateDoc(docTicket(serving.id), clean({ status: "done", finishedTime: nowText(), updatedAt: Date.now() }));
      await updateDoc(docTicket(next.id), clean({ status: "serving", calledTime: nowText(), updatedAt: Date.now() }));
      setView("display");
    } catch (err) {
      alert(`叫號失敗：${err.message}`);
    }
  }
  async function resetToday() {
    if (!window.confirm("確定清空今日排隊資料？")) return;
    const snap = await getDocs(query(colTickets(), where("dateKey", "==", todayKey())));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    await setDoc(docCounter(todayKey()), { count: 0, dateKey: todayKey(), updatedAt: Date.now() }, { merge: true });
    seenTickets.current = new Set();
    lastServing.current = "";
  }
  async function saveSettingsPatch(patch) {
    const next = { ...settings, ...patch };
    setSettings(next);
    await setDoc(docSettings(), clean(next), { merge: true });
  }
  async function copyUrl() {
    const url = window.location.href;
    const ok = await (async () => {
      try { await navigator.clipboard.writeText(url); return true; } catch { return false; }
    })();
    setCopyMessage(ok ? "已複製系統網址。" : "瀏覽器阻擋自動複製，請手動複製下方網址。");
    setManualUrl(ok ? "" : url);
  }
  function exportTickets() {
    exportCsv(`meeting-queue-${todayKey()}.csv`,
      ["號碼", "姓名", "部門", "手機", "類型", "狀態", "取號", "叫號", "結束", "備註"],
      todayTickets.map((t) => [t.ticketNo, t.name, t.department, t.phone, t.type, statusMap[t.status], t.createdTime, t.calledTime, t.finishedTime || t.skippedTime || t.cancelledTime, t.note]));
  }
  function exportAppointments() {
    exportCsv(`appointments-${todayKey()}.csv`,
      ["日期", "時間", "客戶", "電話", "Email", "類型", "分鐘", "狀態", "備註"],
      upcomingAppointments.map((a) => [a.date, a.time, a.clientName, a.phone, a.email, a.type, a.minutes, apptStatusMap[a.status], a.note]));
  }
  async function saveNewPin() {
    if (!newPin.trim() || newPin.trim().length < 4) return alert("密碼至少 4 碼");
    await saveSettingsPatch({ adminPin: newPin.trim() });
    setNewPin("");
    alert("管理密碼已更新");
  }

  const needsPin = ["boss", "records", "settings", "appointments"].includes(view) && !unlocked;
  const syncText = syncStatus === "online" ? "雲端同步中" : syncStatus === "checking" ? "檢查連線中" : "雲端連線異常";

  return (
    <main style={css.page}>
      <div style={css.wrap}>
        <header style={css.header}>
          <div>
            <h1 style={css.title}>{settings.companyName}</h1>
            <div style={css.muted}>{todayText()}｜{settings.bossName}會議排隊叫號<br />{settings.announcement}</div>
          </div>
          <nav style={css.nav}>
            <Button active={view === "staff"} onClick={() => setView("staff")}>員工取號</Button>
            <Button active={view === "display"} onClick={() => setView("display")}>叫號看板</Button>
            <Button active={view === "booking"} onClick={() => setView("booking")}>客戶預約</Button>
            <Button active={view === "boss"} onClick={() => setView("boss")}>老闆端</Button>
            <Button active={view === "appointments"} onClick={() => setView("appointments")}>預約管理</Button>
            <Button active={view === "records"} onClick={() => setView("records")}>紀錄</Button>
            <Button active={view === "settings"} onClick={() => setView("settings")}>設定</Button>
            <Button onClick={enableNotifications}>{permission === "granted" ? "通知已開" : "啟用通知"}</Button>
          </nav>
        </header>

        <div style={syncStatus === "online" ? css.statusOk : css.statusBad}>
          <b>{syncText}</b>{errorMessage ? `｜${errorMessage}` : ""}
        </div>
        {permission !== "granted" ? <div style={{ ...css.note, background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412" }}>提醒：要收到取號、叫號或預約通知，請按右上方「啟用通知」。</div> : null}

        <section style={css.stats}>
          <Stat label="等待人數" value={waiting.length} />
          <Stat label="目前叫號" value={serving?.ticketNo || "—"} />
          <Stat label="估計等待" value={`${totalWaitingMinutes}分`} />
          <Stat label="今日完成" value={done.length} />
          <Stat label="跳過/取消" value={skipped.length + cancelled.length} />
          <Stat label="未來預約" value={upcomingAppointments.length} />
        </section>

        {needsPin ? <PinGate settings={settings} onUnlock={() => setUnlocked(true)} /> : null}

        {!needsPin && view === "staff" ? (
          <section style={{ ...css.card, ...css.section }}>
            <h2 style={{ marginTop: 0 }}>員工取號</h2>
            <p style={css.muted}>請填寫基本資料，系統會自動產生號碼。取號後請留意叫號看板。</p>
            <div style={css.grid}>
              <Field label="姓名 *"><Input value={name} setValue={setName} placeholder="例如：王小明" /></Field>
              <Field label={settings.requireDepartment ? "部門 *" : "部門"}><Input value={department} setValue={setDepartment} placeholder="例如：財務部" /></Field>
              <Field label="手機/分機"><Input value={phone} setValue={setPhone} placeholder="可填手機或公司分機" /></Field>
              <Field label="會議類型"><Select value={type} setValue={setType}>{meetingTypes.map((x) => <option key={x} value={x}>{x}</option>)}</Select></Field>
              <Field label="緊急程度"><Select value={urgency} setValue={setUrgency}><option value="normal">一般</option><option value="urgent">急件</option><option value="critical">非常急</option></Select></Field>
              <Field label="預估時間"><Select value={minutes} setValue={setMinutes}><option value="5">5 分鐘</option><option value="10">10 分鐘</option><option value="15">15 分鐘</option><option value="30">30 分鐘</option><option value="60">60 分鐘</option></Select></Field>
            </div>
            <div style={{ marginTop: 14 }}><Field label="簡短說明"><TextArea value={note} setValue={setNote} placeholder="例如：請老闆核准付款單" /></Field></div>
            <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button success onClick={addTicket}>取號排隊</Button>
              <Button onClick={copyUrl}>複製取號網址</Button>
            </div>
            {copyMessage ? <div style={css.note}><b>{copyMessage}</b>{manualUrl ? <input style={{ ...css.input, marginTop: 8 }} readOnly value={manualUrl} onFocus={(e) => e.target.select()} /> : null}</div> : null}
          </section>
        ) : null}

        {!needsPin && view === "booking" ? (
          <section style={{ ...css.card, ...css.section }}>
            <h2 style={{ marginTop: 0 }}>幫客戶預約老闆行事曆</h2>
            <p style={css.muted}>行政或櫃台可在這裡幫客戶建立預約。若同時段已有人預約，會先跳出警告，但可繼續建立。</p>
            <div style={css.grid}>
              <Field label="客戶姓名 *"><Input value={clientName} setValue={setClientName} placeholder="例如：王先生" /></Field>
              <Field label="電話"><Input value={clientPhone} setValue={setClientPhone} placeholder="客戶手機或公司電話" /></Field>
              <Field label="Email"><Input value={clientEmail} setValue={setClientEmail} placeholder="可選填" /></Field>
              <Field label="預約類型"><Select value={apptType} setValue={setApptType}>{appointmentTypes.map((x) => <option key={x} value={x}>{x}</option>)}</Select></Field>
              <Field label="預約日期 *"><Input type="date" value={apptDate} setValue={setApptDate} /></Field>
              <Field label="預約時間 *"><Input type="time" value={apptTime} setValue={setApptTime} /></Field>
              <Field label="預估時間"><Select value={apptMinutes} setValue={setApptMinutes}><option value="30">30 分鐘</option><option value="45">45 分鐘</option><option value="60">60 分鐘</option><option value="90">90 分鐘</option></Select></Field>
            </div>
            <div style={{ marginTop: 14 }}><Field label="備註"><TextArea value={apptNote} setValue={setApptNote} placeholder="例如：想討論遺產稅、公司帳務、年度申報等" /></Field></div>
            <div style={{ marginTop: 16 }}><Button success onClick={addAppointment}>建立預約</Button></div>
          </section>
        ) : null}

        {!needsPin && view === "appointmentDone" && lastAppointment ? (
          <section style={{ ...css.card, ...css.section, textAlign: "center" }}>
            <h2 style={{ marginTop: 0 }}>預約已建立</h2>
            <div style={{ fontSize: 32, fontWeight: 900 }}>{lastAppointment.clientName}</div>
            <p style={css.muted}>{lastAppointment.date} {lastAppointment.time}｜{lastAppointment.type}｜{lastAppointment.minutes} 分鐘</p>
            <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
              <Button active onClick={() => window.open(googleCalendarUrl(lastAppointment, settings), "_blank")}>加入 Google 行事曆</Button>
              <Button onClick={() => setView("booking")}>繼續預約</Button>
              <Button onClick={() => setView("appointments")}>查看預約管理</Button>
            </div>
          </section>
        ) : null}

        {!needsPin && view === "ticketDone" && lastTicket ? (
          <section style={{ ...css.card, ...css.section, textAlign: "center" }}>
            <h2 style={{ marginTop: 0 }}>取號成功</h2>
            <div style={{ ...css.currentNo, color: "#16a34a" }}>{lastTicket.ticketNo}</div>
            <div style={{ fontSize: 22, fontWeight: 900 }}>{lastTicket.name}｜{lastTicket.department}</div>
            <p style={css.muted}>請留意叫號看板，輪到您時請前往{settings.bossName}辦公室。</p>
            <Button active onClick={() => setView("display")}>查看叫號看板</Button>
          </section>
        ) : null}

        {!needsPin && view === "display" ? (
          <section style={css.board}>
            <div style={{ ...css.card, textAlign: "center" }}>
              <div style={{ ...css.muted, fontSize: 18 }}>目前輪到</div>
              <div style={css.currentNo}>{serving?.ticketNo || "—"}</div>
              <div style={{ fontSize: 24, fontWeight: 900 }}>{serving ? `${serving.name}｜${serving.department}` : "尚未叫號"}</div>
              <div style={{ ...css.muted, marginTop: 8 }}>{serving?.type || "請等待叫號"}</div>
              {serving?.note ? <div style={{ ...css.note, textAlign: "left" }}>{serving.note}</div> : null}
            </div>
            <div>
              <h2 style={{ marginTop: 0 }}>等待名單</h2>
              {waiting.length === 0 ? <div style={css.card}>目前沒有人等待。</div> : waiting.slice(0, settings.maxWaitingDisplay).map((item, index) => <TicketCard key={item.id} item={item} index={index} compact />)}
            </div>
          </section>
        ) : null}

        {!needsPin && view === "boss" ? (
          <section style={css.board}>
            <div style={css.card}>
              <h2 style={{ marginTop: 0 }}>老闆操作區</h2>
              <div style={{ background: "#f1f5f9", borderRadius: 18, padding: 16, marginBottom: 14 }}>
                <div style={css.muted}>目前處理</div>
                <div style={{ fontSize: 46, fontWeight: 900, marginTop: 8 }}>{serving?.ticketNo || "—"}</div>
                <div style={{ fontWeight: 900, marginTop: 8 }}>{serving ? `${serving.name}｜${serving.department}` : "尚未叫號"}</div>
                {serving?.note ? <div style={css.note}>{serving.note}</div> : null}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                <Button success onClick={callNext} disabled={waiting.length === 0}>叫下一位</Button>
                <Button onClick={() => serving && updateTicket(serving.id, { status: "done", finishedTime: nowText() })} disabled={!serving}>完成目前會議</Button>
                <Button onClick={() => serving && updateTicket(serving.id, { status: "skipped", skippedTime: nowText() })} disabled={!serving}>跳過目前號碼</Button>
                <Button danger onClick={resetToday}>清空今日資料</Button>
              </div>
            </div>
            <div>
              <h2 style={{ marginTop: 0 }}>待叫號</h2>
              {waiting.length === 0 ? <div style={css.card}>沒有待叫號。</div> : waiting.map((item, index) => (
                <TicketCard key={item.id} item={item} index={index} action={
                  <>
                    <Button onClick={() => updateTicket(item.id, { status: "serving", calledTime: nowText() })}>直接叫號</Button>
                    <Button danger onClick={() => updateTicket(item.id, { status: "cancelled", cancelledTime: nowText() })}>取消</Button>
                  </>
                } />
              ))}
              {skipped.length > 0 ? <div style={{ marginTop: 22 }}><h2>已跳過，可重新排入</h2>{skipped.map((item) => <TicketCard key={item.id} item={item} action={<Button onClick={() => updateTicket(item.id, { status: "waiting", createdAt: Date.now() })}>重新排入</Button>} />)}</div> : null}
            </div>
          </section>
        ) : null}

        {!needsPin && view === "appointments" ? (
          <section style={{ ...css.card, ...css.section }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <div><h2 style={{ margin: 0 }}>客戶預約管理</h2><p style={css.muted}>確認/取消預約，並可加入 Google 行事曆。</p></div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button onClick={() => setView("booking")}>新增客戶預約</Button>
                <Button active onClick={() => exportCsv(`appointments-${todayKey()}.csv`, ["日期", "時間", "客戶", "電話", "Email", "類型", "分鐘", "狀態", "備註"], upcomingAppointments.map((a) => [a.date, a.time, a.clientName, a.phone, a.email, a.type, a.minutes, apptStatusMap[a.status], a.note]))}>匯出預約 CSV</Button>
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              {upcomingAppointments.length === 0 ? <div style={css.card}>目前沒有未來預約。</div> : upcomingAppointments.map((item) => <AppointmentCard key={item.id} item={item} settings={settings} onUpdate={updateAppointment} />)}
            </div>
          </section>
        ) : null}

        {!needsPin && view === "records" ? (
          <section style={{ ...css.card, ...css.section }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <div><h2 style={{ margin: 0 }}>今日紀錄</h2><p style={css.muted}>可匯出 CSV 給行政或主管留存。</p></div>
              <Button active onClick={exportTickets}>匯出今日 CSV</Button>
            </div>
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={css.table}>
                <thead><tr><th style={css.th}>號碼</th><th style={css.th}>姓名</th><th style={css.th}>部門</th><th style={css.th}>類型</th><th style={css.th}>狀態</th><th style={css.th}>取號</th><th style={css.th}>叫號</th><th style={css.th}>結束</th></tr></thead>
                <tbody>{todayTickets.length === 0 ? <tr><td style={css.td} colSpan="8">今日尚無紀錄。</td></tr> : todayTickets.map((item) => <tr key={item.id}><td style={css.td}>{item.ticketNo}</td><td style={css.td}>{item.name}</td><td style={css.td}>{item.department}</td><td style={css.td}>{item.type}</td><td style={css.td}>{statusMap[item.status]}</td><td style={css.td}>{item.createdTime}</td><td style={css.td}>{item.calledTime}</td><td style={css.td}>{item.finishedTime || item.skippedTime || item.cancelledTime}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        ) : null}

        {!needsPin && view === "settings" ? (
          <section style={{ ...css.card, ...css.section }}>
            <h2 style={{ marginTop: 0 }}>系統設定</h2>
            <div style={css.grid}>
              <Field label="系統名稱"><Input value={settings.companyName} setValue={(v) => saveSettingsPatch({ companyName: v })} /></Field>
              <Field label="主管稱呼"><Input value={settings.bossName} setValue={(v) => saveSettingsPatch({ bossName: v })} /></Field>
              <Field label="看板顯示等待筆數"><Input type="number" value={String(settings.maxWaitingDisplay)} setValue={(v) => saveSettingsPatch({ maxWaitingDisplay: num(v, 8) })} /></Field>
              <Field label="管理密碼"><Input type="password" value={newPin} setValue={setNewPin} placeholder="輸入新密碼，至少 4 碼" /></Field>
            </div>
            <div style={{ marginTop: 14 }}><Field label="公告文字"><TextArea value={settings.announcement} setValue={(v) => saveSettingsPatch({ announcement: v })} /></Field></div>
            <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ fontWeight: 800 }}><input type="checkbox" checked={settings.allowUrgentPriority} onChange={(e) => saveSettingsPatch({ allowUrgentPriority: e.target.checked })} /> 急件優先排序</label>
              <label style={{ fontWeight: 800 }}><input type="checkbox" checked={settings.requireDepartment} onChange={(e) => saveSettingsPatch({ requireDepartment: e.target.checked })} /> 部門必填</label>
              <Button onClick={saveNewPin}>更新管理密碼</Button>
              <Button onClick={copyUrl}>複製系統網址</Button>
            </div>
            {copyMessage ? <div style={css.note}><b>{copyMessage}</b>{manualUrl ? <input style={{ ...css.input, marginTop: 8 }} readOnly value={manualUrl} onFocus={(e) => e.target.select()} /> : null}</div> : null}
            <div style={{ ...css.note, marginTop: 18 }}>通知功能：每台要接收通知的電腦或手機，都要先按一次「啟用通知」。</div>
          </section>
        ) : null}

        {toast ? <div style={css.toast}>{toast}</div> : null}
      </div>
    </main>
  );
}
