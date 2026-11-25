import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  writeBatch
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAv3tYdGtJsnbIKxqZ-MtaUphqiG8URAjg",
  authDomain: "my-web-app-b1606.firebaseapp.com",
  projectId: "my-web-app-b1606",
  storageBucket: "my-web-app-b1606.firebasestorage.app",
  messagingSenderId: "735406671962",
  appId: "1:735406671962:web:802aeb79b452dd4c52b063"
};

// Firebase Console > App Check > Apps > Register web app > reCAPTCHA Enterprise.
// Paste the public site key here. This key is not a secret.
const RECAPTCHA_ENTERPRISE_SITE_KEY = "6LdO9C0uAAAAAAH3Rr1QbxvgWmcwmcuHsDzkGdF1";
const AI_MODEL_NAME = "gemini-4-hydrogen";
const USER_ITEMS_COLLECTION = "items";
const MAX_BATCH_WRITES = 450;
const cloudCacheKey = uid => `daywell-items-v1:cloud:${uid}`;

const $ = id => document.getElementById(id);
const toast = message => window.daywellToast?.(message);
const syncStatus = $("syncStatus");
const setSyncStatus = (state, label) => {
  syncStatus.dataset.state = state;
  syncStatus.textContent = label;
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app); // Uses the project's (default) Firestore database.
const googleProvider = new GoogleAuthProvider();

let activeUid = null;
let activeGeneration = 0;
let loadingUid = null;
let syncReady = false;
let unsubscribeItems = null;
let syncTimer = null;
let cloudItems = new Map();
let syncQueue = Promise.resolve();
let aiModel = null;
let aiSetupMessage = "";
let lastAIUid = null;

function cloneItems(items) {
  return JSON.parse(JSON.stringify(items));
}

function asItemMap(items) {
  return new Map(items.map(item => [item.id, item]));
}

function readCloudCache(uid) {
  try {
    const cached = JSON.parse(localStorage.getItem(cloudCacheKey(uid)));
    return Array.isArray(cached) ? cached : null;
  } catch {
    return null;
  }
}

function saveCloudCache(uid, items) {
  try {
    localStorage.setItem(cloudCacheKey(uid), JSON.stringify([...items.values()]));
  } catch (error) {
    console.warn("Local Firestore sync marker could not be saved:", error);
  }
}

