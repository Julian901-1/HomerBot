/****************************
 * CONFIG
 ****************************/
const SHEET_ID   = '1eG_c2RcYcZs6jkJIPi8x4QXJBTBKTf2FwA33Ct7KxHg';
const SHEET_NAME = 'HomerBot';
const REQ_SHEET  = 'HB_Requests';
const PREFS_SHEET = 'HB_UserPrefs';
const INVEST_TRANSACTIONS = 'INVEST_TRANSACTIONS';
const DEPOSIT_WITHDRAW_TRANSACTIONS = 'DEPOSIT_WITHDRAW_TRANSACTIONS';
const EVENT_JOURNAL = 'EVENT_JOURNAL';
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

      case 'getHistory':
        return jsonOk({ history: getHistory(username) });

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

    console.log('doPost data:', data, 'username:', username, 'requestId:', requestId);

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
        const reqResult = findRequestRowByIdAcrossSheets(requestId);
        console.log('doPost reqResult:', reqResult);
        if (reqResult) {
          const { sheet: reqSheet, row: reqRow } = reqResult;
          console.log('doPost processing sheet:', reqSheet.getName(), 'row:', reqRow);
          if (reqSheet.getRange(reqRow, 2).getValue() === username && reqSheet.getRange(reqRow, 4).getValue() === 'PENDING') {
            reqSheet.getRange(reqRow, 4).setValue(action);
            reqSheet.getRange(reqRow, 5).setValue(new Date()); // decidedAt
            // Don't overwrite column 6 (delivered) - it should remain false until user sees the result

            if (action === 'APPROVED') {
              const type = reqSheet.getRange(reqRow, 7).getValue();
              const amount = Number(reqSheet.getRange(reqRow, 8).getValue() || 0);
              console.log('doPost type:', type, 'amount:', amount);
              if (type === 'DEPOSIT' || type === 'WITHDRAW') {
                const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
                const { row: userRow } = findOrCreateUserRow_(usersSheet, username);
                
                // CRITICAL: Only update userDeposits (NO INTEREST!)
                const currentDeposits = Number(usersSheet.getRange(userRow, 19).getValue() || 0);
                const newDeposits = type === 'DEPOSIT' ?
                  currentDeposits + amount :
                  currentDeposits - Math.abs(amount);
                console.log('doPost updating userDeposits from', currentDeposits, 'to', newDeposits);
                usersSheet.getRange(userRow, 19).setValue(newDeposits);
                
                // Recalculate visual balance: userDeposits + totalEarnings
                const totalEarnings = Number(usersSheet.getRange(userRow, 20).getValue() || 0);
                usersSheet.getRange(userRow, 3).setValue(newDeposits + totalEarnings);
                usersSheet.getRange(userRow, 4).setValue(new Date());
              }
            }
          } else {
            console.log('doPost username or status mismatch');
          }
        } else {
          console.log('doPost request not found');
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
    // Sync balance first to get fresh data
    const balanceData = syncBalance(username);
    const history = getHistory(username);
    const portfolio = getPortfolio(username);
    const userPrefs = getUserPrefs(username);

    // Calculate accrued today
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const accruedToday = computeInterestForPeriod(username, dayStart, now);

    return {
        ...balanceData,
        history,
        portfolio,
        accruedToday: round2(accruedToday),
        userPrefs
    };
}

/**
 * Syncs the balance for a user by applying accrued interest and reapplying missed approved transactions.
 * Uses locking to prevent concurrent modifications.
 * @param {string} username - The username of the user.
 * @returns {Object} Object containing balance, monthBase, and lockedAmount.
 */
