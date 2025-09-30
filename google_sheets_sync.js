/****************************
 * CONFIG
 ****************************/
const SHEET_ID   = '1eG_c2RcYcZs6jkJIPi8x4QXJBTBKTf2FwA33Ct7KxHg';
const SHEET_NAME = 'HomerBot';
const REQ_SHEET  = 'HB_Requests';
const PREFS_SHEET = 'HB_UserPrefs';
const BOT_TOKEN  = '7631840452:AAH4O93qQ6J914x5FhPTQX7YhJC3bTiJ_XA';
const ADMIN_CHAT_ID = '487525838';

/****************************
 * UTILS
 ****************************/
function shortIdFromUuid(uuid) { const p = String(uuid || '').split('-'); return p.length >= 3 ? p[1] : String(uuid || '').slice(0, 4); }
function round2(v){ return Math.round((Number(v)+Number.EPSILON)*100)/100; }
function monthKey_(d) { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'); return `${y}-${m}`; }
function startOfMonth_(d) { return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0); }
function endOfMonth_(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
function nextMonthKey_(key){ const [y,m]=String(key).split('-').map(Number); const base=new Date(y, (m||1)-1, 1); base.setMonth(base.getMonth()+1); return monthKey_(base); }
function compareMonthKeys_(a,b){ const[ya,ma]=String(a).split('-').map(Number); const[yb,mb]=String(b).split('-').map(Number); if(ya!==yb)return ya<yb?-1:1; if(ma!==mb)return ma<mb?-1:1; return 0; }
function readN_(rng){ const v=rng.getValue(); if(v instanceof Date) return monthKey_(v); const s=String(v||'').trim(); return /^\d{4}-\d{2}$/.test(s)?s:''; }
function writeN_(rng,key){ rng.setNumberFormat('@'); rng.setValue(String(key||'')); }


/****************************
 * HTTP HANDLER
 ****************************/

/**
 * Handles GET requests to the Google Apps Script web app.
 * Processes various actions like getting initial data, syncing balance, requesting deposits/withdrawals, etc.
 * @param {Object} e - The event object containing request parameters.
 * @param {Object} e.parameter - The query parameters from the request.
 * @param {string} e.parameter.action - The action to perform (e.g., 'getInitialData', 'syncBalance').
 * @param {string} e.parameter.username - The username of the user.
 * @param {string} [e.parameter.amount] - The amount for deposit/withdrawal requests.
 * @param {string} [e.parameter.details] - JSON string of details for withdrawal requests.
 * @param {string} [e.parameter.prefs] - JSON string of user preferences.
 * @param {string} [e.parameter.rate] - The rate for investment logging.
 * @returns {ContentService.TextOutput} JSON response with success status and data or error message.
 */
function doGet(e) {
   const p = (e && e.parameter) || {};
   try {
     const { action, username, initData } = p;
     if (!action || !username) return jsonErr('Missing required parameters');

     // Verify Telegram initData signature if provided
     if (initData) {
       const isValid = verifyTelegramSignature(initData);
       if (!isValid) return jsonErr('Invalid signature');
     }

    switch (action) {
      case 'getInitialData':
        return jsonOk(getInitialData(username));

case 'ackDepositDelivery': {
  var u = (p.username || '').toString();
  var ok = ackDepositDelivery_(u);
  return jsonOk({ delivered: ok });
}

      case 'syncBalance':
        return jsonOk(syncBalance(username));

      case 'requestDeposit':
        return jsonOk(requestAmount(username, Number(p.amount), 'DEPOSIT', null));

      case 'requestWithdraw': {
        const details = p.details ? JSON.parse(p.details) : null;
        return jsonOk(requestAmount(username, -Math.abs(Number(p.amount)), 'WITHDRAW', details));
      }

      case 'logStrategyInvestment':
        return jsonOk(logStrategyInvestment(username, Number(p.amount), Number(p.rate)));

      case 'previewAccrual':
        return jsonOk(previewAccrual_(username));

      case 'saveUserPrefs':
        return jsonOk(saveUserPrefs(username, p.prefs));

      // >>> добавлено: отмена незавершенного (PENDING) депозита
      case 'cancelPendingDeposit': {
        var u = (p.username || '').toString();
        var ok = cancelPendingDeposit_(u);
        return jsonOk({ cancelled: ok });
      }

      default:
        return jsonErr('Unknown action');
    }
  } catch (err) {
    console.error(`doGet error for action ${p.action}:`, err, err.stack);
    return jsonErr(String(err));
  }
}

/**
 * Handles POST requests from Telegram bot callbacks.
 * Processes callback queries to approve or reject deposit/withdrawal requests.
 * @param {Object} e - The event object containing POST data.
 * @param {string} e.postData.contents - JSON string of the Telegram update.
 * @returns {ContentService.TextOutput} 'OK' response.
 */
function doPost(e) {
  console.log('doPost start:', new Date().toISOString());
  try {
    const update = JSON.parse(e.postData.contents || '{}');
    if (!update.callback_query) return ContentService.createTextOutput('OK');

    const cq = update.callback_query;
    const data = String(cq.data || '');
    const parts = data.split(':');
    const act = (parts[0] || '').toLowerCase();
    const username = (parts[1] || '').trim();
    const requestId = (parts[2] || '').trim();
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;

    const action = act === 'approve' ? 'APPROVED' : act === 'reject' ? 'REJECTED' : '';
    if (!username || !requestId || !action) {
      safeAnswerCallbackQuery(cq.id, 'Ошибка: неверные данные.', true);
      return ContentService.createTextOutput('OK');
    }

    safeAnswerCallbackQuery(cq.id, action === 'APPROVED' ? 'Запрос одобрен' : 'Запрос отклонён');

    const lock = LockService.getScriptLock();
    console.log('doPost trying lock:', new Date().toISOString());
    if (lock.tryLock(5000)) {
      console.log('doPost lock acquired:', new Date().toISOString());
      try {
        const reqSheet = ensureRequestsSheet_();
        const reqRow = findRequestRowById_(reqSheet, requestId);
        if (reqRow) {
          if (reqSheet.getRange(reqRow, 2).getValue() === username && reqSheet.getRange(reqRow, 4).getValue() === 'PENDING') {
            reqSheet.getRange(reqRow, 4).setValue(action);
            reqSheet.getRange(reqRow, 6).setValue(new Date());

            if (action === 'APPROVED') {
              const amount = Number(reqSheet.getRange(reqRow, 11).getValue() || 0);
              const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
              const { row: userRow } = findOrCreateUserRow_(usersSheet, username);
              const currentBalance = Number(usersSheet.getRange(userRow, 3).getValue() || 0);
              usersSheet.getRange(userRow, 3).setValue(round2(currentBalance + amount));
              usersSheet.getRange(userRow, 4).setValue(new Date());
            }
          }
        }
      } finally {
        lock.releaseLock();
        console.log('doPost lock released:', new Date().toISOString());
      }
    } else {
      console.log('doPost failed to acquire lock:', new Date().toISOString());
    }

    const shortId = shortIdFromUuid(requestId);
    const text = action === 'APPROVED' ? `[#${shortId}] ✅ Одобрено: Запрос от ${username}.` : `[#${shortId}] ❌ Отклонено: Запрос от ${username}.`;
    try {
      UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, reply_markup: {inline_keyboard: []} }), // Remove buttons after click
        muteHttpExceptions: true
      });
    } catch (e) { console.error("TG edit failed:", e); }

    console.log('doPost end:', new Date().toISOString());
    return ContentService.createTextOutput('OK');
  } catch (err) {
    console.error("doPost error:", err);
    return ContentService.createTextOutput('OK');
  }
}

