const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzIAGI3xqdLJeOGHs8cgvLbMll5x82pc7clF_HTmQBQkc-5jbONBaq27NPZuaQAfuR_oA/exec';

// -------- STATE --------
let username = null;
let initData = '';
let serverState = { balance: 0, rate: 16, monthBase: 0, lockedAmount: 0, lockedAmountForWithdrawal: 0, availableBalance: 0, history: [], portfolio: [] };
let userPrefs = { currency: 'RUB', sbpMethods: [] };
let devMode = false;
let lastChosenRate = null;
let syncTimer = null;
let syncInFlight = false;
let syncBackoffMs = 20000;       // start 20s
const SYNC_BACKOFF_MAX = 60000;  // max 60s
let lastDepositAmount = 0;
let lastDepositShortId = null;
let hasPendingDeposit = false;

// Status: show loading/synced only once
let hasShownInitialStatus = false;

// Exchange rates and today income (in RUB) for instant recalculation
const exchangeRates = { RUB: 1, USD: 0.011, EUR: 0.010 };
let latestTodayIncomeRub = 0;

// History — pagination and filter
let historyOffset = 0;
// Withdraw: user explicitly chose "Add new credentials"
let withdrawAddingNew = false;
const HISTORY_PAGE_SIZE = 10;
let currentHistoryFilterType = 'all';
let filteredHistory = [];

// -------- HELPERS --------
const fmtMoney = (val, currency) => {
  const rate = exchangeRates[currency];
  const num = (Number(val) || 0) * rate;
  return num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function parseAmount(str) {
  if (!str) return 0;
  const s = String(str).replace(/\s/g, '').replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

// Suppress only this specific noise, not affecting other errors
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason && e.reason.message) || e.reason || '');
  if (msg.includes('A listener indicated an asynchronous response')) {
    e.preventDefault(); // do not log to console
  }
});

window.addEventListener('error', (e) => {
  const msg = String(e.message || '');
  if (msg.includes('A listener indicated an asynchronous response')) {
    e.stopImmediatePropagation();
  }
});

// formatting with decimal part preservation
function formatAmountInput(input) {
  let v = (input.value || '').replace(/[^\d.,]/g, '');
  // if multiple separators — keep first, remove others
  const firstSep = v.search(/[.,]/);
  if (firstSep !== -1) {
    const intPart = v.slice(0, firstSep).replace(/[.,]/g, '');
    const fracPartRaw = v.slice(firstSep + 1).replace(/[^\d]/g, '');
    const fracPart = fracPartRaw.slice(0, 2); // up to 2 digits
    input.value = formatIntWithSpaces(intPart) + ',' + fracPart;
  } else {
    input.value = formatIntWithSpaces(v.replace(/[.,]/g, ''));
  }
}
function formatIntWithSpaces(s) {
  if (!s) return '';
  const num = s.replace(/\D/g, '');
  return num.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function scheduleSync(delay = syncBackoffMs) {
  clearTimeout(syncTimer);
  const jitter = Math.floor(Math.random() * 3000);
  const next = Math.min(Math.max(delay, 5000), SYNC_BACKOFF_MAX); // 5s..60s
  syncTimer = setTimeout(() => syncBalance(true), next + jitter);
}
document.addEventListener('visibilitychange', () => {
  // return to tab — fast ping
  if (!document.hidden) scheduleSync(2000);
});

function showPopup(text, timeout = 3000) {
  const el = document.createElement('div');
  el.className = 'popup';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(10px)';
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

function setStatus(text, type = 'loading') {
  const el = document.getElementById('status');
  if (!el) return;

  // Show "loading/synced" only on first connection
  if ((type === 'loading' || type === 'synced') && hasShownInitialStatus) return;

  el.textContent = text;
  el.className = `status ${type} show`;

  if (type === 'error') {
    setTimeout(() => el.classList.remove('show'), 3000);
  } else if (type === 'synced') {
    setTimeout(() => el.classList.remove('show'), 1500);
    hasShownInitialStatus = true;
  }
}

function computeHasPendingDeposit() {
  const h = serverState.history || [];
  return h.some(x => x.type === 'DEPOSIT' && x.status === 'PENDING');
}
function showDepositStep(step) {
  const s1 = document.getElementById('deposit-step1');
  const s2 = document.getElementById('deposit-step2');
  if (!s1 || !s2) return;
  if (step === 1) { s1.style.display = 'block'; s2.style.display = 'none'; }
  else { s1.style.display = 'none'; s2.style.display = 'block'; }
}
// Deposit: toggle agreement controls button availability
function updateDepositBtnState() {
  const agree = document.getElementById('depositAgree');
  const amountEl = document.getElementById('depositAmount');
  const amount = Math.round(parseAmount(amountEl.value) * 100) / 100; // round to 2 decimal places
  const btn = document.getElementById('depositConfirmBtn');
  if (btn) btn.disabled = !(agree && agree.checked) || amount < 100 || amount > 10000000;
}


// -------- NAV & MODALS --------
function openPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page${pageId}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active');
    if (n.onclick.toString().includes(`'${pageId}'`)) n.classList.add('active');
  });
}
// NEW: close all modals before opening new one
function closeAllModals() {
  document.querySelectorAll('.modal-overlay.active').forEach(m => {
    m.classList.remove('active');
    m.style.display = '';
  });
  document.body.classList.remove('modal-open');
}