function syncBalance(username) {
  console.log('syncBalance start for', username, new Date().toISOString(), 'v5.0-FIXED');
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  const lock = LockService.getScriptLock();
  console.log('syncBalance trying lock:', new Date().toISOString());
  if (!lock.tryLock(10000)) {
    console.log('syncBalance failed to acquire lock:', new Date().toISOString());
    return getBalance(username);
  }
  console.log('syncBalance lock acquired:', new Date().toISOString());

  try {
    let { row } = findOrCreateUserRow_(usersSheet, username);

    // Reapply missed APPROVED deposit/withdraw requests
    reapplyMissedApproved_(username);

    // Ensure column 21 exists for available16Interest
    ensureColO_(usersSheet);
    if (usersSheet.getMaxColumns() < 21) {
      usersSheet.insertColumnsAfter(20, 1);
    }

    // Get current state
    let userDeposits = Number(usersSheet.getRange(row, 19).getValue() || 0);
    let totalEarnings = Number(usersSheet.getRange(row, 20).getValue() || 0);
    let available16Interest = Number(usersSheet.getRange(row, 21).getValue() || 0);
    let pendingInterest = Number(usersSheet.getRange(row, 17).getValue() || 0);
    let lastSyncTime = usersSheet.getRange(row, 18).getValue();
    
    // Initialize lastSyncTime if missing
    if (!lastSyncTime || !(lastSyncTime instanceof Date)) {
      lastSyncTime = new Date();
      lastSyncTime.setHours(0, 0, 0, 0);
    }

    const now = new Date();
    const currentDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const lastSyncDayStart = new Date(lastSyncTime.getFullYear(), lastSyncTime.getMonth(), lastSyncTime.getDate(), 0, 0, 0, 0);

    // CRITICAL FIX: Remove today's partial interest from previous sync before processing
    // This prevents double-counting of 17%/18% interest
// Вместо пересчёта с начала дня, добавляйте только НОВЫЕ проценты
if (lastSyncDayStart.getTime() === currentDayStart.getTime()) {
  // Считаем только новые проценты с lastSyncTime до now
  const newInterest16 = computeInterestForPeriod(username, lastSyncTime, now, 16);
  const newInterest1718 = computeInterestForPeriod(username, lastSyncTime, now, [17, 18]);
  totalEarnings = round2(totalEarnings + newInterest16 + newInterest1718);
} else {
  // Новый день - считаем с начала дня
  const interest16Today = computeInterestForPeriod(username, currentDayStart, now, 16);
  const interest1718Today = computeInterestForPeriod(username, currentDayStart, now, [17, 18]);
  totalEarnings = round2(totalEarnings + interest16Today + interest1718Today);
}
    // Process missed days (if user didn't log in for days/weeks)
    let processingDay = new Date(lastSyncDayStart);
    while (processingDay < currentDayStart) {
      const dayEnd = new Date(processingDay);
      dayEnd.setHours(23, 59, 59, 999);
      
      // Calculate interest for this complete day
      const interest16Day = computeInterestForPeriod(username, processingDay, dayEnd, 16);
      const interest1718Day = computeInterestForPeriod(username, processingDay, dayEnd, [17, 18]);
      
      // Add to totalEarnings (visual total)
      totalEarnings = round2(totalEarnings + interest16Day + interest1718Day);
      
      // 16% interest becomes available for withdrawal immediately (day already passed)
      available16Interest = round2(available16Interest + interest16Day);
      
      // Update accrued interest for each investment
      updateInvestmentAccrued_(username, interest16Day, interest1718Day);
      
      // Move to next day
      processingDay.setDate(processingDay.getDate() + 1);
    }

    // Process today's interest (current day, incomplete)
    const interest16Today = computeInterestForPeriod(username, currentDayStart, now, 16);
    const interest1718Today = computeInterestForPeriod(username, currentDayStart, now, [17, 18]);
    
    // Add today's interest to totalEarnings (already removed previous partial interest above)
    totalEarnings = round2(totalEarnings + interest16Today + interest1718Today);
    
    // Today's 16% interest stays in pendingInterest (will unlock at midnight)
    pendingInterest = round2(interest16Today);

    // Check for unfrozen 17%/18% investments
    const portfolio = getPortfolio(username);
    const unfrozenInvestments = portfolio.filter(inv => {
      if (inv.rate !== 17 && inv.rate !== 18) return false;
      if (!inv.unfreezeDate) return false;
      // Check if already marked as unfrozen (delivered field is set)
      const investSheet = ensureInvestTransactionsSheet_();
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (!reqRow) return false;
      const delivered = investSheet.getRange(reqRow, 6).getValue();
      if (delivered) return false; // Already processed
      return inv.unfreezeDate <= now;
    });

    let unfrozenAmount = 0;
    if (unfrozenInvestments.length > 0) {
      const investSheet = ensureInvestTransactionsSheet_();
      unfrozenInvestments.forEach(inv => {
        const reqRow = findRequestRowById_(investSheet, inv.requestId);
        if (reqRow) {
          // Mark as unfrozen
          investSheet.getRange(reqRow, 6).setValue(now);
          // Principal + accrued interest become available
          unfrozenAmount += inv.amount + inv.accruedInterest;
        }
      });
      available16Interest = round2(available16Interest + unfrozenAmount);
    }

    // Calculate balances
    const investedAmount = getInvestedAmount(username);
    const lockedPrincipal1718 = getLockedPrincipal1718(username);
    const availableForWithdrawal = round2(userDeposits + available16Interest - lockedPrincipal1718);
    const availableForInvest = round2(userDeposits - investedAmount);
    const balance = round2(userDeposits + totalEarnings);

    // Save updated values
    usersSheet.getRange(row, 17).setValue(pendingInterest);
    usersSheet.getRange(row, 18).setValue(now); // lastSyncTime = now
    usersSheet.getRange(row, 19).setValue(userDeposits);
    usersSheet.getRange(row, 20).setValue(totalEarnings);
    usersSheet.getRange(row, 21).setValue(available16Interest);
    usersSheet.getRange(row, 2).setValue(investedAmount);
    usersSheet.getRange(row, 3).setValue(balance);
    usersSheet.getRange(row, 4).setValue(now);

    // Calculate effective rate
    const effectiveRate = investedAmount > 0 ?
      portfolio.reduce((sum, inv) => sum + inv.amount * inv.rate, 0) / investedAmount : 16;
    usersSheet.getRange(row, 6).setValue(effectiveRate);

    const lockedAmount = getLockedAmount(username);
    
    console.log('syncBalance end:', new Date().toISOString());
    return {
      balance: balance,
      monthBase: round2(investedAmount),
      lockedAmount: round2(lockedAmount),
      lockedAmountForWithdrawal: round2(lockedPrincipal1718),
      availableBalance: round2(availableForWithdrawal),
      userDeposits: round2(userDeposits),
      totalEarnings: round2(totalEarnings),
      availableForWithdrawal: round2(availableForWithdrawal),
      availableForInvest: round2(availableForInvest),
      investedAmount: round2(investedAmount)
    };
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
        let reqSheet;
        if (type === 'DEPOSIT' || type === 'WITHDRAW') {
            reqSheet = ensureDepositWithdrawTransactionsSheet_();
        } else {
            reqSheet = ensureRequestsSheet_(); // fallback
        }
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

    let messageId = null;
    try {
        const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'post', contentType: 'application/json',
            payload: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: text, reply_markup: replyMarkup }),
            muteHttpExceptions: true
        });
        const jsonResponse = JSON.parse(response.getContentText());
        messageId = jsonResponse.ok ? jsonResponse.result.message_id : null;
        reqSheet.appendRow([now, username, requestId, 'PENDING', null, null, type, Number(amount)]);
        logToEventJournal(now, username, requestId, 'PENDING', messageId, null, null, ADMIN_CHAT_ID, now, type, Number(amount), null, null);
    } catch(e) {
        console.error("TG notification failed:", e);
        reqSheet.appendRow([now, username, requestId, 'PENDING', null, false, type, Number(amount)]);
        logToEventJournal(now, username, requestId, 'PENDING', null, null, false, null, null, type, Number(amount), null, null);
    }

        return { success: true, requestSent: true, requestId, shortId };
    } catch (error) {
        console.error('Error in requestAmount:', error);
        return { success: false, error: error.message };
    }
}