/****************************
 * CORE LOGIC & DATA FETCHERS
 ****************************/

/**
 * Retrieves initial data for a user, including balance, history, portfolio, locked amount, and preferences.
 * Ensures data is fresh by syncing balance first.
 * @param {string} username - The username of the user.
 * @returns {Object} Object containing balance, history, portfolio, lockedAmount, and userPrefs.
 */
function getInitialData(username) {
    syncBalance(username); // Ensure data is fresh before sending
    const balanceData = getBalance(username);
    const history = getHistory(username);
    const portfolio = getPortfolio(username);
    const lockedAmount = getLockedAmount(username);
    const userPrefs = getUserPrefs(username);
    return { ...balanceData, history, portfolio, lockedAmount, userPrefs };
}

/**
 * Syncs the balance for a user by applying accrued interest and reapplying missed approved transactions.
 * Uses locking to prevent concurrent modifications.
 * @param {string} username - The username of the user.
 * @returns {Object} Object containing balance, monthBase, and lockedAmount.
 */
function syncBalance(username) {
  console.log('syncBalance start for', username, new Date().toISOString());
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  const reqSheet = ensureRequestsSheet_();
  const lock = LockService.getScriptLock();
  console.log('syncBalance trying lock:', new Date().toISOString());
  if (!lock.tryLock(10000)) {
    console.log('syncBalance failed to acquire lock:', new Date().toISOString());
    return getBalance(username);
  }
  console.log('syncBalance lock acquired:', new Date().toISOString());

  try {
    let { row } = findOrCreateUserRow_(usersSheet, username);

    // ---------- PATCH 2.2: reapply missed APPROVED requests ----------
    reapplyMissedApproved_(username);
    let balance = Number(usersSheet.getRange(row, 3).getValue() || 0);
    // -----------------------------------------------------------------------

    const now = new Date();
    const currentMonth = monthKey_(now);

    const nCell = usersSheet.getRange(row, 14);
    ensureColO_(usersSheet);
    let lastAppliedMonth = readN_(nCell);
    if (!lastAppliedMonth) {
      lastAppliedMonth = currentMonth;
      writeN_(nCell, currentMonth);
    }

    const paidCell = usersSheet.getRange(row, 15);
    let paidThisMonth = Number(paidCell.getValue() || 0);

    let safety = 0;
    while (compareMonthKeys_(lastAppliedMonth, currentMonth) < 0 && safety < 120) {
      safety++;
      const [y, m] = lastAppliedMonth.split('-').map(Number);
      const mStart = new Date(y, m - 1, 1);
      const mEnd = endOfMonth_(mStart);
      const fullInterest = computeInterestForPeriod(username, mStart, mEnd);
      const toAdd = Math.max(0, round2(fullInterest - paidThisMonth));
      if (toAdd > 0) balance = round2(balance + toAdd);
      paidThisMonth = 0;
      paidCell.setValue(0);
      lastAppliedMonth = nextMonthKey_(lastAppliedMonth);
      writeN_(nCell, lastAppliedMonth);
    }

    const investedAmount = getInvestedAmount(username);

    const mStart = startOfMonth_(now);
    const accruedToNow = computeInterestForPeriod(username, mStart, now);
    const delta = Math.max(0, round2(accruedToNow - paidThisMonth));
    if (delta > 0) {
      balance = round2(balance + delta);
      paidThisMonth = round2(paidThisMonth + delta);
      paidCell.setValue(paidThisMonth);

      // Distribute accrued interest to locked investments
      const portfolio = getPortfolio(username);
      const reqSheet = ensureRequestsSheet_();
      portfolio.forEach(inv => {
        if ((inv.rate === 17 || inv.rate === 18) && (!inv.unfreezeDate || inv.unfreezeDate > now)) {
          const share = round2((inv.amount / investedAmount) * delta);
          const reqRow = findRequestRowById_(reqSheet, inv.requestId);
          if (reqRow) {
            const currentAccrued = Number(reqSheet.getRange(reqRow, 14).getValue() || 0);
            reqSheet.getRange(reqRow, 14).setValue(round2(currentAccrued + share));
          }
        }
      });
    }
    usersSheet.getRange(row, 2).setValue(investedAmount);
    usersSheet.getRange(row, 3).setValue(balance);
    usersSheet.getRange(row, 4).setValue(new Date());

    // Calculate and update effective rate based on portfolio
    const portfolio = getPortfolio(username);
    const effectiveRate = portfolio.length > 0 ? portfolio.reduce((sum, inv) => sum + inv.amount * inv.rate, 0) / investedAmount : 16;
    usersSheet.getRange(row, 6).setValue(effectiveRate);

    const lockedAmount = getLockedAmount(username);
    console.log('syncBalance end:', new Date().toISOString());
    return { balance, monthBase: investedAmount, lockedAmount };
  } finally {
    lock.releaseLock();
    console.log('syncBalance lock released:', new Date().toISOString());
  }
}