function openModal(modalId) {
  // NEW: extinguish all old modals
  closeAllModals();

  const modal = document.getElementById(`modal${modalId.charAt(0).toUpperCase() + modalId.slice(1)}`);
  if (!modal) return;
  modal.classList.add('active');
  modal.style.display = 'flex';          // NEW: ensure shown
  document.body.classList.add('modal-open');

        // Special logic for "Withdraw"
 if (modalId === 'withdraw') {
   // New entry into modal — forget previous "Add new credentials"
   withdrawAddingNew = false;

   const methodChoice = document.getElementById('withdraw-method-choice');
   const addForm      = document.getElementById('withdraw-add-sbp-form');
   const view         = document.getElementById('withdraw-view');
   const sel          = document.getElementById('withdraw-recipient-select');

   // Standard behavior:
   // - if saved credentials exist → immediately withdrawal screen;
   // - if none → method selection screen.
   const hasMethods = (userPrefs.sbpMethods || []).length > 0;

   if (hasMethods) {
     if (methodChoice) methodChoice.style.display = 'none';
     if (addForm)      addForm.style.display      = 'none';
     if (view)         view.style.display         = 'block';
     if (sel) {
       // just in case choose first real credential (not "add_new")
       if (sel.value === 'add_new' || sel.selectedIndex < 0) sel.selectedIndex = 0;
     }
     // Ensure trigger shows first credential, not "Add new"
     const trigger = document.getElementById('select-trigger');
     if (trigger && userPrefs.sbpMethods && userPrefs.sbpMethods.length > 0) {
       const first = userPrefs.sbpMethods[0];
       trigger.textContent = `SBP: ${first.phone} (${first.bank})`;
       trigger.dataset.index = 0;
     }
     setTimeout(updateWithdrawBtnState, 0);
   } else {
     if (methodChoice) methodChoice.style.display = 'block';
     if (addForm)      addForm.style.display      = 'none';
     if (view)         view.style.display         = 'none';
     if (sel) sel.selectedIndex = -1; // nothing selected
   }

   // scroll to top in case of previous scrolling
   const modalEl = document.getElementById('modalWithdraw');
   const inner   = modalEl && modalEl.querySelector('.modal');
   if (inner) inner.scrollTop = 0;

   // Ensure stat text is resized after modal opens
   setTimeout(fitStatText, 0);
 }
 if (modalId === 'deposit') {
   // Update history to check for pending deposits
   apiGet('?action=getHistory&username=' + encodeURIComponent(username))
     .then(data => {
       if (data.success && data.history) {
         serverState.history = data.history;
         hasPendingDeposit = computeHasPendingDeposit();
         if (hasPendingDeposit) {
           // try to take from history the last PENDING deposit
           const pending = (serverState.history || [])
             .filter(x => x.type === 'DEPOSIT' && x.status === 'PENDING')
             .sort((a,b) => b.date - a.date)[0];
           const amt = pending ? Math.abs(Number(pending.amount||0)) : lastDepositAmount;
           const sid = pending ? pending.shortId : lastDepositShortId;
           hydrateDepositStep2(amt || 0, sid || null);
         }
         showDepositStep(hasPendingDeposit ? 2 : 1);
       }
     })
     .catch(() => {
       showDepositStep(hasPendingDeposit ? 2 : 1);
     });
   // synchronize button once on entry
   setTimeout(updateDepositBtnState, 0);
 }
}

function closeModal(modalId) {
  const modal = document.getElementById(`modal${modalId.charAt(0).toUpperCase() + modalId.slice(1)}`);
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = ''; // NEW
  }
  if (modalId === 'withdraw') withdrawAddingNew = false;
  const anyOpen = Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.classList.contains('active'));
  if (!anyOpen) document.body.classList.remove('modal-open');
}

// -------- BALANCE AUTOSIZE --------
function fitBalanceText() {
   const el = document.getElementById('balanceValue');
   if (!el) return;
   const max = 42, min = 18;
   el.style.fontSize = max + 'px';
   const limit = el.parentElement ? el.parentElement.clientWidth - 24 : el.clientWidth;
   let size = max, safety = 50;
   while (el.scrollWidth > limit && size > min && safety-- > 0) {
      size -= 1;
      el.style.fontSize = size + 'px';
   }
}
window.addEventListener('resize', fitBalanceText);

// -------- STAT VALUES AUTOSIZE --------
function fitStatText() {
    const statIds = ['freeBalance', 'investedBalance', 'withdrawAvailable', 'todayIncome'];
    const max = 20, min = 14;
    let commonSize = max;

    // First pass: find the smallest size that fits all
    statIds.forEach(id => {
       const el = document.getElementById(id);
       if (!el) return;
       el.style.fontSize = max + 'px';
       const limit = el.parentElement ? el.parentElement.clientWidth - 24 : el.clientWidth;
       let size = max, safety = 50;
       while (el.scrollWidth > limit && size > min && safety-- > 0) {
          size -= 1;
       }
       if (size < commonSize) commonSize = size;
    });

    // Second pass: apply the common size to all
    statIds.forEach(id => {
       const el = document.getElementById(id);
       if (el) el.style.fontSize = commonSize + 'px';
    });
 }
window.addEventListener('resize', fitStatText);

