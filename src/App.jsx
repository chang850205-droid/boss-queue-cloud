import React, { useEffect, useMemo, useState } from "react";
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

const FIREBASE_CONFIG_STORAGE_KEY = "boss_queue_firebase_config_v1";

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCe2KTRR-T7aFuKjVeZizyPRJ34jGw91BQ",
  authDomain: "cpa-office.firebaseapp.com",
  projectId: "cpa-office",
  storageBucket: "cpa-office.firebasestorage.app",
  messagingSenderId: "812656677185",
  appId: "1:812656677185:web:6d5f5a5e35fede088ad1c0",
  measurementId: "G-CXBWS22F6B",
};

const APP_NAMESPACE = "boss_queue_default";
const DEFAULT_ADMIN_PIN = "1234";

let firebaseApp = null;
let firestoreDb = null;
let activeFirebaseConfigKey = "";

function readSavedFirebaseConfig() {
  return DEFAULT_FIREBASE_CONFIG;
}

function saveFirebaseConfig(config) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(FIREBASE_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

function parseFirebaseConfigText(text) {
  const source = String(text || "");
  const fields = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"];
  const result = { ...DEFAULT_FIREBASE_CONFIG };

  fields.forEach((field) => {
    const reg = new RegExp(`${field}\\s*:\\s*["']([^"']+)["']`);
    const found = source.match(reg);
    if (found?.[1]) result[field] = found[1].trim();
  });

  return result;
}

function isFirebaseConfigured(config = readSavedFirebaseConfig()) {
  return Boolean(config.apiKey && config.projectId && config.appId);
}

function getDb(config = readSavedFirebaseConfig()) {
  if (!isFirebaseConfigured(config)) return null;
  const configKey = JSON.stringify(config);
  if (!firebaseApp || activeFirebaseConfigKey !== configKey) {
    firebaseApp = initializeApp(config, `boss-queue-${Date.now()}`);
    firestoreDb = getFirestore(firebaseApp);
    activeFirebaseConfigKey = configKey;
  }
  return firestoreDb;
}

const meetingTypes = ["簽核文件", "工作回報", "請示決策", "財務/款項", "人事問題", "其他"];

const urgencyMap = {
  normal: { label: "一般", color: "#475569", bg: "#f1f5f9", priority: 2 },
  urgent: { label: "急件", color: "#c2410c", bg: "#ffedd5", priority: 1 },
  critical: { label: "非常急", color: "#b91c1c", bg: "#fee2e2", priority: 0 },
};

const statusMap = {
  waiting: "等待中",
  serving: "洽談中",
  done: "已完成",
  skipped: "已跳過",
  cancelled: "已取消",
};

const defaultSettings = {
  companyName: "公司內部會議叫號系統",
  bossName: "老闆",
  allowUrgentPriority: true,
  requireDepartment: false,
  announcement: "請留意目前叫號，輪到時請至老闆辦公室。",
  maxWaitingDisplay: 8,
  adminPin: DEFAULT_ADMIN_PIN,
};

function getTodayKey(date = new Date()) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }).replaceAll("-", "");
}

function todayDisplay(date = new Date()) {
  return date.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" });
}

function nowText(date = new Date()) {
  return date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei" });
}

function safeNumber(value, fallback = 5) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function getCurrentUrl() {
  try {
    if (typeof window === "undefined" || !window.location) return "";
    return window.location.href || "";
  } catch {
    return "";
  }
}

function createId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function normalizeQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean).map((item, index) => ({
    id: String(item.id || `legacy-${index}-${Date.now()}`),
    ticketNo: String(item.ticketNo || `A${String(index + 1).padStart(3, "0")}`),
    name: safeText(item.name, "未命名") || "未命名",
    department: safeText(item.department, "未填部門") || "未填部門",
    phone: safeText(item.phone, ""),
    type: meetingTypes.includes(item.type) ? item.type : "其他",
    urgency: urgencyMap[item.urgency] ? item.urgency : "normal",
    minutes: safeNumber(item.minutes, 5),
    note: safeText(item.note, ""),
    status: ["waiting", "serving", "done", "skipped", "cancelled"].includes(item.status) ? item.status : "waiting",
    createdAt: Number(item.createdAt || Date.now()),
    updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
    dateKey: String(item.dateKey || getTodayKey()),
    createdTime: String(item.createdTime || nowText()),
    calledTime: item.calledTime ? String(item.calledTime) : undefined,
    finishedTime: item.finishedTime ? String(item.finishedTime) : undefined,
    skippedTime: item.skippedTime ? String(item.skippedTime) : undefined,
    cancelledTime: item.cancelledTime ? String(item.cancelledTime) : undefined,
  }));
}