/**
 * Requests a deposit or withdrawal for a user, sends notification to admin via Telegram, and logs the request.
 * @param {string} username - The username of the user.
 * @param {number} amount - The amount (positive for deposit, negative for withdrawal).
 * @param {string} type - 'DEPOSIT' or 'WITHDRAW'.
 * @param {Object} [details] - Additional details for withdrawal (method, phone, bank).
 * @returns {Object} Object with success status, requestId, and shortId.
 */
function requestAmount(username, amount, type, details) {
    try {
        const reqSheet = ensureRequestsSheet_();
        const requestId = Utilities.getUuid();
        const shortId = shortIdFromUuid(requestId);
        const now = new Date();
    
    let detailsText = "";
    if (type === 'WITHDRAW' && details) {
        if(details.method === 'sbp') {
            detailsText = `\nРеквизиты: СБП ${details.bank}, ${details.phone}`;
        }
    }

    const verb = amount > 0 ? 'депозит' : 'вывод';
    const pretty = Math.abs(amount).toLocaleString('ru-RU');
    let text = `[#${shortId}] Пользователь ${username} запросил ${verb} на ${pretty} ₽.${detailsText}`;

    const replyMarkup = { inline_keyboard: [[ { text: 'Да', callback_data: `approve:${username}:${requestId}` }, { text: 'Нет', callback_data: `reject:${username}:${requestId}` } ]] };

    try {
        const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'post', contentType: 'application/json',
            payload: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: text, reply_markup: replyMarkup }),
            muteHttpExceptions: true
        });
        const jsonResponse = JSON.parse(response.getContentText());
        const messageId = jsonResponse.ok ? jsonResponse.result.message_id : null;
        reqSheet.appendRow([now, username, requestId, 'PENDING', messageId, null, false, ADMIN_CHAT_ID, now, type, Number(amount), null]);
    } catch(e) { 
        console.error("TG notification failed:", e);
        reqSheet.appendRow([now, username, requestId, 'PENDING', null, null, false, null, null, type, Number(amount), null]);
    }

        return { success: true, requestSent: true, requestId, shortId };
    } catch (error) {
        console.error('Error in requestAmount:', error);
        return { success: false, error: error.message };
    }
}