// -------- RENDER --------
function updateDashboard(data) {
  serverState = { ...serverState, ...data };
  const { balance, monthBase, lockedAmount, availableBalance } = serverState;
  const currency = userPrefs.currency;
  const currencySymbol = currency === 'RUB' ? '₽' : (currency === 'USD' ? '$' : '€');

  document.getElementById('balanceValue').textContent = `${fmtMoney(balance, currency)} ${currencySymbol}`;
  document.getElementById('freeBalance').innerHTML = `${fmtMoney(balance - lockedAmount, currency)} <span class="cur-sym">${currencySymbol}</span>`;
  document.getElementById('investedBalance').innerHTML = `${fmtMoney(monthBase, currency)} <span class="cur-sym">${currencySymbol}</span>`;
  document.getElementById('profileUsername').textContent = username || 'User';
  document.getElementById('withdrawAvailable').innerHTML = `${fmtMoney(availableBalance || (balance - (serverState.lockedAmountForWithdrawal || 0)), currency)} <span class="cur-sym">${currencySymbol}</span>`;
  document.getElementById('investAvailable').innerHTML = `${fmtMoney(balance - lockedAmount, currency)} ${currencySymbol}`;

  // Today income — instant under selected currency
  renderTodayIncome();


  fitBalanceText();
  fitStatText();
}
function renderTodayIncome() {
  const currency = userPrefs.currency;
  const symbol = currency === 'RUB' ? '₽' : (currency === 'USD' ? '$' : '€');
  const el = document.getElementById('todayIncome');
  if (el) el.innerHTML = `+${fmtMoney(latestTodayIncomeRub, currency)} <span class="cur-sym">${symbol}</span>`;
}
function getHistoryFilterPredicate(type) {
  if (!type || type === 'all') return () => true;
  const map = { deposit: 'DEPOSIT', withdraw: 'WITHDRAW', invest: 'INVEST' };
  const wanted = map[type] || null;
  return (item) => !wanted || (item.type === wanted);
}

function recomputeFilteredHistory() {
  const pred = getHistoryFilterPredicate(currentHistoryFilterType);
  filteredHistory = (serverState.history || []).filter(pred);
}

function renderHistoryPage(append = false) {
  const list = document.getElementById('history-list');
  const placeholder = document.getElementById('history-placeholder');
  const loadMoreBtn = document.getElementById('load-more-history');

  if (!append) {
    historyOffset = 0;
    list.innerHTML = '';
  }

  const slice = filteredHistory.slice(historyOffset, historyOffset + HISTORY_PAGE_SIZE);

  if (!append && filteredHistory.length === 0) {
    placeholder.style.display = 'block';
    loadMoreBtn.style.display = 'none';
    return;
  }
  placeholder.style.display = 'none';

  const currency = userPrefs.currency;
  const currencySymbol = currency === 'RUB' ? '₽' : (currency === 'USD' ? '$' : '€');

  slice.forEach(item => {
    const el = document.createElement('div');
    el.className = `glass-card history-item status-${item.status.toLowerCase()}`;

    const date = new Date(item.date);
    const timeStr = `${String(date.getDate()).padStart(2,'0')}.${String(date.getMonth()+1).padStart(2,'0')}.${String(date.getFullYear()).slice(-2)} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;

    const absAmount = Math.abs(item.amount);
    let title = '', amountStr = '', subTitle = '';

    switch(item.type) {
      case 'DEPOSIT':  title = 'Депозит';    amountStr = `+${fmtMoney(absAmount, currency)}`; break;
      case 'WITHDRAW': title = 'Вывод';      amountStr = `-${fmtMoney(absAmount, currency)}`; break;
      case 'INVEST':
        title = 'Инвестиция';
        amountStr = `${fmtMoney(absAmount, currency)}`;
        subTitle = `<div style="font-size:12px;color:var(--text-secondary);">Стратегия: ${item.rate}%</div>`;
        break;
    }

    const uid = devMode ? ` · #${item.shortId}` : '';
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div><b>${title}</b>${subTitle}<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${timeStr}${uid}</div></div>
      <div style="font-weight:700;font-size:16px;text-align:right;">${amountStr} ${currencySymbol}</div>
    </div>`;
    list.appendChild(el);
  });

  historyOffset += slice.length;
  loadMoreBtn.style.display = historyOffset < filteredHistory.length ? 'block' : 'none';
}

function applyHistoryFilter(element, type) {
  if (type) currentHistoryFilterType = type;
  if (element) {
    document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.remove('active'));
    element.classList.add('active');
  }
  recomputeFilteredHistory();
  renderHistoryPage(false);
}

function renderPortfolio(portfolio) {
  const list = document.getElementById('portfolio-list');
  const placeholder = document.getElementById('portfolio-placeholder');
  list.innerHTML = '';
  if (!portfolio || portfolio.length === 0) { placeholder.style.display = 'block'; return; }
  placeholder.style.display = 'none';

  const currency = userPrefs.currency;
  const currencySymbol = currency === 'RUB' ? '₽' : (currency === 'USD' ? '$' : '€');

  portfolio.forEach(item => {
    const el = document.createElement('div');
    el.className = 'glass-card';
    const uid = devMode ? `<b>#${item.shortId}</b> · ` : '';
    el.innerHTML = `${uid}${fmtMoney(item.amount, currency)} ${currencySymbol} · <b>${item.rate}%</b>`;
    list.appendChild(el);
  });
}

