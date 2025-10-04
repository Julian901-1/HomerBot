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
 * INVESTMENT RATES CONFIG
 * Централизованная конфигурация процентных ставок
 * При изменении ставок здесь они автоматически применятся и в UI
 ****************************/
const INVESTMENT_RATES = {
  LIQUID: {
    rate: 16,
    name: 'Ликвидный',
    nameEn: 'Liquid',
    freezeDays: 0,
    description: 'Начисление ежедневно, вывод без штрафов'
  },
  STABLE: {
    rate: 17,
    name: 'Стабильный',
    nameEn: 'Stable',
    freezeDays: 30,
    description: 'Заморозка на 30 дней'
  },
  AGGRESSIVE: {
    rate: 18,
    name: 'Агрессивный',
    nameEn: 'Aggressive',
    freezeDays: 90,
    description: 'Заморозка на 90 дней'
  }
};

// Вспомогательная функция для получения конфига по ставке
function getRateConfig(rate) {
  const configs = Object.values(INVESTMENT_RATES);
  return configs.find(c => c.rate === rate) || INVESTMENT_RATES.LIQUID;
}

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

      // >>> добавлено: получение конфигурации ставок
      case 'getRatesConfig':
        return jsonOk({ rates: INVESTMENT_RATES });

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

                // НОВАЯ СТРУКТУРА: обновляем column 2 (userDeposits)
                const currentDeposits = Number(usersSheet.getRange(userRow, 2).getValue() || 0);
                const newDeposits = type === 'DEPOSIT' ?
                  currentDeposits + amount :
                  currentDeposits - Math.abs(amount);
                console.log('doPost updating userDeposits (column 2) from', currentDeposits, 'to', newDeposits);
                usersSheet.getRange(userRow, 2).setValue(newDeposits);

                // Дублируем в column 19 для обратной совместимости
                usersSheet.getRange(userRow, 19).setValue(newDeposits);

                // КРИТИЧЕСКИ ВАЖНО: При выводе закрываем инвестиции пропорционально
                if (type === 'WITHDRAW') {
                  const withdrawAmount = Math.abs(amount);
                  closeInvestmentsProportionally_(username, withdrawAmount);
                }

                // Пометить как примененное к балансу (column 9)
                reqSheet.getRange(reqRow, 9).setValue(true);

                // Обновляем lastAppliedAt (column 4)
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
    // syncBalance() теперь возвращает результаты из calculateBalances()
    const balanceData = syncBalance(username);
    const history = getHistory(username);
    const portfolio = getPortfolio(username);
    const userPrefs = getUserPrefs(username);

    // ВАЖНО: accruedToday = todayIncome (для обратной совместимости)
    // todayIncome теперь считается правильно с учетом времени создания инвестиций

    return {
        ...balanceData,
        history,
        portfolio,
        accruedToday: balanceData.todayIncome,
        userPrefs
    };
}

/**
 * ======================================================
 * НОВАЯ ВЕРСИЯ syncBalance() - v8.0-ON-DEMAND
 * ======================================================
 * Упрощенная логика:
 * 1. Обновляет accruedInterest для каждой инвестиции в INVEST_TRANSACTIONS
 * 2. Проверяет разморозку 17%/18%
 * 3. Обновляет lastSync
 * 4. Возвращает результаты из calculateBalances()
 *
 * @param {string} username - The username of the user.
 * @returns {Object} Object containing all calculated balances.
 */