function sameItem(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function sameItemMap(a, b) {
  return a.size === b.size && [...a].every(([id, item]) => sameItem(item, b.get(id)));
}

function difference(base, current) {
  const changes = new Map();
  const ids = new Set([...base.keys(), ...current.keys()]);
  for (const id of ids) {
    if (!sameItem(base.get(id), current.get(id))) {
      changes.set(id, current.has(id) ? current.get(id) : null);
    }
  }
  return changes;
}

function applyChanges(base, changes) {
  const merged = new Map(base);
  for (const [id, item] of changes) {
    if (item) merged.set(id, item);
    else merged.delete(id);
  }
  return merged;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeItem(id, value) {
  if (!value || typeof value !== "object" || typeof id !== "string") return null;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 80) return null;
  if (!(["task", "event"].includes(value.type)) || !validDate(value.date)) return null;
  if (typeof value.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return null;
  if (!Number.isInteger(value.duration) || value.duration < 5 || value.duration > 1440) return null;
  if (!(["purple", "teal", "amber", "red"].includes(value.color))) return null;
  if (typeof value.done !== "boolean") return null;
  const due = typeof value.due === "string" && validDate(value.due) ? value.due : "";
  return {
    id,
    title: value.title.trim(),
    type: value.type,
    date: value.date,
    time: value.time,
    duration: value.duration,
    ...(value.type === "task" ? { due } : {}),
    color: value.color,
    done: value.done
  };
}

function readCloudSnapshot(snapshot) {
  const result = new Map();
  snapshot.forEach(documentSnapshot => {
    const item = normalizeItem(documentSnapshot.id, documentSnapshot.data());
    if (item) result.set(item.id, item);
  });
  return result;
}

function writeDifference(uid, previous, next) {
  const changes = difference(previous, next);
  if (!changes.size) return Promise.resolve();
  const writes = [...changes.entries()];
  const batches = [];
  for (let offset = 0; offset < writes.length; offset += MAX_BATCH_WRITES) {
    const batch = writeBatch(db);
    const chunk = writes.slice(offset, offset + MAX_BATCH_WRITES);
    for (const [id, item] of chunk) {
      const reference = doc(db, "users", uid, USER_ITEMS_COLLECTION, id);
      if (item) batch.set(reference, item);
      else batch.delete(reference);
    }
    batches.push(batch.commit());
  }
  return Promise.all(batches);
}

async function persistItems(uid, items) {
  if (uid !== activeUid) return;
  const next = asItemMap(items);
  setSyncStatus("syncing", "正在同步");
  try {
    await writeDifference(uid, cloudItems, next);
    if (uid !== activeUid) return;
    cloudItems = next;
    saveCloudCache(uid, cloudItems);
    setSyncStatus("synced", "已同步至雲端");
  } catch (error) {
    console.error("Firestore write failed:", error);
    if (uid === activeUid) {
      setSyncStatus("error", "雲端同步失敗");
      toast("雲端同步失敗；資料已保留在此裝置，請檢查 Firestore 規則或網路");
    }
    throw error;
  }
}

function scheduleSync() {
  if (!activeUid || !syncReady) return;
  const uid = activeUid;
  clearTimeout(syncTimer);
  setSyncStatus("syncing", "正在同步");
  syncTimer = setTimeout(() => {
    const items = window.daywellData.getItems();
    syncQueue = syncQueue
      .catch(() => {})
      .then(() => persistItems(uid, items))
      .catch(() => {});
  }, 350);
}

window.addEventListener("daywell:items-changed", () => {
  if (!activeUid) {
    setSyncStatus("local", "本機資料");
    return;
  }
  if (syncReady) scheduleSync();
});

async function activateUserData(uid) {
  if (loadingUid === uid) return;
  const generation = ++activeGeneration;
  loadingUid = uid;
  syncReady = false;
  clearTimeout(syncTimer);
  unsubscribeItems?.();
  unsubscribeItems = null;
  cloudItems = new Map();
  const cachedItems = window.daywellData.setOwner(uid);
  const baseline = asItemMap(readCloudCache(uid) || cachedItems);
  setSyncStatus("syncing", "載入雲端資料");

  try {
    const reference = collection(db, "users", uid, USER_ITEMS_COLLECTION);
    const initialSnapshot = await getDocs(reference);
    if (generation !== activeGeneration || uid !== activeUid) return;

    const initialCloudItems = readCloudSnapshot(initialSnapshot);
    if (initialCloudItems.size === 0) {
      // First sign-in: copy the existing local schedule to this user's account.
      const localItems = asItemMap(window.daywellData.getItems());
      await writeDifference(uid, new Map(), localItems);
      if (generation !== activeGeneration || uid !== activeUid) return;
      cloudItems = localItems;
      saveCloudCache(uid, cloudItems);
      window.daywellData.setItems([...localItems.values()], uid);
    } else {
      // Existing cloud data is authoritative. Preserve edits made while it loaded.
      const localChanges = difference(baseline, asItemMap(window.daywellData.getItems()));
      const mergedItems = applyChanges(initialCloudItems, localChanges);
      cloudItems = initialCloudItems;
      window.daywellData.setItems([...mergedItems.values()], uid);
      if (localChanges.size) {
        await writeDifference(uid, cloudItems, mergedItems);
        if (generation !== activeGeneration || uid !== activeUid) return;
        cloudItems = mergedItems;
      }
      saveCloudCache(uid, cloudItems);
    }

    syncReady = true;
    setSyncStatus("synced", "已同步至雲端");
    unsubscribeItems = onSnapshot(reference, snapshot => {
      if (generation !== activeGeneration || uid !== activeUid) return;
      const remoteItems = readCloudSnapshot(snapshot);
      const localItems = asItemMap(window.daywellData.getItems());
      const unsyncedChanges = difference(cloudItems, localItems);
      const mergedItems = applyChanges(remoteItems, unsyncedChanges);
      const changed = !sameItemMap(mergedItems, localItems);
      cloudItems = remoteItems;
      saveCloudCache(uid, cloudItems);
      if (changed) window.daywellData.setItems([...mergedItems.values()], uid);
      if (unsyncedChanges.size) scheduleSync();
      else setSyncStatus("synced", "已同步至雲端");
    }, error => {
      console.error("Firestore listener failed:", error);
      if (generation === activeGeneration && uid === activeUid) {
        setSyncStatus("error", "雲端同步失敗");
        toast("無法接收雲端更新，請檢查 Firestore 規則與網路");
      }
    });
  } catch (error) {
    console.error("Firestore initialization failed:", error);
    if (generation === activeGeneration && uid === activeUid) {
      syncReady = false;
      setSyncStatus("error", "雲端連線失敗");
      toast("無法載入 Firestore；本機資料仍可使用，重新連線後會再試");
    }
  } finally {
    if (generation === activeGeneration && loadingUid === uid) loadingUid = null;
  }
}

function updateProfile(user) {
  const signedIn = Boolean(user);
  $("authProfile").hidden = !signedIn;
  $("signInBtn").hidden = signedIn;
  if (!signedIn) {
    $("authName").textContent = "";
    $("authEmail").textContent = "";
    $("authPhoto").removeAttribute("src");
    $("sidebarAuthPhoto").src = fallbackAvatar;
    $("sidebarAuthName").textContent = "我的工作區";
    $("sidebarAuthEmail").textContent = "個人行程";
    return;
  }
  const name = user.displayName || "Google 使用者";
  const photo = user.photoURL || fallbackAvatar;
  $("authName").textContent = name;
  $("authEmail").textContent = user.email || "";
  $("sidebarAuthName").textContent = name;
  $("sidebarAuthEmail").textContent = user.email || "";
  for (const image of [$("authPhoto"), $("sidebarAuthPhoto")]) {
    image.onerror = () => { image.onerror = null; image.src = fallbackAvatar; };
    image.src = photo;
  }
}

const fallbackAvatar = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#f8e4d7"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="30">🌿</text></svg>'
);

function resetToGuest() {
  activeGeneration++;
  activeUid = null;
  loadingUid = null;
  syncReady = false;
  clearTimeout(syncTimer);
  unsubscribeItems?.();
  unsubscribeItems = null;
  cloudItems = new Map();
  window.daywellData.setOwner(null);
  setSyncStatus("local", "本機資料");
}

$("signInBtn").addEventListener("click", async () => {
  $("signInBtn").disabled = true;
  try {
    await signInWithPopup(auth, googleProvider);
    toast("Google 登入成功");
  } catch (error) {
    if (error.code === "auth/popup-closed-by-user") toast("已取消 Google 登入");
    else if (error.code === "auth/popup-blocked") toast("登入視窗遭封鎖，請允許此網站開啟彈出式視窗");
    else if (error.code === "auth/cancelled-popup-request") toast("登入視窗已取消");
    else {
      console.error("Google sign-in failed:", error);
      toast(error.code === "auth/unauthorized-domain"
        ? "此網域尚未加入 Firebase 授權網域"
        : `登入失敗${error.code ? `（${error.code}）` : ""}，請稍後再試`);
    }
  } finally {
    $("signInBtn").disabled = false;
  }
});

$("signOutBtn").addEventListener("click", async () => {
  $("signOutBtn").disabled = true;
  try {
    await signOut(auth);
    toast("已登出");
  } catch (error) {
    console.error("Sign-out failed:", error);
    toast("登出失敗，請稍後再試");
  } finally {
    $("signOutBtn").disabled = false;
  }
});

window.addEventListener("online", () => {
  if (activeUid && !syncReady && !loadingUid) void activateUserData(activeUid);
});

async function setupAI() {
  if (!RECAPTCHA_ENTERPRISE_SITE_KEY.trim()) {
    aiSetupMessage = "AI 助理尚未啟用：請先在 firebase-app.js 設定 reCAPTCHA Enterprise Site Key，並在 Firebase Console 啟用 Firebase AI Logic。";
    return;
  }
  aiSetupMessage = "AI 助理正在載入，請稍後再試。";
  try {
    const [appCheckSdk, aiSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/13.3.0/firebase-app-check.js"),
      import("https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js")
    ]);
    appCheckSdk.initializeAppCheck(app, {
      provider: new appCheckSdk.ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY.trim()),
      isTokenAutoRefreshEnabled: true
    });
    const ai = aiSdk.getAI(app, {
      backend: new aiSdk.GoogleAIBackend(),
      useLimitedUseAppCheckTokens: true
    });
    aiModel = aiSdk.getGenerativeModel(ai, { model: AI_MODEL_NAME });
    aiSetupMessage = "";
  } catch (error) {
    console.error("Firebase AI Logic could not initialize:", error);
    aiSetupMessage = "AI 助理初始化失敗，請確認 App Check 網站金鑰與 Firebase AI Logic 設定。";
  }
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildScheduleContext() {
  const today = localDateString();
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const through = localDateString(nextWeek);
  const items = window.daywellData.getItems();
  const relevant = items
    .filter(item => item.date === today || (item.type === "task" && !item.done && item.due && item.due <= through))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
    .slice(0, 80)
    .map(item => ({
      title: item.title,
      type: item.type === "task" ? "任務" : "行程",
      date: item.date,
      time: item.time,
      estimatedMinutes: item.duration,
      dueDate: item.due || null,
      done: item.done
    }));
  return { today, items: relevant };
}