// -------- API --------
async function apiGet(path) {
   try {
     const separator = path.includes('?') ? '&' : '?';
     const fullPath = initData ? `${path}${separator}initData=${encodeURIComponent(initData)}` : path;
     const r = await fetch(`${SCRIPT_URL}${fullPath}`);
     if (!r.ok) throw new Error(`Network error: ${r.statusText}`);
     const data = await r.json();
     if (!data) throw new Error("Empty response from server");
     return data;
   } catch (e) {
     console.error("API Fetch Error:", e);
     return { success: false, error: e.message };
   }
}

async function initializeApp() {
  try {
    // Fullscreen loader and start progress
    startBootScreen();
    setBootProgress(10);

    // Telegram init + username
    const tg = window.Telegram?.WebApp;
    tg?.expand?.();
    username = (tg?.initDataUnsafe?.user?.username) || 'marulin';
    initData = tg?.initData || '';

    setBootProgress(25);

    // Initial data from backend
    const data = await apiGet(`?action=getInitialData&username=${encodeURIComponent(username)}`);
    if (!data || !data.success) {
      const errorMsg = data?.error ? (typeof data.error === 'string' ? data.error : 'Server error') : 'Failed to get initial data';
      console.error('Backend error:', errorMsg);
      throw new Error('Failed to get initial data');
    }

    // Apply settings/state
    userPrefs = data.userPrefs || { currency: 'RUB', sbpMethods: [] };
    devMode = localStorage.getItem('devMode') === 'true';
    const devToggle = document.getElementById('devModeToggle');
    if (devToggle) devToggle.checked = devMode;
    const dv = document.getElementById('devVersion');
  if (dv) dv.style.display = devMode ? 'block' : 'none';


    serverState = { ...serverState, ...data };
    // Ensure all required fields are present
    if (!serverState.balance) serverState.balance = 0;
    if (!serverState.rate) serverState.rate = 16;
    if (!serverState.monthBase) serverState.monthBase = 0;
    if (!serverState.lockedAmount) serverState.lockedAmount = 0;
    if (!serverState.lockedAmountForWithdrawal) serverState.lockedAmountForWithdrawal = 0;
    if (!serverState.availableBalance) serverState.availableBalance = serverState.balance - serverState.lockedAmountForWithdrawal;
    if (!serverState.history) serverState.history = [];
    if (!serverState.portfolio) serverState.portfolio = [];
    hasPendingDeposit = computeHasPendingDeposit();

    // Redraw main screens
    setBootProgress(60);
    updateDashboard(serverState);
    recomputeFilteredHistory();
    renderHistoryPage(false);
    renderPortfolio(serverState.portfolio);

    // Today income + withdrawal UI
    setBootProgress(80);
    await refreshTodayIncome();
    updateWithdrawUI();

    // Finalization
    setBootProgress(95);
    scheduleSync(2000); // start poller
    finishBootScreen(); // title "flies away", overlay disappears
  } catch (e) {
    console.error('Initialization error:', e.message, e.stack);
    finishBootScreen();                 // even on error remove overlay
    setStatus('Error: Failed to initialize app', 'error'); // popup only for errors
  }
}

// Updates balance + "Today income"; additionally tracks completion of PENDING deposit
async function syncBalance(fromScheduler = false) {
  console.log('Frontend syncBalance start', new Date().toISOString());
  // do not launch parallel cycles
  if (syncInFlight) { if (fromScheduler) scheduleSync(); return; }
  syncInFlight = true;

  try {
    // if PENDING deposit exists — pull full slice (including history), otherwise — light requests
    let data = null;
    if (hasPendingDeposit) {
      // one request returns balance, history, prefs
      const full = await apiGet(`?action=getInitialData&username=${encodeURIComponent(username)}`);
      if (full && full.success) {
        data = full;
        serverState = { ...serverState, ...full };
        updateDashboard(serverState);
        recomputeFilteredHistory();
        renderHistoryPage(false);
        renderPortfolio(serverState.portfolio);
      }
    } else {
      // fast path: balance + income
      const [balRes, accrRes] = await Promise.allSettled([
        apiGet(`?action=syncBalance&username=${encodeURIComponent(username)}`),
        apiGet(`?action=previewAccrual&username=${encodeURIComponent(username)}`)
      ]);
      if (balRes.status === 'fulfilled' && balRes.value && balRes.value.success) {
        data = balRes.value;
        serverState = { ...serverState, ...balRes.value };
        updateDashboard(serverState);
      }
      if (accrRes.status === 'fulfilled' && accrRes.value && accrRes.value.success) {
        latestTodayIncomeRub = Number(accrRes.value.accruedToday || 0);
      }
  renderTodayIncome();
     }

     // === AFTER updating data: check deposit status transition ===
     const before = hasPendingDeposit;
     const now = computeHasPendingDeposit();
     hasPendingDeposit = now; // synchronize flag

     // Only show completion message for deposits with final status (APPROVED/REJECTED/CANCELED)
     if (before && !now) {
       const last = (serverState.history || [])
         .filter(x => x.type === 'DEPOSIT')
         .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

       if (last && (last.status === 'APPROVED' || last.status === 'REJECTED' || last.status === 'CANCELED')) {
         const msg = last.status === 'APPROVED'
           ? 'Средства зачислены на счёт'
           : 'Депозит не удался';
         closeDepositFlowWithPopup(msg);
       }
       // Don't show "Операция завершена" for PENDING deposits that disappeared from history
     }

     // successful cycle — soft interval
     syncBackoffMs = 20000;
     console.log('Frontend syncBalance response', data, new Date().toISOString());

  } catch (e) {
    // network/error — increase interval, but not more than 60s
    syncBackoffMs = Math.min((syncBackoffMs || 20000) * 2, 60000);
  } finally {
    syncInFlight = false;
    if (fromScheduler) scheduleSync(); // plan next entry
  }
}