function normalizeSettings(value) {
  return { ...defaultSettings, ...(value || {}) };
}

function queueCollection(db) {
  return collection(db, "queueSystems", APP_NAMESPACE, "tickets");
}

function ticketDoc(db, id) {
  return doc(db, "queueSystems", APP_NAMESPACE, "tickets", id);
}

function settingsDoc(db) {
  return doc(db, "queueSystems", APP_NAMESPACE, "meta", "settings");
}

function counterDoc(db, dateKey) {
  return doc(db, "queueSystems", APP_NAMESPACE, "counters", dateKey);
}

function sortWaiting(items, allowUrgentPriority = true) {
  return normalizeQueue(items)
    .filter((item) => item.status === "waiting")
    .sort((a, b) => {
      if (!allowUrgentPriority) return a.createdAt - b.createdAt;
      const priorityA = urgencyMap[a.urgency]?.priority ?? urgencyMap.normal.priority;
      const priorityB = urgencyMap[b.urgency]?.priority ?? urgencyMap.normal.priority;
      return priorityA - priorityB || a.createdAt - b.createdAt;
    });
}

function exportCsv(rows) {
  const header = ["號碼", "姓名", "部門", "手機", "類型", "緊急", "預估分鐘", "狀態", "取號時間", "叫號時間", "完成時間", "備註"];
  const body = rows.map((item) => [
    item.ticketNo,
    item.name,
    item.department,
    item.phone,
    item.type,
    urgencyMap[item.urgency]?.label || "一般",
    item.minutes,
    statusMap[item.status] || item.status,
    item.createdTime || "",
    item.calledTime || "",
    item.finishedTime || item.skippedTime || item.cancelledTime || "",
    item.note || "",
  ]);
  const csv = [header, ...body]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `meeting-queue-${getTodayKey()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function tryCopyText(text) {
  if (!text) return { ok: false, reason: "empty" };
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard" };
    }
  } catch {}
  try {
    if (typeof document !== "undefined" && document.body) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand && document.execCommand("copy");
      document.body.removeChild(textarea);
      if (copied) return { ok: true, method: "execCommand" };
    }
  } catch {}
  return { ok: false, reason: "blocked" };
}

function buildCopyMessage(result) {
  if (result?.ok) return "已複製系統網址，可貼給員工或放到 QR Code 產生器。";
  if (result?.reason === "empty") return "目前無法取得系統網址。";
  return "瀏覽器阻擋自動複製。請直接複製下方顯示的網址。";
}

function runQueueTests() {
  const sample = [
    { id: "1", ticketNo: "A001", name: "甲", status: "waiting", urgency: "normal", createdAt: 10, dateKey: "20260518" },
    { id: "2", ticketNo: "A002", name: "乙", status: "waiting", urgency: "critical", createdAt: 20, dateKey: "20260518" },
    { id: "3", ticketNo: "A003", name: "丙", status: "waiting", urgency: "urgent", createdAt: 30, dateKey: "20260518" },
  ];
  console.assert(sortWaiting(sample, true)[0].ticketNo === "A002", "測試失敗：非常急應該優先排序");
  console.assert(sortWaiting(sample, false)[0].ticketNo === "A001", "測試失敗：關閉急件優先後應按照取號順序");
  console.assert(normalizeQueue(null).length === 0, "測試失敗：異常資料應回傳空陣列");
  console.assert(parseFirebaseConfigText('apiKey: "abc", projectId: "pid", appId: "app"').projectId === "pid", "測試失敗：應可解析 Firebase config");
}

const styles = {
  page: { minHeight: "100vh", background: "linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%)", color: "#0f172a", padding: 24, fontFamily: "Arial, 'Microsoft JhengHei', sans-serif" },
  container: { maxWidth: 1240, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" },
  title: { fontSize: 34, fontWeight: 900, margin: 0 },
  subtitle: { color: "#64748b", marginTop: 8, lineHeight: 1.6 },
  buttonRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  button: { border: "1px solid #cbd5e1", background: "white", color: "#0f172a", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  activeButton: { border: "1px solid #0f172a", background: "#0f172a", color: "white", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  dangerButton: { border: "1px solid #dc2626", background: "#dc2626", color: "white", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  successButton: { border: "1px solid #16a34a", background: "#16a34a", color: "white", borderRadius: 14, padding: "10px 14px", cursor: "pointer", fontWeight: 800 },
  disabledButton: { opacity: 0.45, cursor: "not-allowed" },
  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 24 },
  card: { background: "rgba(255,255,255,0.92)", border: "1px solid #e2e8f0", borderRadius: 22, padding: 20, boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)" },
  statValue: { fontSize: 28, fontWeight: 900, marginTop: 4 },
  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 },
  input: { width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 14, padding: "12px 14px", fontSize: 15, background: "white" },
  label: { fontSize: 13, color: "#475569", fontWeight: 800, marginBottom: 6 },
  section: { marginTop: 24 },
  boardGrid: { display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(340px, 2fr)", gap: 18, marginTop: 24 },
  ticketNo: { fontSize: 30, fontWeight: 900, letterSpacing: 1 },
  currentNo: { fontSize: 86, fontWeight: 900, letterSpacing: 3, margin: "18px 0", lineHeight: 1 },
  muted: { color: "#64748b" },
  badge: { display: "inline-block", borderRadius: 999, padding: "5px 9px", fontSize: 13, fontWeight: 900 },
  ticketCard: { background: "white", border: "1px solid #e2e8f0", borderRadius: 18, padding: 16, marginBottom: 10 },
  ticketTop: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
  note: { background: "#f8fafc", color: "#475569", borderRadius: 12, padding: 10, marginTop: 10, fontSize: 14, lineHeight: 1.5 },
  table: { width: "100%", borderCollapse: "collapse", background: "white", borderRadius: 18, overflow: "hidden" },
  th: { textAlign: "left", padding: 12, background: "#f1f5f9", fontSize: 13, color: "#475569" },
  td: { padding: 12, borderTop: "1px solid #e2e8f0", fontSize: 14 },
  copyBox: { background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", borderRadius: 16, padding: 12, marginTop: 12, wordBreak: "break-all", lineHeight: 1.6 },
  statusOk: { background: "#dcfce7", border: "1px solid #86efac", color: "#166534", borderRadius: 16, padding: 12, marginTop: 12 },
  statusBad: { background: "#fee2e2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 16, padding: 12, marginTop: 12 },
};

function Button({ children, active, danger, success, disabled, onClick, type = "button" }) {
  const baseStyle = danger ? styles.dangerButton : success ? styles.successButton : active ? styles.activeButton : styles.button;
  return <button type={type} style={{ ...baseStyle, ...(disabled ? styles.disabledButton : {}) }} disabled={disabled} onClick={onClick}>{children}</button>;
}

function Field({ label, children }) {
  return <div><div style={styles.label}>{label}</div>{children}</div>;
}

function TextInput({ value, onChange, placeholder, type = "text", readOnly = false }) {
  return <input type={type} style={styles.input} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} readOnly={readOnly} />;
}

function TextArea({ value, onChange, placeholder }) {
  return <textarea style={{ ...styles.input, minHeight: 86, resize: "vertical" }} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />;
}

function SelectInput({ value, onChange, children }) {
  return <select style={styles.input} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>;
}

function StatCard({ label, value }) {
  return <div style={styles.card}><div style={styles.muted}>{label}</div><div style={styles.statValue}>{value}</div></div>;
}

function CopyUrlPanel({ url, message }) {
  if (!message) return null;
  return (
    <div style={styles.copyBox}>
      <strong>{message}</strong>
      {!message.includes("已複製") && url ? (
        <div style={{ marginTop: 8 }}>
          <input style={{ ...styles.input, background: "white" }} readOnly value={url} onFocus={(event) => event.target.select()} />
          <div style={{ fontSize: 13, marginTop: 6 }}>點一下上方網址後按 Ctrl+C，或手機長按複製。</div>
        </div>
      ) : null}
    </div>
  );
}

function TicketCard({ item, index, action, compact = false }) {
  const urgency = urgencyMap[item.urgency] || urgencyMap.normal;
  return (
    <div style={styles.ticketCard}>
      <div style={styles.ticketTop}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={styles.ticketNo}>{item.ticketNo}</span>
            <span style={{ ...styles.badge, color: urgency.color, background: urgency.bg }}>{urgency.label}</span>
            <span style={{ ...styles.badge, color: "#334155", background: "#e2e8f0" }}>{statusMap[item.status] || item.status}</span>
          </div>
          <div style={{ marginTop: 5, fontWeight: 900 }}>{item.name}｜{item.department}</div>
          <div style={{ ...styles.muted, fontSize: 14, marginTop: 4 }}>{item.type}・預估 {item.minutes} 分鐘・取號 {item.createdTime}</div>
          {!compact && item.phone ? <div style={{ ...styles.muted, fontSize: 14, marginTop: 4 }}>手機：{item.phone}</div> : null}
          {!compact && item.note ? <div style={styles.note}>{item.note}</div> : null}
        </div>
        {typeof index === "number" ? <div style={{ textAlign: "right", ...styles.muted }}>順位<br /><strong style={{ color: "#0f172a", fontSize: 22 }}>{index + 1}</strong></div> : null}
      </div>
      {action ? <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>{action}</div> : null}
    </div>
  );
}

function PinGate({ settings, onUnlock }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  function submit() {
    if (pin === String(settings.adminPin || DEFAULT_ADMIN_PIN)) onUnlock();
    else setError("密碼錯誤。預設密碼是 1234，正式使用請到管理設定修改。");
  }
  return (
    <section style={{ ...styles.card, ...styles.section, maxWidth: 520 }}>
      <h2 style={{ marginTop: 0 }}>管理者登入</h2>
      <p style={styles.muted}>老闆後台、紀錄匯出與系統設定需要輸入管理密碼。</p>
      <Field label="管理密碼"><TextInput type="password" value={pin} onChange={setPin} placeholder="請輸入管理密碼" /></Field>
      {error ? <div style={{ color: "#dc2626", marginTop: 10 }}>{error}</div> : null}
      <div style={{ marginTop: 14 }}><Button active onClick={submit}>登入</Button></div>
    </section>
  );
}

function FirebaseSetup({ currentConfig, onSave }) {
  const [rawText, setRawText] = useState("");
  const [form, setForm] = useState(currentConfig || DEFAULT_FIREBASE_CONFIG);

  function applyRawText() {
    const parsed = parseFirebaseConfigText(rawText);
    setForm((prev) => ({ ...prev, ...parsed }));
  }

  function save() {
    if (!isFirebaseConfigured(form)) {
      alert("請至少填入 apiKey、projectId、appId。建議直接貼上 Firebase Console 的完整 firebaseConfig。");
      return;
    }
    onSave(form);
  }

  return (
    <section style={{ ...styles.card, ...styles.section }}>
      <h2 style={{ marginTop: 0 }}>Firebase 雲端同步設定</h2>
      <p style={styles.muted}>把 Firebase Console 產生的 <strong>firebaseConfig</strong> 整段貼到下面，按「解析設定」，再按「儲存並連線」。之後不用再改程式碼。</p>
      <Field label="貼上 Firebase config">
        <TextArea value={rawText} onChange={setRawText} placeholder={'例如：const firebaseConfig = { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." }'} />
      </Field>
      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button onClick={applyRawText}>解析設定</Button>
        <Button success onClick={save}>儲存並連線</Button>
      </div>
      <div style={{ ...styles.grid2, marginTop: 16 }}>
        <Field label="apiKey"><TextInput value={form.apiKey} onChange={(v) => setForm((p) => ({ ...p, apiKey: v }))} /></Field>
        <Field label="authDomain"><TextInput value={form.authDomain} onChange={(v) => setForm((p) => ({ ...p, authDomain: v }))} /></Field>
        <Field label="projectId"><TextInput value={form.projectId} onChange={(v) => setForm((p) => ({ ...p, projectId: v }))} /></Field>
        <Field label="storageBucket"><TextInput value={form.storageBucket} onChange={(v) => setForm((p) => ({ ...p, storageBucket: v }))} /></Field>
        <Field label="messagingSenderId"><TextInput value={form.messagingSenderId} onChange={(v) => setForm((p) => ({ ...p, messagingSenderId: v }))} /></Field>
        <Field label="appId"><TextInput value={form.appId} onChange={(v) => setForm((p) => ({ ...p, appId: v }))} /></Field>
      </div>
      <div style={{ ...styles.note, marginTop: 16 }}>
        Firestore Database 請先在 Firebase Console 啟用。測試階段可先用 test mode；正式使用建議再調整安全規則。
      </div>
    </section>
  );
}

export default function BossQueueSystemCloud() {
  const [queue, setQueue] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [phone, setPhone] = useState("");
  const [type, setType] = useState("簽核文件");
  const [urgency, setUrgency] = useState("normal");
  const [minutes, setMinutes] = useState("5");
  const [note, setNote] = useState("");
  const [view, setView] = useState("staff");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [lastTicket, setLastTicket] = useState(null);
  const [newPin, setNewPin] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [manualCopyUrl, setManualCopyUrl] = useState("");
  const [syncStatus, setSyncStatus] = useState("checking");
  const [errorMessage, setErrorMessage] = useState("");
  const [firebaseConfig, setFirebaseConfig] = useState(() => readSavedFirebaseConfig());

  const db = useMemo(() => getDb(firebaseConfig), [firebaseConfig]);

  useEffect(() => {
    runQueueTests();
    if (!db) {
      setSyncStatus("not_configured");
      setErrorMessage("尚未設定 Firebase。請到下方設定區貼上 Firebase Console 提供的 firebaseConfig。");
      return;
    }

    setSyncStatus("connecting");
    const todayKey = getTodayKey();
    const q = query(queueCollection(db), where("dateKey", "==", todayKey));

    const unsubscribeQueue = onSnapshot(q, (snapshot) => {
      const rows = snapshot.docs.map((snap) => ({ id: snap.id, ...snap.data() }));
      setQueue(normalizeQueue(rows));
      setSyncStatus("online");
      setErrorMessage("");
    }, (error) => {
      setSyncStatus("error");
      setErrorMessage(`Firestore 讀取失敗：${error.message}`);
    });

    const unsubscribeSettings = onSnapshot(settingsDoc(db), async (snapshot) => {
      if (snapshot.exists()) setSettings(normalizeSettings(snapshot.data()));
      else await setDoc(settingsDoc(db), defaultSettings, { merge: true });
    }, (error) => {
      setSyncStatus("error");
      setErrorMessage(`設定讀取失敗：${error.message}`);
    });

    return () => {
      unsubscribeQueue();
      unsubscribeSettings();
    };
  }, [db]);

  const normalizedQueue = useMemo(() => normalizeQueue(queue), [queue]);
  const todayQueue = useMemo(() => normalizedQueue.filter((item) => item.dateKey === getTodayKey()), [normalizedQueue]);
  const waiting = useMemo(() => todayQueue.filter((item) => item.status === "waiting"), [todayQueue]);
  const serving = useMemo(() => todayQueue.find((item) => item.status === "serving"), [todayQueue]);
  const done = useMemo(() => todayQueue.filter((item) => item.status === "done"), [todayQueue]);
  const skipped = useMemo(() => todayQueue.filter((item) => item.status === "skipped"), [todayQueue]);
  const cancelled = useMemo(() => todayQueue.filter((item) => item.status === "cancelled"), [todayQueue]);
  const sortedWaiting = useMemo(() => sortWaiting(todayQueue, settings.allowUrgentPriority), [todayQueue, settings.allowUrgentPriority]);
  const totalWaitingMinutes = sortedWaiting.reduce((sum, item) => sum + safeNumber(item.minutes, 5), 0);

  async function copyCurrentUrl() {
    const url = getCurrentUrl();
    const result = await tryCopyText(url);
    setCopyMessage(buildCopyMessage(result));
    setManualCopyUrl(result.ok ? "" : url);
  }

  async function addTicket() {
    if (!db) return alert("Firebase 尚未設定，無法雲端取號。");
    const trimmedName = name.trim();
    if (!trimmedName) return alert("請填寫姓名");
    if (settings.requireDepartment && !department.trim()) return alert("請填寫部門");

    const dateKey = getTodayKey();
    const id = createId();
    const createdAt = Date.now();
    let item = null;

    try {
      await runTransaction(db, async (transaction) => {
        const counterRef = counterDoc(db, dateKey);
        const counterSnap = await transaction.get(counterRef);
        const current = counterSnap.exists() ? safeNumber(counterSnap.data().count, 0) : 0;
        const next = current + 1;
        const ticketNo = `A${String(next).padStart(3, "0")}`;
        item = {
          id,
          ticketNo,
          name: trimmedName,
          department: department.trim() || "未填部門",
          phone: phone.trim(),
          type,
          urgency,
          minutes: safeNumber(minutes, 5),
          note: note.trim(),
          status: "waiting",
          createdAt,
          updatedAt: createdAt,
          dateKey,
          createdTime: nowText(),
        };
        transaction.set(counterRef, { count: next, updatedAt: createdAt, dateKey }, { merge: true });
        transaction.set(ticketDoc(db, id), cleanObject(item));
      });

      setLastTicket(item);
      setName("");
      setDepartment("");
      setPhone("");
      setType("簽核文件");
      setUrgency("normal");
      setMinutes("5");
      setNote("");
      setView("ticket");
    } catch (error) {
      alert(`取號失敗：${error.message}`);
    }
  }

  async function updateTicket(id, patch) {
    if (!db) return alert("Firebase 尚未設定，無法更新資料。");
    try {
      await updateDoc(ticketDoc(db, id), cleanObject({ ...patch, updatedAt: Date.now() }));
    } catch (error) {
      alert(`更新失敗：${error.message}`);
    }
  }

  async function callNext() {
    if (!db) return alert("Firebase 尚未設定，無法叫號。");
    try {
      const currentServing = todayQueue.find((item) => item.status === "serving");
      const next = sortedWaiting[0];
      if (!next) return;

      if (currentServing) await updateDoc(ticketDoc(db, currentServing.id), cleanObject({ status: "done", finishedTime: nowText(), updatedAt: Date.now() }));
      await updateDoc(ticketDoc(db, next.id), cleanObject({ status: "serving", calledTime: nowText(), updatedAt: Date.now() }));
      setView("display");
    } catch (error) {
      alert(`叫號失敗：${error.message}`);
    }
  }

  async function completeCurrent() {
    if (!serving) return;
    await updateTicket(serving.id, { status: "done", finishedTime: nowText() });
  }

  async function skipCurrent() {
    if (!serving) return;
    await updateTicket(serving.id, { status: "skipped", skippedTime: nowText() });
  }

  async function cancelTicket(id) {
    await updateTicket(id, { status: "cancelled", cancelledTime: nowText() });
  }

  async function recallTicket(id) {
    await updateTicket(id, { status: "waiting", createdAt: Date.now(), skippedTime: null, cancelledTime: null });
  }

  async function saveSettingsPatch(patch) {
    if (!db) return setSettings((prev) => ({ ...prev, ...patch }));
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await setDoc(settingsDoc(db), cleanObject(next), { merge: true });
    } catch (error) {
      alert(`設定儲存失敗：${error.message}`);
    }
  }

  async function resetToday() {
    if (!db) return alert("Firebase 尚未設定，無法清空資料。");
    const ok = typeof window === "undefined" || window.confirm("確定要清空今日資料嗎？此動作會刪除今日所有排隊紀錄。");
    if (!ok) return;
    try {
      const snapshot = await getDocs(query(queueCollection(db), where("dateKey", "==", getTodayKey())));
      await Promise.all(snapshot.docs.map((snap) => deleteDoc(snap.ref)));
      await setDoc(counterDoc(db, getTodayKey()), { count: 0, updatedAt: Date.now(), dateKey: getTodayKey() }, { merge: true });
    } catch (error) {
      alert(`清空失敗：${error.message}`);
    }
  }

  async function saveNewPin() {
    if (!newPin.trim() || newPin.trim().length < 4) return alert("密碼至少 4 碼");
    await saveSettingsPatch({ adminPin: newPin.trim() });
    setNewPin("");
    alert("管理密碼已更新");
  }

  const needsPin = ["boss", "records", "settings"].includes(view) && !adminUnlocked;
  const syncText = {
    checking: "檢查連線中",
    not_configured: "Firebase 尚未設定",
    connecting: "雲端連線中",
    online: "雲端同步中",
    error: "雲端連線異常",
  }[syncStatus] || "未知狀態";

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>{settings.companyName}</h1>
            <div style={styles.subtitle}>{todayDisplay()}｜{settings.bossName}會議排隊叫號<br />{settings.announcement}</div>
          </div>
          <nav style={styles.buttonRow} aria-label="系統頁面切換">
            <Button active={view === "staff"} onClick={() => setView("staff")}>員工取號</Button>
            <Button active={view === "display"} onClick={() => setView("display")}>叫號看板</Button>
            <Button active={view === "boss"} onClick={() => setView("boss")}>老闆端</Button>
            <Button active={view === "records"} onClick={() => setView("records")}>紀錄</Button>
            <Button active={view === "settings"} onClick={() => setView("settings")}>設定</Button>
            
          </nav>
        </header>

        <div style={syncStatus === "online" ? styles.statusOk : styles.statusBad}>
          <strong>{syncText}</strong>{errorMessage ? `｜${errorMessage}` : ""}
        </div>

        {!db ? (
          <div style={styles.statusBad}>Firebase 連線設定尚未成功，請確認 Firestore Database 已啟用。</div>
        ) : null}

        <section style={styles.stats} aria-label="目前排隊統計">
          <StatCard label="等待人數" value={waiting.length} />
          <StatCard label="目前叫號" value={serving?.ticketNo || "—"} />
          <StatCard label="估計等待" value={`${totalWaitingMinutes}分`} />
          <StatCard label="今日完成" value={done.length} />
          <StatCard label="跳過/取消" value={skipped.length + cancelled.length} />
        </section>

        {needsPin ? <PinGate settings={settings} onUnlock={() => setAdminUnlocked(true)} /> : null}

        {!needsPin && view === "staff" ? (
          <section style={{ ...styles.card, ...styles.section }}>
            <h2 style={{ marginTop: 0 }}>員工取號</h2>
            <p style={styles.muted}>請填寫基本資料，系統會自動產生號碼。取號後請留意叫號看板。</p>
            <div style={styles.grid2}>
              <Field label="姓名 *"><TextInput placeholder="例如：王小明" value={name} onChange={setName} /></Field>
              <Field label={settings.requireDepartment ? "部門 *" : "部門"}><TextInput placeholder="例如：財務部" value={department} onChange={setDepartment} /></Field>
              <Field label="手機/分機"><TextInput placeholder="可填手機或公司分機" value={phone} onChange={setPhone} /></Field>
              <Field label="會議類型"><SelectInput value={type} onChange={setType}>{meetingTypes.map((item) => <option key={item} value={item}>{item}</option>)}</SelectInput></Field>
              <Field label="緊急程度"><SelectInput value={urgency} onChange={setUrgency}><option value="normal">一般</option><option value="urgent">急件</option><option value="critical">非常急</option></SelectInput></Field>
              <Field label="預估時間"><SelectInput value={minutes} onChange={setMinutes}><option value="5">約 5 分鐘</option><option value="10">約 10 分鐘</option><option value="15">約 15 分鐘</option><option value="30">約 30 分鐘</option><option value="60">約 60 分鐘</option></SelectInput></Field>
            </div>
            <div style={{ marginTop: 14 }}><Field label="簡短說明"><TextArea placeholder="例如：請老闆核准付款單，或簡述要討論的事情" value={note} onChange={setNote} /></Field></div>
            <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button success onClick={addTicket} disabled={!db}>取號排隊</Button>
              <Button onClick={copyCurrentUrl}>複製取號網址</Button>
            </div>
            <CopyUrlPanel url={manualCopyUrl} message={copyMessage} />
          </section>
        ) : null}

        {!needsPin && view === "ticket" && lastTicket ? (
          <section style={{ ...styles.card, ...styles.section, textAlign: "center" }}>
            <h2 style={{ marginTop: 0 }}>取號成功</h2>
            <div style={{ ...styles.currentNo, color: "#16a34a" }}>{lastTicket.ticketNo}</div>
            <div style={{ fontSize: 22, fontWeight: 900 }}>{lastTicket.name}｜{lastTicket.department}</div>
            <p style={styles.muted}>請留意叫號看板，輪到您時請前往{settings.bossName}辦公室。</p>
            <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
              <Button active onClick={() => setView("display")}>查看叫號看板</Button>
              <Button onClick={() => setView("staff")}>繼續取號</Button>
            </div>
          </section>
        ) : null}

        {!needsPin && view === "display" ? (
          <section style={styles.boardGrid}>
            <div style={{ ...styles.card, textAlign: "center" }}>
              <div style={{ ...styles.muted, fontSize: 18 }}>目前輪到</div>
              <div style={styles.currentNo}>{serving?.ticketNo || "—"}</div>
              <div style={{ fontSize: 24, fontWeight: 900 }}>{serving ? `${serving.name}｜${serving.department}` : "尚未叫號"}</div>
              <div style={{ ...styles.muted, marginTop: 8, fontSize: 16 }}>{serving?.type || "請等待叫號"}</div>
              {serving?.note ? <div style={{ ...styles.note, textAlign: "left" }}>{serving.note}</div> : null}
            </div>
            <div>
              <h2 style={{ marginTop: 0 }}>等待名單</h2>
              {sortedWaiting.length === 0 ? <div style={styles.card}>目前沒有人等待。</div> : sortedWaiting.slice(0, settings.maxWaitingDisplay).map((item, index) => <TicketCard key={item.id} item={item} index={index} compact />)}
              {sortedWaiting.length > settings.maxWaitingDisplay ? <div style={{ ...styles.muted, marginTop: 8 }}>尚有 {sortedWaiting.length - settings.maxWaitingDisplay} 位等待中。</div> : null}
            </div>
          </section>
        ) : null}

        {!needsPin && view === "boss" ? (
          <section style={styles.boardGrid}>
            <div style={styles.card}>
              <h2 style={{ marginTop: 0 }}>老闆操作區</h2>
              <div style={{ background: "#f1f5f9", borderRadius: 18, padding: 16, marginBottom: 14 }}>
                <div style={styles.muted}>目前處理</div>
                <div style={{ fontSize: 46, fontWeight: 900, marginTop: 8 }}>{serving?.ticketNo || "—"}</div>
                <div style={{ fontWeight: 900, marginTop: 8 }}>{serving ? `${serving.name}｜${serving.department}` : "尚未叫號"}</div>
                {serving?.note ? <div style={{ ...styles.note }}>{serving.note}</div> : null}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                <Button success onClick={callNext} disabled={sortedWaiting.length === 0 || !db}>叫下一位</Button>
                <Button onClick={completeCurrent} disabled={!serving || !db}>完成目前會議</Button>
                <Button onClick={skipCurrent} disabled={!serving || !db}>跳過目前號碼</Button>
                <Button danger onClick={resetToday} disabled={!db}>清空今日資料</Button>
              </div>
            </div>
            <div>
              <h2 style={{ marginTop: 0 }}>待叫號</h2>
              {sortedWaiting.length === 0 ? <div style={styles.card}>沒有待叫號。</div> : sortedWaiting.map((item, index) => <TicketCard key={item.id} item={item} index={index} action={<><Button onClick={() => updateTicket(item.id, { status: "serving", calledTime: nowText() })}>直接叫號</Button><Button danger onClick={() => cancelTicket(item.id)}>取消</Button></>} />)}
              {skipped.length > 0 ? <div style={{ marginTop: 22 }}><h2>已跳過，可重新排入</h2>{skipped.map((item) => <TicketCard key={item.id} item={item} action={<Button onClick={() => recallTicket(item.id)}>重新排入</Button>} />)}</div> : null}
            </div>
          </section>
        ) : null}

        {!needsPin && view === "records" ? (
          <section style={{ ...styles.card, ...styles.section }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <div><h2 style={{ margin: 0 }}>今日紀錄</h2><p style={styles.muted}>可匯出 CSV 給行政或主管留存。</p></div>
              <Button active onClick={() => exportCsv(todayQueue)}>匯出今日 CSV</Button>
            </div>
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>號碼</th><th style={styles.th}>姓名</th><th style={styles.th}>部門</th><th style={styles.th}>類型</th><th style={styles.th}>狀態</th><th style={styles.th}>取號</th><th style={styles.th}>叫號</th><th style={styles.th}>結束</th></tr></thead>
                <tbody>{todayQueue.length === 0 ? <tr><td style={styles.td} colSpan="8">今日尚無紀錄。</td></tr> : todayQueue.map((item) => <tr key={item.id}><td style={styles.td}>{item.ticketNo}</td><td style={styles.td}>{item.name}</td><td style={styles.td}>{item.department}</td><td style={styles.td}>{item.type}</td><td style={styles.td}>{statusMap[item.status]}</td><td style={styles.td}>{item.createdTime}</td><td style={styles.td}>{item.calledTime || ""}</td><td style={styles.td}>{item.finishedTime || item.skippedTime || item.cancelledTime || ""}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        ) : null}

        {!needsPin && view === "settings" ? (
          <section style={{ ...styles.card, ...styles.section }}>
            <h2 style={{ marginTop: 0 }}>系統設定</h2>
            <div style={styles.grid2}>
              <Field label="系統名稱"><TextInput value={settings.companyName} onChange={(value) => saveSettingsPatch({ companyName: value })} /></Field>
              <Field label="主管稱呼"><TextInput value={settings.bossName} onChange={(value) => saveSettingsPatch({ bossName: value })} /></Field>
              <Field label="看板顯示等待筆數"><TextInput type="number" value={String(settings.maxWaitingDisplay)} onChange={(value) => saveSettingsPatch({ maxWaitingDisplay: safeNumber(value, 8) })} /></Field>
              <Field label="管理密碼"><TextInput type="password" value={newPin} onChange={setNewPin} placeholder="輸入新密碼，至少 4 碼" /></Field>
            </div>
            <div style={{ marginTop: 14 }}><Field label="公告文字"><TextArea value={settings.announcement} onChange={(value) => saveSettingsPatch({ announcement: value })} /></Field></div>
            <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontWeight: 800 }}><input type="checkbox" checked={settings.allowUrgentPriority} onChange={(e) => saveSettingsPatch({ allowUrgentPriority: e.target.checked })} /> 急件優先排序</label>
              <label style={{ fontWeight: 800 }}><input type="checkbox" checked={settings.requireDepartment} onChange={(e) => saveSettingsPatch({ requireDepartment: e.target.checked })} /> 部門必填</label>
              <Button onClick={saveNewPin}>更新管理密碼</Button>
              <Button onClick={copyCurrentUrl}>複製系統網址</Button>
            </div>
            <CopyUrlPanel url={manualCopyUrl} message={copyMessage} />
            <div style={{ ...styles.note, marginTop: 18 }}>
              Firebase 雲端同步版已啟用。員工手機取號、老闆端叫號、電視看板會即時同步。Firebase 設定已內建，不需要再手動貼設定。
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