function syncBalance(username) {
  console.log('=== syncBalance START v8.0-ON-DEMAND ===', username, new Date().toISOString());

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  const lock = LockService.getScriptLock();

  console.log('Trying to acquire lock...');
  if (!lock.tryLock(10000)) {
    console.log('Failed to acquire lock, returning getBalance()');
    return getBalance(username);
  }

  console.log('Lock acquired');

  try {
    const { row } = findOrCreateUserRow_(usersSheet, username);

    // 1. Reapply missed APPROVED deposit/withdraw requests
    console.log('Reapplying missed transactions...');
    reapplyMissedApproved_(username);

    // 2. Get lastSync время
    let lastSync = usersSheet.getRange(row, 3).getValue(); // Column 3: lastSync
    if (!lastSync || !(lastSync instanceof Date)) {
      lastSync = new Date();
      lastSync.setHours(0, 0, 0, 0);
    }

    const now = new Date();
    console.log('lastSync:', lastSync.toISOString(), 'now:', now.toISOString());

    // 3. Обновить accruedInterest для КАЖДОЙ инвестиции
    console.log('Updating accruedInterest for each investment...');
    const investments = getPortfolio(username);
    const investSheet = ensureInvestTransactionsSheet_();

    for (const inv of investments) {
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (!reqRow) continue;

      const createdAt = new Date(investSheet.getRange(reqRow, 1).getValue());
      const amount = Number(investSheet.getRange(reqRow, 8).getValue());
      const rate = Number(investSheet.getRange(reqRow, 9).getValue());

      // Считаем проценты с момента создания до СЕЙЧАС
      const dailyRate = (rate / 100) / 365.25;
      const msElapsed = now.getTime() - createdAt.getTime();
      const daysElapsed = msElapsed / (24 * 60 * 60 * 1000);
      const accrued = amount * dailyRate * daysElapsed;

      // Сохраняем в колонку K (column 11)
      investSheet.getRange(reqRow, 11).setValue(round2(accrued));

      console.log(`Updated investment ${inv.shortId}: accrued=${round2(accrued)}`);
    }

    // 4. Проверяем разморозку 17%/18%
    console.log('Checking for unfrozen investments...');
    const unfrozenInvestments = investments.filter(inv => {
      if (inv.rate !== 17 && inv.rate !== 18) return false;
      if (!inv.unfreezeDate) return false;
      if (inv.delivered) return false; // Уже разморожена
      return inv.unfreezeDate <= now;
    });

    if (unfrozenInvestments.length > 0) {
      console.log(`Unfreezing ${unfrozenInvestments.length} investments...`);
      unfrozenInvestments.forEach(inv => {
        const reqRow = findRequestRowById_(investSheet, inv.requestId);
        if (reqRow) {
          investSheet.getRange(reqRow, 6).setValue(now); // Помечаем как delivered
          console.log(`Unfrozen investment ${inv.shortId}`);
        }
      });
    }

    // 5. Обновляем lastSync
    usersSheet.getRange(row, 3).setValue(now);

    // 6. Возвращаем рассчитанные балансы из calculateBalances()
    console.log('Calculating balances...');
    const balances = calculateBalances(username);

    console.log('=== syncBalance END ===');
    return balances;

  } finally {
    lock.releaseLock();
    console.log('Lock released');
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
        // SERVER-SIDE VALIDATION для DEPOSIT
        if (type === 'DEPOSIT') {
            const depositAmount = Math.abs(Number(amount));

            console.log(`Deposit validation: amount=${depositAmount}`);

            if (depositAmount < 100) {
                return { success: false, error: 'Минимальная сумма депозита: 100 ₽' };
            }

            if (depositAmount > 10000000) {
                return { success: false, error: 'Максимальная сумма депозита: 10 000 000 ₽' };
            }
        }

        // SERVER-SIDE VALIDATION для WITHDRAW
        if (type === 'WITHDRAW') {
            const withdrawAmount = Math.abs(Number(amount));
            const balances = calculateBalances(username);
            const availableForWithdrawal = balances.availableForWithdrawal || 0;

            console.log(`Withdraw validation: amount=${withdrawAmount}, available=${availableForWithdrawal}`);

            if (withdrawAmount <= 0) {
                return { success: false, error: 'Сумма вывода должна быть больше 0' };
            }

            if (withdrawAmount > availableForWithdrawal) {
                return { success: false, error: `Недостаточно средств для вывода. Доступно: ${round2(availableForWithdrawal)} ₽` };
            }

            if (availableForWithdrawal <= 0) {
                return { success: false, error: 'Недостаточно средств для вывода. Доступная сумма: 0 ₽' };
            }
        }

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

    // Используем централизованный конфиг для получения freezeDays
    const rateConfig = getRateConfig(rate);
    const freezeDays = rateConfig.freezeDays;

    const unfreezeDate = new Date(now);
    unfreezeDate.setDate(unfreezeDate.getDate() + freezeDays);

    reqSheet.appendRow([now, username, requestId, 'APPROVED', now, null, 'INVEST', Number(amount), Number(rate), unfreezeDate, 0]);
    logToEventJournal(now, username, requestId, 'APPROVED', null, now, null, null, null, 'INVEST', Number(amount), Number(rate), unfreezeDate);

    return { success: true, requestId, requestShortId: shortId };
}

/**
 * Быстрая версия getBalance() без лока.
 * Просто вызывает calculateBalances() для получения актуальных данных.
 */
function getBalance(username) {
  console.log('getBalance() called for', username);
  return calculateBalances(username);
}

function getHistory(username) {
    const sheets = [
        { sheet: ensureInvestTransactionsSheet_(), type: 'INVEST' },
        { sheet: ensureDepositWithdrawTransactionsSheet_(), type: 'DEPOSIT_WITHDRAW' }
    ];
    let allData = [];

    sheets.forEach(({ sheet, type }) => {
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return;
        const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
        const filteredData = data.filter(row => String(row[1]).trim() === username);

        const mappedData = filteredData.map(row => {
            if (type === 'INVEST') {
                // INVEST_TRANSACTIONS: columns [0:createdAt, 1:username, 2:requestId, 3:status, 4:decidedAt, 5:delivered, 6:type, 7:amount, 8:rate]
                return {
                    date: new Date(row[0]).getTime(),
                    shortId: shortIdFromUuid(String(row[2])),
                    status: String(row[3]).trim(),
                    type: String(row[6]).trim(),
                    amount: Number(row[7]),
                    rate: Number(row[8] || 0)
                };
            } else {
                // DEPOSIT_WITHDRAW_TRANSACTIONS: columns [0:createdAt, 1:username, 2:requestId, 3:status, 4:decidedAt, 5:delivered, 6:type, 7:amount]
                return {
                    date: new Date(row[0]).getTime(),
                    shortId: shortIdFromUuid(String(row[2])),
                    status: String(row[3]).trim(),
                    type: String(row[6]).trim(),
                    amount: Number(row[7]),
                    rate: 0
                };
            }
        });
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
            createdAt: row[0] ? new Date(row[0]) : null,  // ДОБАВЛЕНО: timestamp создания
            requestId: String(row[2]),
            shortId: shortIdFromUuid(String(row[2])),
            amount: Number(row[7]),
            rate: Number(row[8]),
            unfreezeDate: row[9] ? new Date(row[9]) : null,
            accruedInterest: Number(row[10] || 0),
            delivered: row[5] ? new Date(row[5]) : null  // ДОБАВЛЕНО: для проверки разморозки
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

/**
 * ======================================================
 * НОВАЯ АРХИТЕКТУРА: ON-DEMAND РАСЧЕТ ВСЕХ БАЛАНСОВ
 * ======================================================
 * Вместо хранения агрегированных данных считаем их при каждом запросе.
 * Источник истины: INVEST_TRANSACTIONS (column 11 - accruedInterest для каждой инвестиции)
 *
 * @param {string} username - Имя пользователя
 * @returns {Object} Все рассчитанные балансы
 */
function calculateBalances(username) {
  console.log('=== calculateBalances START ===', username);

  // 1. Получаем userDeposits из HomerBot (только депозиты/выводы, БЕЗ процентов)
  // НОВАЯ СТРУКТУРА: userDeposits хранится в column 2
  const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const { row } = findOrCreateUserRow_(usersSheet, username);

  // Пробуем сначала column 2 (новая структура), потом column 19 (старая)
  let userDeposits = Number(usersSheet.getRange(row, 2).getValue() || 0);
  if (userDeposits === 0) {
    userDeposits = Number(usersSheet.getRange(row, 19).getValue() || 0);
    // Если нашли в column 19, копируем в column 2
    if (userDeposits !== 0) {
      usersSheet.getRange(row, 2).setValue(userDeposits);
    }
  }

  console.log('userDeposits (column 2):', userDeposits);

  // 2. Получаем все активные инвестиции
  const investments = getPortfolio(username);
  console.log('Active investments:', investments.length);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  let totalEarnedFromInvestments = 0;  // Все заработанное со ВСЕХ инвестиций
  let availableForWithdrawal = userDeposits; // Начинаем с депозитов
  let investedAmount = 0;
  let todayIncome = 0;
  let locked1718Principal = 0; // Заблокированная основная сумма 17%/18%

  // 3. Для каждой инвестиции считаем текущие проценты из accruedInterest
  const investSheet = ensureInvestTransactionsSheet_();

  for (const inv of investments) {
    investedAmount += inv.amount;

    // Получаем сохраненный accruedInterest из колонки K
    const reqRow = findRequestRowById_(investSheet, inv.requestId);
    if (!reqRow) continue;

    const accruedInterestTotal = Number(investSheet.getRange(reqRow, 11).getValue() || 0);
    console.log(`Investment ${inv.shortId} (${inv.rate}%): amount=${inv.amount}, accrued=${accruedInterestTotal}`);

    totalEarnedFromInvestments += accruedInterestTotal;

    // Получаем дату создания инвестиции
    const createdAt = new Date(investSheet.getRange(reqRow, 1).getValue());

    // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Разделяем accruedInterest на "до сегодня" и "сегодня"
    const dailyRate = (inv.rate / 100) / 365.25;

    // Считаем проценты с создания до начала сегодняшнего дня
    const msUntilToday = Math.max(0, todayStart.getTime() - createdAt.getTime());
    const daysUntilToday = msUntilToday / (24 * 60 * 60 * 1000);
    const accruedUntilToday = inv.amount * dailyRate * daysUntilToday;

    // Считаем проценты за сегодня (с начала дня или с момента создания, если создано сегодня)
    const effectiveStart = createdAt > todayStart ? createdAt : todayStart;
    const msElapsedToday = Math.max(0, now.getTime() - effectiveStart.getTime());
    const daysElapsedToday = msElapsedToday / (24 * 60 * 60 * 1000);
    const earnedToday = inv.amount * dailyRate * daysElapsedToday;

    todayIncome += earnedToday;

    console.log(`  accruedUntilToday=${round2(accruedUntilToday)}, earnedToday=${round2(earnedToday)}`);

    // Проверяем доступность для вывода
    const isFrozen = (inv.rate === 17 || inv.rate === 18) &&
                     inv.unfreezeDate &&
                     inv.unfreezeDate > now &&
                     !inv.delivered;

    if (isFrozen) {
      // ЗАБЛОКИРОВАННАЯ инвестиция 17%/18%: основная сумма НЕ доступна для вывода!
      locked1718Principal += inv.amount;
    } else {
      // РАЗБЛОКИРОВАННАЯ инвестиция (16% или разморозившаяся 17%/18%):
      // Доступны для вывода ТОЛЬКО проценты до сегодня!
      // Сегодняшние проценты станут доступны только после 00:00
      availableForWithdrawal += accruedUntilToday;
    }
  }

  // КРИТИЧЕСКИ ВАЖНО: Вычитаем заблокированную основную сумму 17%/18%
  availableForWithdrawal -= locked1718Principal;

  console.log('totalEarnedFromInvestments:', totalEarnedFromInvestments);
  console.log('availableForWithdrawal:', availableForWithdrawal);
  console.log('todayIncome:', todayIncome);

  // 4. Рассчитываем итоговые балансы
  // ИСПРАВЛЕНИЕ: Используем round2() для todayIncome чтобы избежать расхождений с totalEarnings
  const totalBalance = round2(userDeposits + totalEarnedFromInvestments);
  const availableForInvest = round2(userDeposits - investedAmount);
  const roundedTodayIncome = round2(todayIncome);

  // Важно: проценты НЕ доступны для реинвестирования!
  if (availableForInvest < 0) {
    console.warn('WARNING: availableForInvest < 0, this should not happen!');
  }

  console.log('=== calculateBalances END ===');
  console.log('totalBalance:', totalBalance);
  console.log('availableForInvest:', availableForInvest);

  return {
    balance: totalBalance,
    availableForWithdrawal: round2(availableForWithdrawal),
    availableForInvest: Math.max(0, availableForInvest),
    investedAmount: round2(investedAmount),
    todayIncome: roundedTodayIncome,
    userDeposits: round2(userDeposits),
    totalEarnings: round2(totalEarnedFromInvestments),
    portfolio: investments,  // ДОБАВЛЕНО: возвращаем актуальный портфель
    success: true
  };
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
        sh.getRange(1,1,1,9).setValues([['Дата создания','Пользователь','Request ID','Статус','Дата решения','Доставлено','Тип','Сумма','Применено к балансу']]);
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
 * Закрывает инвестиции пропорционально при выводе средств.
 * Приоритет: сначала 16% (ликвидные), потом разблокированные 17%/18%, потом заблокированные.
 *
 * @param {string} username - Имя пользователя
 * @param {number} withdrawAmount - Сумма вывода
 */
function closeInvestmentsProportionally_(username, withdrawAmount) {
  console.log(`=== closeInvestmentsProportionally START: ${username}, amount=${withdrawAmount} ===`);

  const investSheet = ensureInvestTransactionsSheet_();
  const portfolio = getPortfolio(username);

  if (portfolio.length === 0) {
    console.log('No investments to close');
    return;
  }

  const now = new Date();

  // Сортируем инвестиции по приоритету: 16% -> разблокированные 17%/18% -> заблокированные 17%/18%
  const sorted = portfolio.sort((a, b) => {
    const aFrozen = (a.rate === 17 || a.rate === 18) && a.unfreezeDate && a.unfreezeDate > now && !a.delivered;
    const bFrozen = (b.rate === 17 || b.rate === 18) && b.unfreezeDate && b.unfreezeDate > now && !b.delivered;

    if (a.rate === 16 && b.rate !== 16) return -1; // 16% в приоритете
    if (a.rate !== 16 && b.rate === 16) return 1;
    if (!aFrozen && bFrozen) return -1; // Разблокированные в приоритете
    if (aFrozen && !bFrozen) return 1;
    return 0;
  });

  let remaining = withdrawAmount;

  for (const inv of sorted) {
    if (remaining <= 0) break;

    const reqRow = findRequestRowById_(investSheet, inv.requestId);
    if (!reqRow) continue;

    const currentAmount = Number(investSheet.getRange(reqRow, 8).getValue() || 0);

    if (currentAmount <= 0) continue;

    if (remaining >= currentAmount) {
      // Закрываем инвестицию полностью - удаляем строку
      console.log(`Closing investment ${inv.shortId} completely: ${currentAmount}`);
      investSheet.deleteRow(reqRow);
      remaining -= currentAmount;
    } else {
      // Частичное закрытие - уменьшаем сумму
      const newAmount = round2(currentAmount - remaining);
      console.log(`Partially closing investment ${inv.shortId}: ${currentAmount} -> ${newAmount}`);
      investSheet.getRange(reqRow, 8).setValue(newAmount);

      // Пересчитываем accruedInterest пропорционально
      const oldAccrued = Number(investSheet.getRange(reqRow, 11).getValue() || 0);
      const newAccrued = round2(oldAccrued * (newAmount / currentAmount));
      investSheet.getRange(reqRow, 11).setValue(newAccrued);

      remaining = 0;
    }
  }

  if (remaining > 0) {
    console.warn(`WARNING: Could not close all investments, remaining=${remaining}`);
  }

  console.log('=== closeInvestmentsProportionally END ===');
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
    
    // Ensure column 9 exists
    if (sheet.getMaxColumns() < 9) {
      sheet.insertColumnAfter(8);
      sheet.getRange(1, 9).setValue('Применено к балансу');
    }
    
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const user   = String(row[1]||'').trim();
      const status = String(row[3]||'').trim();
      const decidedAt = row[4] ? new Date(row[4]).getTime() : 0;
      const type   = String(row[6]||'').trim();
      const amount = Number(row[7]||0);
      const appliedToBalance = row[8]; // column 9 (0-indexed 8)

      if (user !== username) continue;
      if (status !== 'APPROVED') continue;
      if (type !== 'DEPOSIT' && type !== 'WITHDRAW') continue;
      if (!decidedAt || decidedAt <= lastAppliedTs) continue;
      
      // Skip if already applied to balance
      if (appliedToBalance) continue;

      sum += amount;
      if (decidedAt > maxProcessed) maxProcessed = decidedAt;
      applied++;
      
      // Mark as applied to balance (column 9)
      sheet.getRange(i + 2, 9).setValue(true);
    }
  });

  if (applied > 0 && sum !== 0) {
    // НОВАЯ СТРУКТУРА: обновляем column 2 (userDeposits)
    const userDepositsCell = usersSheet.getRange(userRow, 2);
    const currentDeposits = Number(userDepositsCell.getValue() || 0);
    userDepositsCell.setValue(currentDeposits + sum);

    // Дублируем в column 19 для обратной совместимости
    usersSheet.getRange(userRow, 19).setValue(currentDeposits + sum);

    // Обновляем lastAppliedAt (column 4)
    usersSheet.getRange(userRow, 4).setValue(new Date());
  }
  return {applied, sum};
}

/**
 * ======================================================
 * НОВАЯ СТРУКТУРА HomerBot (упрощенная)
 * ======================================================
 * Column 1: username
 * Column 2: userDeposits (только депозиты/выводы, БЕЗ процентов)
 * Column 3: lastSync
 * Column 4: lastAppliedAt (для reapplyMissedApproved_)
 *
 * Все остальные колонки (19-21) оставлены для обратной совместимости,
 * но новая логика использует только columns 1-4.
 */
function findOrCreateUserRow_(sheet, username) {
    const { row, existed } = findUserRowInSheet_(sheet, username, true);
    if (!existed) {
        const now = new Date();
        // Инициализируем минимальные необходимые колонки
        // Column 1: username
        // Column 2: userDeposits
        // Column 3: lastSync
        // Column 4: lastAppliedAt (для reapplyMissedApproved_)
        sheet.getRange(row, 1, 1, 4).setValues([[username, 0, now, now]]);

        // Дополнительно инициализируем column 19 для обратной совместимости
        if (sheet.getMaxColumns() < 19) {
          const colsToAdd = 19 - sheet.getMaxColumns();
          sheet.insertColumnsAfter(sheet.getMaxColumns(), colsToAdd);
        }
        sheet.getRange(row, 19).setValue(0); // userDeposits дублируется в column 19 для старого кода
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