async function cancelDeposit() {
  try {
    const r = await apiGet(`?action=cancelPendingDeposit&username=${username}`);
    if (r && r.success) {
      hasPendingDeposit = false;
      showPopup('Депозит отменён');
      showDepositStep(1);
      initializeApp();
    } else {
      showPopup('Не удалось отменить депозит');
    }
  } catch {
    showPopup('Ошибка сети');
  }
}

// Update "Today income" — without using `res` name
async function refreshTodayIncome() {
  let accrued = latestTodayIncomeRub; // default value — what was
  try {
    const r = await apiGet(`?action=previewAccrual&username=${encodeURIComponent(username)}`);
    if (r && r.success) {
      accrued = Number(r.accruedToday || 0);
    }
  } catch (e) {
    console.debug('refreshTodayIncome error:', e);
  } finally {
    latestTodayIncomeRub = accrued;
    renderTodayIncome();
  }
}

// -------- EVENTS --------
function setupEventListeners() {
  const $id = (x) => document.getElementById(x);
  const onIf = (el, ev, fn, opts) => { if (el) el.addEventListener(ev, fn, opts); };

  // Click on modal background — close. Close currency dropdown and custom select.
  document.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.classList && target.classList.contains('modal-overlay')) {
          closeAllModals();
      }
    const anyOpen = Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.classList.contains('active'));
    if (!anyOpen) document.body.classList.remove('modal-open');

    const currencyDropdown = $id('currencyDropdown');
    const currencyToggler  = document.querySelector('.balance-currency');
    if (currencyDropdown && currencyToggler && !currencyDropdown.contains(target) && !currencyToggler.contains(target)) {
      currencyDropdown.classList.remove('open');
    }

    // Close custom select if click outside
    const customSelect = $id('withdraw-recipient-select');
    if (customSelect && !customSelect.contains(target)) {
      closeCustomSelect();
    }
  });
  // React to change only of specific toggle
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'depositAgree') updateDepositBtnState();
  });
  // (IMPORTANT) on modal open call setTimeout(updateDepositBtnState, 0) in openModal('deposit')

  // Custom select events
  const selectBtn = $id('select-btn');
  onIf(selectBtn, 'click', (e) => {
    e.stopPropagation();
    toggleCustomSelect();
  });

  const selectOptions = document.querySelectorAll('#withdraw-recipient-select .select-options li');
  selectOptions.forEach(li => {
    onIf(li, 'click', (e) => {
      e.stopPropagation();
      selectCustomOption(li);
    });
  });

  // Dev mode
  onIf(document.getElementById('devModeToggle'), 'change', function () {
  devMode = this.checked;
  localStorage.setItem('devMode', devMode);
  const dv = document.getElementById('devVersion');
  if (dv) dv.style.display = devMode ? 'block' : 'none';
  renderHistoryPage(false);
  renderPortfolio(serverState.portfolio);
});


  // Deposit — create request
  onIf($id('depositConfirmBtn'), 'click', async function () {
    const amountEl = $id('depositAmount');
    const amount = amountEl ? Math.round(parseAmount(amountEl.value) * 100) / 100 : 0;

    if (amount < 100) {
      showPopup('Минимальная сумма депозита: 100 ₽');
      return;
    }
    if (amount > 10000000) {
      showPopup('Максимальная сумма депозита: 10 000 000 ₽');
      return;
    }

    this.disabled = true;

    try {
      const resp = await apiGet(
        `?action=requestDeposit&username=${encodeURIComponent(username)}&amount=${encodeURIComponent(amount)}`
      );

      if (resp && resp.success) {
        showPopup('Запрос на депозит отправлен!');
        hasPendingDeposit = true;
        lastDepositAmount = amount;
  lastDepositShortId = resp && (resp.shortId || resp.requestShortId) || null;
// Clean amount for display value, but keep for copy
const cleanAmount = lastDepositAmount.toString().replace(/[^\d]/g, '');
amountEl.value = cleanAmount; // Set clean number to value for copying, but display formatted elsewhere if needed
hydrateDepositStep2(lastDepositAmount, lastDepositShortId);
showDepositStep(2); // lock instructions screen
initializeApp();    // pull history/balance
      } else {
        showPopup('Error: ' + ((resp && resp.error) || 'unknown'));
      }
    } catch (e) {
      showPopup('Ошибка сети.');
    } finally {
      this.disabled = false;
    }
  });

  // Withdraw — bank selection (icons)
  document.querySelectorAll('.bank-icon').forEach((icon) => {
    icon.addEventListener('click', () => {
      document.querySelectorAll('.bank-icon').forEach(i => i.classList.remove('selected'));
      icon.classList.add('selected');
    });
  });

  // Withdraw — save SBP credentials
  onIf($id('save-sbp-btn'), 'click', async function () {
    const phoneEl = $id('withdraw-sbp-phone');
    const phone = phoneEl ? phoneEl.value : '';
    const selectedBankEl = document.querySelector('.bank-icon.selected');
    if (!phone || !selectedBankEl) { showPopup('Please enter phone and select bank.'); return; }
    const bank = selectedBankEl.dataset.bank;
    userPrefs.sbpMethods = userPrefs.sbpMethods || [];
    userPrefs.sbpMethods.unshift({ phone, bank });

    this.disabled = true;
    try {
      const resp = await apiGet(`?action=saveUserPrefs&username=${encodeURIComponent(username)}&prefs=${encodeURIComponent(JSON.stringify(userPrefs))}`);
      if (resp && resp.success) {
        userPrefs = resp.savedPrefs;
        withdrawAddingNew = false; // <-- reset, credentials added
        updateWithdrawUI();
      } else {
        showPopup('Failed to save credentials.');
      }
    } catch (e) {
      showPopup('Network error.');
    } finally { this.disabled = false; }
  });

  // Custom select for withdrawal
  onIf($id('select-trigger'), 'click', function(e) {
    e.stopPropagation();
    toggleCustomSelect();
  });

  // Close custom select on outside click (already handled in general click listener)

  // Withdraw — create request
  onIf($id('withdrawConfirmBtn'), 'click', async function () {
    const amountEl = $id('withdrawAmount');
    const trigger = $id('select-trigger');
    const amount = amountEl ? Math.round(parseAmount(amountEl.value) * 100) / 100 : 0;
    const idx = trigger ? parseInt(trigger.dataset.index) : -1;
    const recipient = idx >= 0 ? (userPrefs.sbpMethods || [])[idx] : null;
    const available = (serverState.balance || 0) - (serverState.lockedAmount || 0);

    if (amount <= 0) { showPopup('Введите сумму.'); return; }
    if (amount > available) { showPopup('Недостаточно свободных средств.'); return; }
    if (!recipient) { showPopup('Выберите реквизиты для вывода.'); return; }

    this.disabled = true;
    try {
      const details = JSON.stringify({ method: 'sbp', phone: recipient.phone, bank: recipient.bank });
      const resp = await apiGet(`?action=requestWithdraw&username=${encodeURIComponent(username)}&amount=${encodeURIComponent(amount)}&details=${encodeURIComponent(details)}`);
      if (resp && resp.success) {
        showPopup('Запрос на вывод отправлен!');
        closeModal('withdraw');
        initializeApp();
      } else {
        showPopup('Ошибка: ' + ((resp && resp.error) || 'неизвестна'));
      }
    } catch (e) {
      showPopup('Ошибка сети.');
    } finally {
      this.disabled = false;
    }
  });

  // New Investment — confirm
  onIf($id('niConfirmBtn'), 'click', async function () {
    const amountEl = $id('niAmount');
    const amount = amountEl ? Math.round(parseAmount(amountEl.value) * 100) / 100 : 0;
    const rate = lastChosenRate;
    if (!rate || amount <= 0) { showPopup('Enter correct amount.'); return; }
    const availableText = document.getElementById('investAvailable').textContent;
    const available = parseAmount(availableText.replace(/[^\d.,]/g, ''));
    if (amount > available) { showPopup('Недостаточно средств для инвестирования.'); return; }
    this.disabled = true;
    try {
      const resp = await apiGet(`?action=logStrategyInvestment&username=${encodeURIComponent(username)}&rate=${encodeURIComponent(rate)}&amount=${encodeURIComponent(amount)}`);
      if (resp && resp.success) {
        showPopup('Инвестиция создана!');
        closeModal('newInvestment');
        initializeApp();
      } else {
        showPopup('Ошибка: ' + ((resp && resp.error) || 'неизвестна'));
      }
    } catch (e) {
      showPopup('Ошибка сети');
    } finally {
      this.disabled = false;
    }
  });

  // History — "Load more"
  onIf($id('load-more-history'), 'click', () => {
    renderHistoryPage(true);
  });
}