function appendAIInlineMarkdown(parent, text) {
  const tokenPattern = /\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
    }

    const [, boldA, boldB, code, italicA, italicB] = match;
    const node = document.createElement(boldA || boldB ? "strong" : code ? "code" : "em");
    node.textContent = boldA || boldB || code || italicA || italicB;
    parent.append(node);
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function renderAIMarkdown(element, markdown) {
  element.replaceChildren();
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  let paragraphLines = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const paragraph = document.createElement("p");
    paragraphLines.forEach((line, index) => {
      if (index) paragraph.append(document.createElement("br"));
      appendAIInlineMarkdown(paragraph, line);
    });
    element.append(paragraph);
    paragraphLines = [];
  };

  const flushList = () => {
    if (!list) return;
    element.append(list);
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const tagName = unordered ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tagName) {
        flushList();
        list = document.createElement(tagName);
      }
      const item = document.createElement("li");
      appendAIInlineMarkdown(item, (unordered || ordered)[1]);
      list.append(item);
      continue;
    }

    const boldHeading = line.match(/^\*\*(.+)\*\*$/);
    const markdownHeading = line.match(/^#{1,3}\s+(.+)$/);
    if (boldHeading || markdownHeading) {
      flushParagraph();
      flushList();
      const heading = document.createElement("h4");
      appendAIInlineMarkdown(heading, (boldHeading || markdownHeading)[1]);
      element.append(heading);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
}

function addAIMessage(role, text, extraClass = "") {
  const message = document.createElement("div");
  message.className = `ai-message ${role}${extraClass ? ` ${extraClass}` : ""}`;
  if (role === "assistant" && extraClass !== "loading") {
    renderAIMarkdown(message, text);
  } else {
    message.textContent = text;
  }
  $("aiMessages").append(message);
  $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
  return message;
}

$("aiToggle").addEventListener("click", () => {
  const panel = $("aiPanel");
  panel.hidden = !panel.hidden;
  $("aiToggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden && !$("aiMessages").childElementCount) {
    const greeting = auth.currentUser
      ? "你好！我可以依照今天的行程與近期任務，幫你整理優先順序或安排時間。"
      : "你好！登入後我就能依照你的行程與近期任務，幫你整理優先順序或安排時間。";
    addAIMessage("assistant", greeting);
  }
});
$("aiClose").addEventListener("click", () => {
  $("aiPanel").hidden = true;
  $("aiToggle").setAttribute("aria-expanded", "false");
});
$("aiInput").addEventListener("input", () => {
  $("aiSend").disabled = !$("aiInput").value.trim();
});
document.querySelectorAll("[data-ai-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    $("aiInput").value = button.dataset.aiPrompt;
    $("aiSend").disabled = false;
    $("aiInput").focus();
  });
});
$("aiForm").addEventListener("submit", async event => {
  event.preventDefault();
  const question = $("aiInput").value.trim();
  if (!question) return;
  addAIMessage("user", question);
  $("aiInput").value = "";
  $("aiSend").disabled = true;
  if (!auth.currentUser) {
    addAIMessage("assistant", "請先使用 Google 登入，再使用個人行程 AI 助理。");
    return;
  }
  if (!aiModel) {
    addAIMessage("assistant", aiSetupMessage || "AI 助理目前尚未完成設定。");
    return;
  }
  const loading = addAIMessage("assistant", "正在整理你的行程…", "loading");
  try {
    const context = buildScheduleContext();
    const prompt = [
      "你是個人行程與任務管理助理。請使用繁體中文，回答具體、簡潔，不要捏造行程或期限。",
      `今天日期：${context.today}`,
      `相關行程與任務（JSON）：${JSON.stringify(context.items)}`,
      `使用者問題：${question}`
    ].join("\n\n");
    const result = await aiModel.generateContent(prompt);
    renderAIMarkdown(loading, result.response.text() || "目前沒有可用的回覆，請換個方式提問。");
  } catch (error) {
    console.error("Firebase AI Logic request failed:", error);
    loading.textContent = "AI 暫時無法回覆。請確認 Firebase AI Logic 已啟用、App Check 網域與金鑰正確，或稍後再試。";
  } finally {
    loading.classList.remove("loading");
    $("aiSend").disabled = !$("aiInput").value.trim();
    $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
  }
});

try {
  await setPersistence(auth, browserLocalPersistence);
} catch (error) {
  console.error("Firebase auth persistence could not be set:", error);
}

onAuthStateChanged(auth, user => {
  updateProfile(user);
  const nextUid = user?.uid || null;
  if (nextUid !== lastAIUid) {
    $("aiMessages").replaceChildren();
    lastAIUid = nextUid;
  }
  if (!user) {
    resetToGuest();
    return;
  }
  if (user.uid === activeUid && (syncReady || loadingUid === user.uid)) return;
  activeUid = user.uid;
  void activateUserData(user.uid);
}, error => {
  console.error("Firebase auth state listener failed:", error);
  setSyncStatus("error", "登入狀態讀取失敗");
  toast("無法讀取登入狀態，請重新整理頁面");
});
$("signInBtn").disabled = false;
setupAI();