function logStrategyInvestment(username, amount, rate) {
    const reqSheet = ensureRequestsSheet_();
    const requestId = Utilities.getUuid();
    const shortId = shortIdFromUuid(requestId);
    const now = new Date();
    const freezeDays = (rate === 17) ? 30 : (rate === 18) ? 90 : 0;
    const unfreezeDate = new Date(now);
    unfreezeDate.setDate(unfreezeDate.getDate() + freezeDays);
    reqSheet.appendRow([now, username, requestId, 'APPROVED', null, now, true, null, null, 'INVEST', Number(amount), Number(rate), unfreezeDate, 0]);
    const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const { row } = findOrCreateUserRow_(usersSheet, username);
    usersSheet.getRange(row, 6).setValue(rate);
    return { success: true, requestId, requestShortId: shortId };
}

function getBalance(username) {
  const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const { row } = findOrCreateUserRow_(usersSheet, username);
  const balance = Number(usersSheet.getRange(row, 3).getValue() || 0);
  const rate = Number(usersSheet.getRange(row, 6).getValue() || 16);
  const monthBase = getInvestedAmount(username);
  usersSheet.getRange(row, 2).setValue(monthBase);
  return { username, balance, rate, monthBase };
}

function getHistory(username) {
    const reqSheet = ensureRequestsSheet_();
    const lastRow = reqSheet.getLastRow();
    if (lastRow < 2) return [];
    const data = reqSheet.getRange(2, 1, lastRow - 1, 12).getValues();
    return data
        .filter(row => String(row[1]).trim() === username && String(row[9]).trim() !== 'RATE_CHANGE')
        .map(row => ({
            date: new Date(row[0]).getTime(),
            shortId: shortIdFromUuid(String(row[2])),
            status: String(row[3]).trim(), // Добавляем статус
            type: String(row[9]).trim(),
            amount: Number(row[10]),
            rate: Number(row[11] || 0)
        }))
        .sort((a, b) => b.date - a.date);
}