function logStrategyInvestment(username, amount, rate) {
    const reqSheet = ensureInvestTransactionsSheet_();
    const requestId = Utilities.getUuid();
    const shortId = shortIdFromUuid(requestId);
    const now = new Date();
    const freezeDays = (rate === 17) ? 30 : (rate === 18) ? 90 : 0;
    const unfreezeDate = new Date(now);
    unfreezeDate.setDate(unfreezeDate.getDate() + freezeDays);
    reqSheet.appendRow([now, username, requestId, 'APPROVED', now, null, 'INVEST', Number(amount), Number(rate), unfreezeDate, 0]);
    logToEventJournal(now, username, requestId, 'APPROVED', null, now, null, null, null, 'INVEST', Number(amount), Number(rate), unfreezeDate);
    const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const { row } = findOrCreateUserRow_(usersSheet, username);
    usersSheet.getRange(row, 6).setValue(rate);
    return { success: true, requestId, requestShortId: shortId };
}

function getBalance(username) {
  const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const { row } = findOrCreateUserRow_(usersSheet, username);
  
  const userDeposits = Number(usersSheet.getRange(row, 19).getValue() || 0);
  const totalEarnings = Number(usersSheet.getRange(row, 20).getValue() || 0);
  const balance = round2(userDeposits + totalEarnings);
  const rate = Number(usersSheet.getRange(row, 6).getValue() || 16);
  const investedAmount = getInvestedAmount(username);
  
  // Ensure column 21 exists
  ensureColO_(usersSheet);
  if (usersSheet.getMaxColumns() < 21) {
    usersSheet.insertColumnsAfter(20, 1);
  }
  
  const available16Interest = Number(usersSheet.getRange(row, 21).getValue() || 0);
  const lockedPrincipal1718 = getLockedPrincipal1718(username);
  const availableForWithdrawal = round2(userDeposits + available16Interest - lockedPrincipal1718);
  const availableForInvest = round2(userDeposits - investedAmount);
  
  usersSheet.getRange(row, 2).setValue(round2(investedAmount));
  
  return {
    username,
    balance: round2(balance),
    rate,
    monthBase: round2(investedAmount),
    userDeposits: round2(userDeposits),
    totalEarnings: round2(totalEarnings),
    availableForWithdrawal: round2(availableForWithdrawal),
    availableForInvest: round2(availableForInvest),
    investedAmount: round2(investedAmount)
  };
}