// -------- UI UTILS --------
// Boot screen helpers
const BOOT_HINTS = [
  'Ищем лучшие инвестиционные инструменты',
  'Танцуем с бубном',
  'Оптимизируем процентные ставки',
  'Увеличиваем прибыльность до бесконечности',
  'Находим ключ, чтобы впустить тебя',
  'Аккуратно переводим твои средства на депозит',
];

let bootHintsPicked = [];
let bootProgressTarget = 0, bootProgressTimer = null;

function startBootScreen() {
  const el = document.getElementById('boot-screen');
  if (!el) return;
  el.classList.remove('hidden');
  bootHintsPicked = pickTwoHints_();
  setBootHint(bootHintsPicked[0]);
  setBootProgress(5);
}
function pickTwoHints_() {
  const arr = [...BOOT_HINTS];
  const a = arr.splice(Math.floor(Math.random()*arr.length),1)[0];
  const b = arr[Math.floor(Math.random()*arr.length)];
  return [a,b];
}
function setBootHint(text) {
  const h = document.getElementById('boot-hint');
  if (h) {
    h.style.opacity = '0';
    setTimeout(() => {
      h.textContent = text;
      h.style.opacity = '1';
    }, 250);
  }
}
function setBootProgress(p) {
  // simulate gradual loading — smoothly catch up to target
  bootProgressTarget = Math.max(0, Math.min(100, p));
  const fill = document.getElementById('boot-progress-fill');
  if (!fill) return;
  clearInterval(bootProgressTimer);
  bootProgressTimer = setInterval(() => {
    const cur = parseFloat(fill.style.width||'0');
    const step = Math.max(0.8, (bootProgressTarget - cur) * 0.25); // easing
    const next = Math.min(bootProgressTarget, cur + step);
    fill.style.width = next + '%';
    // switch phrase roughly in the middle
    if (next > 55 && bootHintsPicked[1]) {
      setBootHint(bootHintsPicked[1]);
      bootHintsPicked[1] = null;
    }
    if (Math.abs(next - bootProgressTarget) < 0.5) {
      fill.style.width = bootProgressTarget + '%';
      clearInterval(bootProgressTimer);
    }
  }, 80);
}
function finishBootScreen() {
  const overlay = document.getElementById('boot-screen');
  const title = document.getElementById('boot-title');
  const target = document.getElementById('appBrand');

  setBootProgress(100);

  if (overlay && title && target) {
    // Instant hide for title
    title.style.opacity = '0';

    // Show target title immediately
    target.style.opacity = '1';

    // Hide overlay immediately
    overlay.classList.add('hidden');
  } else if (overlay) {
    // Fallback
    overlay.classList.add('hidden');
  }
}
// Redefine setStatus: use only for errors
function setStatus(text, type = 'error') {
  if (type === 'error') {
    // show existing popup notification
    showPopup(text || 'Error', 3000);
  }
  // loading/synced ignored here — boot screen handles it
}