function getPortfolio(username) {
    const reqSheet = ensureRequestsSheet_();
    const lastRow = reqSheet.getLastRow();
    if (lastRow < 2) return [];
    const data = reqSheet.getRange(2, 1, lastRow - 1, 14).getValues();
    return data
        .filter(row => String(row[1]).trim() === username && String(row[9]).trim() === 'INVEST' && String(row[3]).trim() === 'APPROVED')
        .map(row => ({
            requestId: String(row[2]),
            shortId: shortIdFromUuid(String(row[2])),
            amount: Number(row[10]),
            rate: Number(row[11]),
            unfreezeDate: row[12] ? new Date(row[12]) : null,
            accruedInterest: Number(row[13] || 0)
        }));
}

function getInvestedAmount(username) {
    return getPortfolio(username).reduce((sum, item) => sum + item.amount, 0);
}

function getLockedAmount(username) {
    const now = new Date();
    return getPortfolio(username)
        .filter(item => {
            if (item.rate !== 17 && item.rate !== 18) return false;
            if (!item.unfreezeDate) return true; // If no date, assume locked
            return item.unfreezeDate > now;
        })
        .reduce((sum, item) => sum + item.amount + item.accruedInterest, 0);
}

function previewAccrual_(username) {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const accruedToday = computeInterestForPeriod(username, dayStart, now);
    return { accruedToday };
}

function computeInterestForPeriod(username, fromDate, toDate) {
    const portfolio = getPortfolio(username);
    if (portfolio.length === 0) return 0;
    let totalInterest = 0;
    const periodMs = toDate.getTime() - fromDate.getTime();
    if (periodMs <= 0) return 0;
    portfolio.forEach(investment => {
        const dailyRate = (investment.rate / 100) / 365.25;
        const interestForPeriod = investment.amount * dailyRate * (periodMs / (24 * 60 * 60 * 1000));
        totalInterest += interestForPeriod;
    });
    return round2(totalInterest);
}

function saveUserPrefs(username, prefsString) {
    const prefsSheet = ensurePrefsSheet_();
    const prefs = JSON.parse(prefsString || '{}');
    const { row } = findUserRowInSheet_(prefsSheet, username, true);
    let sbpMethods = prefs.sbpMethods ? (Array.isArray(prefs.sbpMethods) ? prefs.sbpMethods : []) : [];
    
    prefsSheet.getRange(row, 1, 1, 5).setValues([[
        username,
        JSON.stringify(sbpMethods),
        prefs.cryptoWallet || '',
        prefs.bankAccount || '',
        prefs.currency || 'RUB'
    ]]);
    return { success: true, savedPrefs: getUserPrefs(username) };
}