function getHistory(username) {
    const sheets = [
        ensureInvestTransactionsSheet_(),
        ensureDepositWithdrawTransactionsSheet_()
    ];
    let allData = [];
    sheets.forEach(sheet => {
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return;
        const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
        const filteredData = data.filter(row => String(row[1]).trim() === username);
        // Map columns based on sheet structure
        const mappedData = filteredData.map(row => {
            const numCols = row.length;
            let typeCol, amountCol, rateCol = 8;
            if (numCols === 11) { // INVEST_TRANSACTIONS
                typeCol = 6; amountCol = 7; rateCol = 8;
            } else if (numCols === 8) { // DEPOSIT_WITHDRAW_TRANSACTIONS
                typeCol = 6; amountCol = 7; rateCol = -1; // no rate column
            } else {
                return null; // unknown format
            }
            return {
                date: new Date(row[0]).getTime(),
                shortId: shortIdFromUuid(String(row[2])),
                status: String(row[3]).trim(),
                type: typeCol >= 0 ? String(row[typeCol]).trim() : '',
                amount: amountCol >= 0 ? Number(row[amountCol]) : 0,
                rate: rateCol >= 0 ? Number(row[rateCol] || 0) : 0
            };
        }).filter(item => item !== null);
        allData = allData.concat(mappedData);
    });
    return allData.sort((a, b) => b.date - a.date);
}

function getPortfolio(username) {
    const sheet = ensureInvestTransactionsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
    return data
        .filter(row => String(row[1]).trim() === username && String(row[6]).trim() === 'INVEST' && String(row[3]).trim() === 'APPROVED')
        .map(row => ({
            requestId: String(row[2]),
            shortId: shortIdFromUuid(String(row[2])),
            amount: Number(row[7]),
            rate: Number(row[8]),
            unfreezeDate: row[9] ? new Date(row[9]) : null,
            accruedInterest: Number(row[10] || 0)
        }));
}

function getInvestedAmount(username) {
    return getPortfolio(username).reduce((sum, item) => sum + item.amount, 0);
}

function getLockedAmount(username) {
    // Only 17%/18% investments are locked for re-investment until unfrozen
    const now = new Date();
    return getPortfolio(username)
        .filter(item => {
            if (item.rate !== 17 && item.rate !== 18) return false;
            if (!item.unfreezeDate) return true; // If no date, assume locked
            return item.unfreezeDate > now;
        })
        .reduce((sum, item) => sum + item.amount + item.accruedInterest, 0);
}