function setDepositAmount(amount) {
  const input = document.getElementById('depositAmount');
  input.value = amount;
  formatAmountInput(input);
  updateDepositBtnState();
}
function hydrateDepositStep2(amountRub, shortId) {
  const currency = userPrefs.currency;
  const currencySymbol = currency === 'RUB' ? '₽' : (currency === 'USD' ? '$' : '€');

  const amountEl = document.getElementById('deposit-amount-display');
  const codeEl = document.getElementById('deposit-short-display');
  if (amountEl) amountEl.value = `${fmtMoney(amountRub, currency)} ${currencySymbol}`;
  if (codeEl) codeEl.value = shortId ? `#${shortId}` : '—';

  // Hide the loading spinner after showing step 2
  const spinner = document.querySelector('.spinner-big');
  if (spinner) spinner.style.display = 'none';
}

function closeDepositFlowWithPopup(msg) {
  closeModal('deposit');    // close modal
  openPage('Home');         // go to Home
  showPopup(msg, 3500);     // show notification
}

function selectWithdrawMethod(method) {
  // if came here after "Add new credentials" — lead to addition form
  if (withdrawAddingNew && method === 'sbp') {
    showAddRecipientForm('sbp');
    return;
  }

  if (method === 'sbp') {
    const has = (userPrefs.sbpMethods || []).length > 0;
    if (has) {
      // immediately to withdrawal form with dropdown list
      document.getElementById('withdraw-method-choice').style.display = 'none';
      document.getElementById('withdraw-add-sbp-form').style.display = 'none';
      document.getElementById('withdraw-view').style.display = 'block';
      const sel = document.getElementById('withdraw-recipient-select');
      if (sel) sel.selectedIndex = Math.max(0, sel.selectedIndex); // just in case
    } else {
      showAddRecipientForm('sbp');
    }
  }

  // TODO: if add crypto/bank — logic by analogy
}

function toggleCurrencyDropdown(event) {
  event.stopPropagation();
  document.getElementById('currencyDropdown').classList.toggle('open');
}