function getUserPrefs(username) {
    const prefsSheet = ensurePrefsSheet_();
    const { row, existed } = findUserRowInSheet_(prefsSheet, username, false);
    if (!existed) return { currency: 'RUB', sbpMethods: [] };
    const data = prefsSheet.getRange(row, 2, 1, 4).getValues()[0];
    let sbpMethods = [];
    try {
        sbpMethods = JSON.parse(data[0] || '[]');
        if (!Array.isArray(sbpMethods)) sbpMethods = [];
    } catch(e) {
        sbpMethods = [];
    }
    return {
        sbpMethods: sbpMethods,
        cryptoWallet: data[1] || '',
        bankAccount: data[2] || '',
        currency: data[3] || 'RUB'
    };
}

function ensureRequestsSheet_() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(REQ_SHEET);
    if (!sh) {
        sh = ss.insertSheet(REQ_SHEET);
        sh.getRange(1,1,1,14).setValues([['createdAt','username','requestId','status','messageId','decidedAt','delivered','adminChatId','messageDate','type','amount', 'rate', 'unfreezeDate', 'accruedInterest']]);
    }
    return sh;
}

function ensurePrefsSheet_() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(PREFS_SHEET);
    if (!sh) {
        sh = ss.insertSheet(PREFS_SHEET);
        sh.getRange(1, 1, 1, 5).setValues([['username', 'sbpMethods (JSON)', 'cryptoWallet', 'bankAccount', 'currency']]);
    }
    return sh;
}

/**
 * Reapplies to the balance all APPROVED DEPOSIT/WITHDRAW transactions for the user,
 * where processedAt (F) is LATER than the "last balance application" (column D for the user).
 * Requests columns: 1:createdAt,2:username,3:requestId,4:status,5:messageId,
 * 6:processedAt,7:delivered,8:adminChatId,9:messageDate,10:type,11:amount,12:rate
 */
function reapplyMissedApproved_(username) {
  if (!username) return {applied:0, sum:0};

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  const reqSheet = ensureRequestsSheet_();

  const u = findOrCreateUserRow_(usersSheet, username);
  const userRow = u.row;

  const lastAppliedAt = usersSheet.getRange(userRow, 4).getValue(); // can be null
  const lastAppliedTs = lastAppliedAt ? new Date(lastAppliedAt).getTime() : 0;

  const lastRow = reqSheet.getLastRow();
  if (lastRow < 2) return {applied:0, sum:0};

  const data = reqSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  let sum = 0, maxProcessed = 0, applied = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const user   = String(row[1]||'').trim();
    const status = String(row[3]||'').trim();
    const procAt = row[5] ? new Date(row[5]).getTime() : 0;
    const type   = String(row[9]||'').trim();
    const amount = Number(row[10]||0);

    if (user !== username) continue;
    if (status !== 'APPROVED') continue;
    if (type !== 'DEPOSIT' && type !== 'WITHDRAW') continue;
    if (!procAt || procAt <= lastAppliedTs) continue;

    sum += amount;                 // DEPOSIT >0; WITHDRAW <0
    if (procAt > maxProcessed) maxProcessed = procAt;
    applied++;
  }

  if (applied > 0 && sum !== 0) {
    const balanceCell = usersSheet.getRange(userRow, 3);
    const nowBal = Number(balanceCell.getValue() || 0);
    balanceCell.setValue(round2(nowBal + sum));
    usersSheet.getRange(userRow, 4).setValue(new Date()); // marking that balance have changed
  }
  return {applied, sum};
}