function getLockedAmountForWithdrawal(username) {
    // Only 17% and 18% investments are locked for withdrawal until unfrozen
    const now = new Date();
    return getPortfolio(username)
        .filter(item => {
            if (item.rate !== 17 && item.rate !== 18) return false;
            if (!item.unfreezeDate) return true; // If no date, assume locked
            return item.unfreezeDate > now; // Still frozen
        })
        .reduce((sum, item) => sum + item.amount, 0); // Don't include accruedInterest in locked amount
}

function previewAccrual_(username) {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const accruedToday = computeInterestForPeriod(username, dayStart, now); // For all investments
    return { accruedToday: round2(accruedToday) };
}

/**
 * Helper function to update accrued interest for each investment
 */
function updateInvestmentAccrued_(username, interest16, interest1718) {
  const portfolio = getPortfolio(username);
  const investSheet = ensureInvestTransactionsSheet_();
  
  // Update 16% investments
  if (interest16 > 0) {
    const portfolio16 = portfolio.filter(inv => inv.rate === 16);
    const total16 = portfolio16.reduce((sum, inv) => sum + inv.amount, 0);
    portfolio16.forEach(inv => {
      const share = total16 > 0 ? (inv.amount / total16) * interest16 : 0;
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (reqRow) {
        const currentAccrued = Number(investSheet.getRange(reqRow, 11).getValue() || 0);
        investSheet.getRange(reqRow, 11).setValue(round2(currentAccrued + share));
      }
    });
  }
  
  // Update 17%/18% investments
  if (interest1718 > 0) {
    const portfolio1718 = portfolio.filter(inv => inv.rate === 17 || inv.rate === 18);
    const total1718 = portfolio1718.reduce((sum, inv) => sum + inv.amount, 0);
    portfolio1718.forEach(inv => {
      const share = total1718 > 0 ? (inv.amount / total1718) * interest1718 : 0;
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (reqRow) {
        const currentAccrued = Number(investSheet.getRange(reqRow, 11).getValue() || 0);
        investSheet.getRange(reqRow, 11).setValue(round2(currentAccrued + share));
      }
    });
  }
}

/**
 * Get locked principal amount for 17%/18% investments (not yet unfrozen)
 */
function getLockedPrincipal1718(username) {
  const now = new Date();
  const portfolio = getPortfolio(username);
  return portfolio
    .filter(inv => {
      if (inv.rate !== 17 && inv.rate !== 18) return false;
      if (!inv.unfreezeDate) return true; // No date means locked
      // Check if already unfrozen (delivered field is set)
      const investSheet = ensureInvestTransactionsSheet_();
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (!reqRow) return false;
      const delivered = investSheet.getRange(reqRow, 6).getValue();
      if (delivered) return false; // Already unfrozen
      return inv.unfreezeDate > now; // Still frozen
    })
    .reduce((sum, inv) => sum + inv.amount, 0);
}

function computeInterestForPeriod(username, fromDate, toDate, rateFilter = null) {
    const portfolio = getPortfolio(username);
    if (portfolio.length === 0) return 0;
    let totalInterest = 0;
    const toDateMs = toDate.getTime();
    const fromDateMs = fromDate.getTime();
    if (toDateMs <= fromDateMs) return 0;

    let filteredPortfolio = portfolio;
    if (rateFilter !== null) {
        if (Array.isArray(rateFilter)) {
            filteredPortfolio = portfolio.filter(inv => rateFilter.includes(inv.rate));
        } else {
            filteredPortfolio = portfolio.filter(inv => inv.rate === rateFilter);
        }
    }

    filteredPortfolio.forEach(investment => {
        // Get creation date for this investment
        const investSheet = ensureInvestTransactionsSheet_();
        const reqRow = findRequestRowById_(investSheet, investment.requestId);
        if (!reqRow) return;

        const createdAt = new Date(investSheet.getRange(reqRow, 1).getValue()); // column 1: createdAt
        const effectiveFromMs = Math.max(fromDateMs, createdAt.getTime());
        const periodMs = toDateMs - effectiveFromMs;

        if (periodMs > 0) {
            const dailyRate = (investment.rate / 100) / 365.25;
            const interestForPeriod = investment.amount * dailyRate * (periodMs / (24 * 60 * 60 * 1000));
            totalInterest += interestForPeriod;
        }
    });
    // Return with high precision (8 decimal places) for internal calculations
    return Math.round(totalInterest * 100000000) / 100000000;
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

function ensureInvestTransactionsSheet_() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(INVEST_TRANSACTIONS);
    if (!sh) {
        sh = ss.insertSheet(INVEST_TRANSACTIONS);
        sh.getRange(1,1,1,11).setValues([['Дата создания','Пользователь','Request ID','Статус','Дата решения','Доставлено','Тип','Сумма','Ставка','Дата разморозки','Начисленные проценты']]);
    }
    return sh;
}