async function selectCurrency(currency, event) {
  event.stopPropagation();
  userPrefs.currency = currency;
  document.getElementById('currentCurrency').textContent = currency;
  document.querySelectorAll('.currency-option').forEach(opt => opt.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('currencyDropdown').classList.remove('open');

  updateDashboard(serverState);
  recomputeFilteredHistory();
  renderHistoryPage(false);
  renderPortfolio(serverState.portfolio);

  await apiGet(`?action=saveUserPrefs&username=${username}&prefs=${encodeURIComponent(JSON.stringify(userPrefs))}`);
}

function openNewInvestment(rate) {
  lastChosenRate = rate;
  const names = { 16: 'Liquid', 17: 'Stable', 18: 'Aggressive' };
  const name = names[rate] || `Strategy ${rate}%`;
  document.getElementById('niStrategyReadonly').textContent = name;
  document.getElementById('niAmount').value = '';
  // NEW: close any modals before opening "New Investment"
  closeAllModals();
  openModal('newInvestment');
  setTimeout(updateInvestButtonState, 0);
}

function updateInvestButtonState() {
  const amountEl = document.getElementById('niAmount');
  const btn = document.getElementById('niConfirmBtn');
  const amount = Math.round(parseAmount(amountEl.value) * 100) / 100; // round to 2 decimal places
  const available = Math.round(((serverState.balance || 0) - (serverState.lockedAmount || 0)) * 100) / 100;
  btn.disabled = amount <= 0 || amount > available;
}

function updateWithdrawBtnState() {
  const amountEl = document.getElementById('withdrawAmount');
  const trigger = document.getElementById('select-trigger');
  const btn = document.getElementById('withdrawConfirmBtn');
  const amount = Math.round(parseAmount(amountEl.value) * 100) / 100; // round to 2 decimal places
  const idx = trigger ? parseInt(trigger.dataset.index) : -1;
  const recipient = idx >= 0 ? (userPrefs.sbpMethods || [])[idx] : null;
  const available = serverState.availableBalance || Math.round(((serverState.balance || 0) - (serverState.lockedAmountForWithdrawal || 0)) * 100) / 100;
  btn.disabled = amount <= 0 || amount > available || !recipient;
}


function showAddRecipientForm(method) {
  if (method !== 'sbp') return;
  document.getElementById('withdraw-method-choice').style.display = 'none';
  document.getElementById('withdraw-add-sbp-form').style.display = 'block';
  const phoneInput = document.getElementById('withdraw-sbp-phone');
  if (phoneInput) phoneInput.focus();
  document.querySelectorAll('.bank-icon').forEach(i => i.classList.remove('selected'));
}

function updateWithdrawUI() {
  const optionsContainer = document.getElementById('select-options');
  const trigger = document.getElementById('select-trigger');
  if (!optionsContainer || !trigger) return;

  optionsContainer.innerHTML = '';
  trigger.textContent = 'Select credentials';

  if (userPrefs.sbpMethods && userPrefs.sbpMethods.length > 0) {
    userPrefs.sbpMethods.forEach((method, index) => {
      const option = document.createElement('div');
      option.className = 'select-option';
      option.dataset.index = index;
      option.textContent = `SBP: ${method.phone} (${method.bank})`;
      option.onclick = () => selectCustomOption(option);
      optionsContainer.appendChild(option);
    });
    const addNewOption = document.createElement('div');
    addNewOption.className = 'select-option add-new';
    addNewOption.dataset.value = 'add_new';
    addNewOption.textContent = '+ Add new credentials';
    addNewOption.onclick = () => selectCustomOption(addNewOption);
    optionsContainer.appendChild(addNewOption);

    document.getElementById('withdraw-view').style.display = 'block';
    document.getElementById('withdraw-method-choice').style.display = 'none';
    document.getElementById('withdraw-add-sbp-form').style.display = 'none';

  } else {
    document.getElementById('withdraw-view').style.display = 'none';
    document.getElementById('withdraw-method-choice').style.display = 'block';
    document.getElementById('withdraw-add-sbp-form').style.display = 'none';
  }
}

function toggleCustomSelect() {
  const container = document.getElementById('withdraw-recipient-select');
  const options = document.getElementById('select-options');
  const trigger = document.getElementById('select-trigger');
  if (!container || !options || !trigger) return;

  const isActive = options.classList.contains('active');
  closeCustomSelect(); // Close others if open
  if (!isActive) {
    options.classList.add('active');
    trigger.classList.add('active');
    container.classList.add('active');
  }
}

function selectCustomOption(option) {
  const container = document.getElementById('withdraw-recipient-select');
  const trigger = document.getElementById('select-trigger');
  const options = document.getElementById('select-options');
  if (!container || !trigger || !options) return;

  // Update trigger text
  trigger.textContent = option.textContent;
  trigger.dataset.value = option.dataset.value || option.dataset.index;
  trigger.dataset.index = option.dataset.index || -1;

  // Close dropdown
  options.classList.remove('active');
  trigger.classList.remove('active');
  container.classList.remove('active');

  // Handle add new
  if (option.dataset.value === 'add_new') {
    withdrawAddingNew = true;
    document.getElementById('withdraw-view').style.display = 'none';
    document.getElementById('withdraw-method-choice').style.display = 'block';
    document.getElementById('withdraw-add-sbp-form').style.display = 'none';
  } else {
    updateWithdrawBtnState();
  }
}

function closeCustomSelect() {
  const options = document.getElementById('select-options');
  const trigger = document.getElementById('select-trigger');
  const container = document.getElementById('withdraw-recipient-select');
  if (options) options.classList.remove('active');
  if (trigger) trigger.classList.remove('active');
  if (container) container.classList.remove('active');
}


// Update general click listener to close custom select
// Already handled in document.click, but ensure closeCustomSelect() is called there

// Reliable copying + change icon to checkmark for 2 sec
async function copyToClipboard(text, btnEl) {
  const inTG = !!(window.Telegram && window.Telegram.WebApp); // key line

  const ok = await (async () => {
    try {
      if (!inTG && navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true; // here previously threw violation — now not called at all in TG
      }
      throw new Error();
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.left='-9999px';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, ta.value.length);
        const res = document.execCommand('copy'); document.body.removeChild(ta);
        return res;
      } catch { return false; }
    }
  })();

  if (ok) {
    if (btnEl) {
      if (!btnEl.dataset.orig) btnEl.dataset.orig = btnEl.innerHTML;
      btnEl.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
      btnEl.blur(); // Remove focus to prevent stuck state
      setTimeout(() => { btnEl.innerHTML = btnEl.dataset.orig; }, 2000);
    }
    let msg = 'Скопировано';
    if (text.includes('₽') || text.includes('$') || text.includes('€')) msg = 'Сумма скопирована';
    else if (text.startsWith('#')) msg = 'Код скопирован';
    else if (text.includes('+7') || text.includes('+')) msg = 'Номер скопирован';
    showPopup(msg);
  } else {
    if (btnEl) btnEl.blur();
    showPopup('Не удалось скопировать. Скопируйте вручную.');
  }
}

// -------- INIT --------
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  initializeApp();
});