function findOrCreateUserRow_(sheet, username) {
    const { row, existed } = findUserRowInSheet_(sheet, username, true);
    if (!existed) {
        sheet.getRange(row, 1, 1, 15).setValues([[username, 0, 0, new Date(), '', 16, '', '', '', '', '', '', '', monthKey_(new Date()), 0]]);
    }
    return { row, existed };
}
function findUserRowInSheet_(sheet, username, createIfNotFound) {
    const lastRow = sheet.getLastRow();
    if (lastRow > 0) { // Check if sheet has any data
        const range = sheet.getRange(1, 1, lastRow, 1);
        const usernames = range.getValues();
        for (let i = 0; i < usernames.length; i++) {
            if (usernames[i][0] === username) return { row: i + 1, existed: true };
        }
    }
    if (createIfNotFound) {
        const newRow = lastRow + 1;
        sheet.getRange(newRow, 1).setValue(username);
        return { row: newRow, existed: false };
    }
    return { row: -1, existed: false };
}
function findRequestRowById_(sheet, requestId) {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    const requestIds = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
    for (let i = 0; i < requestIds.length; i++) {
        if (requestIds[i][0] === requestId) return i + 2;
    }
    return null;
}
function ensureColO_(sheet){ if (sheet.getMaxColumns() < 15) { sheet.insertColumnsAfter(14, 15 - sheet.getMaxColumns()); } }
function jsonOk(obj) { return ContentService.createTextOutput(JSON.stringify({ success: true, ...obj })).setMimeType(ContentService.MimeType.JSON); }
function jsonErr(message) { return ContentService.createTextOutput(JSON.stringify({ success: false, error: message })).setMimeType(ContentService.MimeType.JSON); }
function cancelPendingDeposit_(username) {
  if (!username) return false;
  var reqSheet = ensureRequestsSheet_();
  var lastRow = reqSheet.getLastRow();
  if (lastRow < 2) return false;

  // columns: 1:createdAt,2:username,3:requestId,4:status,5:messageId,6:processedAt,
  // 7:delivered,8:adminChatId,9:messageDate,10:type,11:amount,12:rate
  var data = reqSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  // take the most "fresh" PENDING deposit of this user
  for (var i = data.length - 1; i >= 0; i--) {
    var row = data[i];
    if (row[1] === username && row[3] === 'PENDING' && row[9] === 'DEPOSIT') {
      reqSheet.getRange(i + 2, 4).setValue('CANCELED');     // status
      reqSheet.getRange(i + 2, 6).setValue(new Date());     // processedAt
      reqSheet.getRange(i + 2, 7).setValue(true);           // delivered/applied
      return true;
    }
  }
  return false;
}
/**
 * Mark the deposit result as delivered to the user (after Pop-up on frontend).
 * Columns in Requests:
 * 1:createdAt, 2:username, 3:requestId, 4:status, 5:messageId, 
 * 6:processedAt, 7:delivered, 8:adminChatId, 9:messageDate, 10:type, 11:amount, 12:rate
 */
function ackDepositDelivery_(username) {
  if (!username) return false;
  var reqSheet = ensureRequestsSheet_();
  var lastRow = reqSheet.getLastRow();
  if (lastRow < 2) return false;

  var data = reqSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  // find the LATEST deposit of the user with final status where delivered != TRUE
  for (var i = data.length - 1; i >= 0; i--) {
    var row = data[i];
    var user    = row[1];
    var status  = row[3];
    var delivered = row[6] === true;
    var type    = row[9];

    if (user === username && type === 'DEPOSIT' && !delivered && status && status !== 'PENDING') {
      reqSheet.getRange(i + 2, 7).setValue(true); // G: delivered = TRUE
      return true;
    }
  }
  return false;
}
function safeAnswerCallbackQuery(id, text, showAlert = false) {
    try {
        UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'post', contentType: 'application/json',
            payload: JSON.stringify({ callback_query_id: id, text: text, show_alert: showAlert }),
            muteHttpExceptions: true
        });
    } catch(e) {}
}