function ensureDepositWithdrawTransactionsSheet_() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(DEPOSIT_WITHDRAW_TRANSACTIONS);
    if (!sh) {
        sh = ss.insertSheet(DEPOSIT_WITHDRAW_TRANSACTIONS);
        sh.getRange(1,1,1,8).setValues([['Дата создания','Пользователь','Request ID','Статус','Дата решения','Доставлено','Тип','Сумма']]);
    }
    return sh;
}

function ensureEventJournalSheet_() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(EVENT_JOURNAL);
    if (!sh) {
        sh = ss.insertSheet(EVENT_JOURNAL);
        sh.getRange(1,1,1,10).setValues([['Дата создания','Пользователь','Request ID','Статус','Message ID','Дата решения','Доставлено','Тип','Сумма','Ставка']]);
    }
    return sh;
}

function logToEventJournal(createdAt, username, requestId, status, messageId, decidedAt, delivered, adminChatId, messageDate, type, amount, rate, unfreezeDate) {
    const sheet = ensureEventJournalSheet_();
    // For DEPOSIT and WITHDRAW operations, set status to "-"
    const finalStatus = (type === 'DEPOSIT' || type === 'WITHDRAW') ? '-' : status;
    sheet.appendRow([createdAt, username, requestId, finalStatus, messageId, decidedAt, null, type, amount, rate]);
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

  const u = findOrCreateUserRow_(usersSheet, username);
  const userRow = u.row;

  const lastAppliedAt = usersSheet.getRange(userRow, 4).getValue();
  const lastAppliedTs = lastAppliedAt ? new Date(lastAppliedAt).getTime() : 0;

  const sheets = [ensureDepositWithdrawTransactionsSheet_()];
  let sum = 0, maxProcessed = 0, applied = 0;

  sheets.forEach(sheet => {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const user   = String(row[1]||'').trim();
      const status = String(row[3]||'').trim();
      const procAt = row[4] ? new Date(row[4]).getTime() : 0; // decidedAt column 5 (0-indexed 4)
      const type   = String(row[6]||'').trim(); // column 7 (0-indexed 6)
      const amount = Number(row[7]||0); // column 8

      if (user !== username) continue;
      if (status !== 'APPROVED') continue;
      if (type !== 'DEPOSIT' && type !== 'WITHDRAW') continue;
      if (!procAt || procAt <= lastAppliedTs) continue;

      sum += amount; // DEPOSIT >0; WITHDRAW <0
      if (procAt > maxProcessed) maxProcessed = procAt;
      applied++;
    }
  });

  if (applied > 0 && sum !== 0) {
    // CRITICAL: Update only userDeposits (column 19), NOT interest!
    const userDepositsCell = usersSheet.getRange(userRow, 19);
    const currentDeposits = Number(userDepositsCell.getValue() || 0);
    userDepositsCell.setValue(currentDeposits + sum);
    
    // Recalculate visual balance
    const totalEarnings = Number(usersSheet.getRange(userRow, 20).getValue() || 0);
    usersSheet.getRange(userRow, 3).setValue(currentDeposits + sum + totalEarnings);
    usersSheet.getRange(userRow, 4).setValue(new Date());
  }
  return {applied, sum};
}

function findOrCreateUserRow_(sheet, username) {
    const { row, existed } = findUserRowInSheet_(sheet, username, true);
    if (!existed) {
        const now = new Date();
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        // Ensure column 21 exists
        ensureColO_(sheet);
        if (sheet.getMaxColumns() < 21) {
          sheet.insertColumnsAfter(20, 1);
        }
        // Initialize: [username, investedAmount, balance, lastSync, '', rate, '', '', '', '', '', '', '', lastMonth, paidMonth, availableForWithdraw, pendingInterest, lastDayProcessed, userDeposits, totalEarnings, available16Interest]
        sheet.getRange(row, 1, 1, 21).setValues([[username, 0, 0, now, '', 16, '', '', '', '', '', '', '', monthKey_(now), 0, 0, 0, dayStart, 0, 0, 0]]);
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

function findRequestRowByIdAcrossSheets(requestId) {
    console.log('findRequestRowByIdAcrossSheets: looking for', requestId);
    const sheets = [
        ensureDepositWithdrawTransactionsSheet_(), // prioritize new sheets
        ensureInvestTransactionsSheet_()
    ];
    for (let sheet of sheets) {
        const row = findRequestRowById_(sheet, requestId);
        if (row) {
            console.log('found in', sheet.getName(), 'row', row);
            return { sheet, row };
        }
    }
    console.log('not found');
    return null;
}

function findMessageIdForRequest_(requestId) {
    const sheet = ensureEventJournalSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    const data = sheet.getRange(2, 3, lastRow - 1, 1).getValues(); // column 3: requestId
    for (let i = 0; i < data.length; i++) {
        if (data[i][0] === requestId) {
            const messageId = sheet.getRange(i + 2, 5).getValue(); // column 5: messageId
            return messageId ? Number(messageId) : null;
        }
    }
    return null;
}
function ensureColO_(sheet){ if (sheet.getMaxColumns() < 20) { sheet.insertColumnsAfter(19, 20 - sheet.getMaxColumns()); } }
function jsonOk(obj) { return ContentService.createTextOutput(JSON.stringify({ success: true, ...obj })).setMimeType(ContentService.MimeType.JSON); }
function jsonErr(message) { return ContentService.createTextOutput(JSON.stringify({ success: false, error: message })).setMimeType(ContentService.MimeType.JSON); }
function cancelPendingDeposit_(username) {
  if (!username) return false;
  var sheets = [ensureDepositWithdrawTransactionsSheet_()];
  for (var s = 0; s < sheets.length; s++) {
    var reqSheet = sheets[s];
    var lastRow = reqSheet.getLastRow();
    if (lastRow < 2) continue;

    var data = reqSheet.getRange(2, 1, lastRow - 1, reqSheet.getLastColumn()).getValues();
    // take the most "fresh" PENDING deposit of this user
    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      if (row[1] === username && row[3] === 'PENDING' && row[6] === 'DEPOSIT') { // type in column 7 (0-indexed 6)
        var requestId = row[2]; // column 3 (0-indexed 2)
        reqSheet.getRange(i + 2, 4).setValue('CANCELED');     // status
        reqSheet.getRange(i + 2, 6).setValue(new Date());     // processedAt

        // Find and update admin message
        var messageId = findMessageIdForRequest_(requestId);
        if (messageId) {
          var shortId = shortIdFromUuid(requestId);
          var text = `[#${shortId}] ❌ Отменено пользователем: Депозит от ${username}.`;
          try {
            UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
              method: 'post', contentType: 'application/json',
              payload: JSON.stringify({ chat_id: ADMIN_CHAT_ID, message_id: messageId, text: text, reply_markup: {inline_keyboard: []} }),
              muteHttpExceptions: true
            });
          } catch (e) { console.error("TG edit failed:", e); }
        }

        return true;
      }
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
    usersSheet.getRange(1, 1, 1, 20).setValues([[
      'Пользователь', 'Инвестировано', 'Общий баланс', 'Последняя синхронизация',
      '', 'Эффективная ставка', '', '', '', '', '', '', '', 'Последний месяц', 'Выплачено в месяце',
      'Доступный баланс', 'Ожидающие проценты', 'Последнее обновление доступного', 'Депозиты пользователя', 'Общие доходы'
    ]]);

    // Стили заголовков
    usersSheet.getRange(1, 1, 1, 15).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Авторазмер колонок
    usersSheet.autoResizeColumns(1, 20);
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