function verifyTelegramSignature(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;

    // Remove hash from params
    params.delete('hash');

    // Sort and join
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256
    const secretKey = Utilities.computeHmacSha256Signature(BOT_TOKEN, 'WebAppData');
    const calculatedHash = Utilities.computeHmacSha256Signature(dataCheckString, secretKey);
    const calculatedHashHex = calculatedHash.map(b => ('0' + b.toString(16)).slice(-2)).join('');

    return calculatedHashHex === hash;
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

/**
 * Форматирует таблицы для красивого отображения
 * Запускать один раз из редактора Google Apps Script
 */
function formatSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Форматирование HomerBot листа
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  if (usersSheet) {
    // Заголовки
    usersSheet.getRange(1, 1, 1, 15).setValues([[
      'Username', 'Инвестировано', 'Баланс', 'Последняя синхронизация',
      '', 'Эффективная ставка', '', '', '', '', '', '', '', 'Последний месяц', 'Выплачено в месяце'
    ]]);

    // Стили заголовков
    usersSheet.getRange(1, 1, 1, 15).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Авторазмер колонок
    usersSheet.autoResizeColumns(1, 15);
  }

  // Форматирование HB_Requests листа
  const reqSheet = ensureRequestsSheet_();
  if (reqSheet) {
    // Заголовки
    reqSheet.getRange(1, 1, 1, 14).setValues([[
      'Дата создания', 'Пользователь', 'Request ID', 'Статус', 'Message ID',
      'Дата решения', 'Доставлено', 'Admin Chat ID', 'Дата сообщения',
      'Тип', 'Сумма', 'Ставка', 'Дата разморозки', 'Начисленные проценты'
    ]]);

    // Стили заголовков
    reqSheet.getRange(1, 1, 1, 14).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Выпадающий список для столбца G (Доставлено)
    const lastRow = reqSheet.getLastRow();
    if (lastRow > 1) {
      const range = reqSheet.getRange(2, 7, lastRow - 1, 1);
      const rule = SpreadsheetApp.newDataValidation().requireValueInList(['TRUE', 'FALSE'], true).build();
      range.setDataValidation(rule);
    }

    // Условное форматирование для столбца M (Дата разморозки)
    const unfreezeRange = reqSheet.getRange(2, 13, lastRow - 1, 1);
    const now = new Date();

    // Красный: прошедшая дата или менее 7 дней
    const redRule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND(M2<>"", M2<DATEVALUE("' + now.toISOString().split('T')[0] + '")+7)')
      .setBackground('#ffcdd2')
      .setRanges([unfreezeRange])
      .build();

    // Жёлтый: 7-30 дней
    const yellowRule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND(M2<>"", M2>=DATEVALUE("' + now.toISOString().split('T')[0] + '")+7, M2<DATEVALUE("' + now.toISOString().split('T')[0] + '")+30)')
      .setBackground('#fff9c4')
      .setRanges([unfreezeRange])
      .build();

    // Зелёный: более 30 дней
    const greenRule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND(M2<>"", M2>=DATEVALUE("' + now.toISOString().split('T')[0] + '")+30)')
      .setBackground('#c8e6c9')
      .setRanges([unfreezeRange])
      .build();

    reqSheet.setConditionalFormatRules([redRule, yellowRule, greenRule]);

    // Авторазмер колонок
    reqSheet.autoResizeColumns(1, 14);
  }

  // Форматирование HB_UserPrefs листа
  const prefsSheet = ensurePrefsSheet_();
  if (prefsSheet) {
    // Заголовки
    prefsSheet.getRange(1, 1, 1, 5).setValues([[
      'Пользователь', 'SBP методы (JSON)', 'Крипто кошелёк', 'Банковский счёт', 'Валюта'
    ]]);

    // Стили заголовков
    prefsSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Авторазмер колонок
    prefsSheet.autoResizeColumns(1, 5);
  }

  Logger.log('Таблицы отформатированы!');
}