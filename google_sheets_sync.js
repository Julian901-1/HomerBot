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
 * UTILS - ДЕСЯТИЧНАЯ АРИФМЕТИКА
 * Используем высокую точность для расчётов с последующим банковским округлением
 * Это упростит миграцию на Postgres Decimal в будущем
 ****************************/
function shortIdFromUuid(uuid) { const p = String(uuid || '').split('-'); return p.length >= 3 ? p[1] : String(uuid || '').slice(0, 4); }

/**
 * Банковское округление (round half to even) до 2 знаков после запятой
 * Используется для отображения денежных сумм пользователю
 * @param {number} v - Число для округления
 * @returns {number} Округлённое до 2 знаков число
 */
function round2(v) {
  const num = Number(v);
  if (!isFinite(num)) return 0;

  // Умножаем на 100 для работы с копейками
  const shifted = num * 100;
  const floor = Math.floor(shifted);
  const decimal = shifted - floor;

  // Банковское округление: если дробная часть ровно 0.5, округляем к чётному
  if (Math.abs(decimal - 0.5) < Number.EPSILON) {
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }

  // Обычное округление для других случаев
  return Math.round(shifted) / 100;
}

/**
 * Банковское округление до 8 знаков после запятой
 * Используется для внутренних расчётов процентов
 * @param {number} v - Число для округления
 * @returns {number} Округлённое до 8 знаков число
 */
function round8(v) {
  const num = Number(v);
  if (!isFinite(num)) return 0;

  const shifted = num * 100000000;
  const floor = Math.floor(shifted);
  const decimal = shifted - floor;

  // Банковское округление
  if (Math.abs(decimal - 0.5) < Number.EPSILON) {
    return (floor % 2 === 0 ? floor : floor + 1) / 100000000;
  }

  return Math.round(shifted) / 100000000;
}

function monthKey_(d) { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'); return `${y}-${m}`; }
function startOfMonth_(d) { return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0); }
function endOfMonth_(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
function nextMonthKey_(key){ const [y,m]=String(key).split('-').map(Number); const base=new Date(y, (m||1)-1, 1); base.setMonth(base.getMonth()+1); return monthKey_(base); }
function compareMonthKeys_(a,b){ const[ya,ma]=String(a).split('-').map(Number); const[yb,mb]=String(b).split('-').map(Number); if(ya!==yb)return ya<yb?-1:1; if(ma!==mb)return ma<mb?-1:1; return 0; }
function readN_(rng){ const v=rng.getValue(); if(v instanceof Date) return monthKey_(v); const s=String(v||'').trim(); return /^\d{4}-\d{2}$/.test(s)?s:''; }
function writeN_(rng,key){ rng.setNumberFormat('@'); rng.setValue(String(key||'')); }

/**
 * Хеширует никнейм пользователя с помощью SHA-256
 * @param {string} username - Оригинальный никнейм пользователя
 * @returns {string} Хешированный никнейм в hex формате
 */
function hashUsername(username) {
  const rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, username);
  // Конвертируем в hex строку
  return rawHash.map(function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('');
}


/****************************
 * HTTP HANDLER
 ****************************/

/**
 * Handles OPTIONS requests (CORS preflight)
 * @returns {ContentService.TextOutput} Response with CORS headers
 */
function doOptions(e) {
  return ContentService
    .createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

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

     // tbankHealthCheck не требует username
     if (action === 'tbankHealthCheck') {
       return jsonOk(tbankHealthCheck());
     }

     if (!action || !username) return jsonErr('Missing required parameters');

     // Хешируем никнейм для хранения в базе (для соблюдения 152-ФЗ)
     // Оригинальный никнейм используется только для возврата в ответе, НЕ сохраняется в БД
     const hashedUsername = hashUsername(username);

     // Verify Telegram initData signature if provided
     // ВРЕМЕННО ОТКЛЮЧЕНО: проверка не работает корректно
     // TODO: Реализовать правильную проверку подписи Telegram
     // if (initData) {
     //   const isValid = verifyTelegramSignature(initData);
     //   if (!isValid) return jsonErr('Invalid signature');
     // }

    // Сохраняем chatId при первом взаимодействии (если передан)
    if (p.chatId) {
      saveChatId_(hashedUsername, p.chatId);
    }

    switch (action) {
      case 'getInitialData':
        const initialData = getInitialData(hashedUsername);
        initialData.displayName = username; // Возвращаем оригинальный никнейм БЕЗ сохранения в БД
        return jsonOk(initialData);

      case 'syncBalance':
        const balanceData = syncBalance(hashedUsername);
        balanceData.displayName = username; // Возвращаем оригинальный никнейм БЕЗ сохранения в БД
        return jsonOk(balanceData);

      case 'requestDeposit':
        return jsonOk(requestAmount(hashedUsername, username, Number(p.amount), 'DEPOSIT', null));

      case 'requestWithdraw': {
        const details = p.details ? JSON.parse(p.details) : null;
        return jsonOk(requestAmount(hashedUsername, username, -Math.abs(Number(p.amount)), 'WITHDRAW', details));
      }

      case 'logStrategyInvestment':
        return jsonOk(logStrategyInvestment(hashedUsername, Number(p.amount), Number(p.rate)));

      case 'previewAccrual':
        return jsonOk(previewAccrual_(hashedUsername));

      case 'saveUserPrefs':
        return jsonOk(saveUserPrefs(hashedUsername, p.prefs));

      case 'setUserPref':
        return jsonOk(setUserPref(hashedUsername, p.key, p.value));

      case 'getHistory':
        return jsonOk({ history: getHistory(hashedUsername) });

      // >>> добавлено: отмена незавершенного (PENDING) депозита
      case 'cancelPendingDeposit': {
        var ok = cancelPendingDeposit_(hashedUsername);
        return jsonOk({ cancelled: ok });
      }

      // >>> добавлено: получение конфигурации ставок
      case 'getRatesConfig':
        return jsonOk({ rates: INVESTMENT_RATES });

      // >>> добавлено: настройка вечернего процента
      case 'setEveningPercent':
        return jsonOk(setEveningPercent(hashedUsername, p.startTime, p.endTime, p.agreed, p.sessionId));

      // >>> T-Bank integration actions
      case 'tbankLogin':
        return jsonOk(tbankLogin(hashedUsername, p.phone));

      case 'tbankCheckPendingInput':
        return jsonOk(tbankCheckPendingInput(hashedUsername, p.sessionId));

      case 'tbankSubmitInput':
        return jsonOk(tbankSubmitInput(hashedUsername, p.sessionId, p.value));

      case 'tbankGetAccounts':
        return jsonOk(tbankGetAccounts(hashedUsername, p.sessionId));

      case 'tbankLogout':
        return jsonOk(tbankLogout(hashedUsername, p.sessionId));

      case 'tbankSaveSessionId':
        return jsonOk(tbankSaveSessionId(hashedUsername, p.sessionId));

      // >>> T-Bank накопительные счета и расписание переводов
      case 'tbankSaveVklad':
        return jsonOk(tbankSaveVklad(hashedUsername, p.vkladId, p.vkladName));

      case 'tbankGetVklad':
        return jsonOk(tbankGetVklad(hashedUsername));

      case 'tbankSaveTransferSchedule':
        return jsonOk(tbankSaveTransferSchedule(hashedUsername, p.transferToTime, p.transferFromTime));

      case 'tbankGetTransferSchedule':
        return jsonOk(tbankGetTransferSchedule(hashedUsername));

      case 'tbankForceTransferToSaving': {
        const result = tbankForceTransferToSaving(hashedUsername, p.sessionId);
        if (result && result.success === false) {
          return jsonErr(result.error || 'Ошибка при переводе средств');
        }
        return jsonOk(result);
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
    const requestId = (parts[1] || '').trim(); // Теперь только requestId
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;

    console.log('doPost data:', data, 'requestId:', requestId);

    const action = act === 'approve' ? 'APPROVED' : act === 'reject' ? 'REJECTED' : '';
    if (!requestId || !action) {
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

          // Получаем hashedUsername из таблицы по requestId
          const hashedUsername = reqSheet.getRange(reqRow, 2).getValue();
          console.log('doPost hashedUsername from sheet:', hashedUsername);

          if (reqSheet.getRange(reqRow, 4).getValue() === 'PENDING') {
            reqSheet.getRange(reqRow, 4).setValue(action);
            reqSheet.getRange(reqRow, 5).setValue(new Date()); // decidedAt
            // Don't overwrite column 6 (delivered) - it should remain false until user sees the result

            if (action === 'APPROVED') {
              const type = reqSheet.getRange(reqRow, 7).getValue();
              const amount = Number(reqSheet.getRange(reqRow, 8).getValue() || 0);
              console.log('doPost type:', type, 'amount:', amount);
              if (type === 'DEPOSIT' || type === 'WITHDRAW') {
                const usersSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
                const { row: userRow } = findOrCreateUserRow_(usersSheet, hashedUsername);

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
                  closeInvestmentsProportionally_(hashedUsername, withdrawAmount);
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

    // ВАЖНО: displayName НЕ хранится в БД - берем из контекста Telegram callback
    // Для отображения в Telegram используем хеш (никнейм не хранится нигде)
    const shortId = shortIdFromUuid(requestId);
    const text = action === 'APPROVED' ? `[#${shortId}] ✅ Одобрено.` : `[#${shortId}] ❌ Отклонено.`;
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
 * @param {string} hashedUsername - Хешированный никнейм пользователя.
 * @returns {Object} Object containing balance, history, portfolio, lockedAmount, and userPrefs.
 */
function getInitialData(hashedUsername) {
    // ОПТИМИЗАЦИЯ: Для первой загрузки используем быстрый getBalance() вместо syncBalance()
    // syncBalance() будет вызван позже через scheduleSync()
    const balanceData = getBalance(hashedUsername);
    const history = getHistory(hashedUsername);
    const portfolio = getPortfolio(hashedUsername);
    const userPrefs = getUserPrefs(hashedUsername);

    // ВАЖНО: accruedToday = todayIncome (для обратной совместимости)
    // todayIncome теперь считается правильно с учетом времени создания инвестиций

    return {
        ...balanceData,
        history,
        portfolio,
        accruedToday: balanceData.todayIncome,
        userPrefs
        // displayName будет добавлен в doGet() БЕЗ сохранения в БД
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
 * @param {string} hashedUsername - Хешированный никнейм пользователя.
 * @returns {Object} Object containing all calculated balances.
 */
function syncBalance(hashedUsername) {
  console.log('=== syncBalance START v9.0-FIXED-WITHDRAWAL ===', hashedUsername, new Date().toISOString());

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  const lock = LockService.getScriptLock();

  console.log('Trying to acquire lock...');
  if (!lock.tryLock(10000)) {
    console.log('Failed to acquire lock, returning getBalance()');
    return getBalance(hashedUsername);
    // displayName будет добавлен в doGet() БЕЗ сохранения в БД
  }

  console.log('Lock acquired');

  try {
    const { row } = findOrCreateUserRow_(usersSheet, hashedUsername);

    // 1. Reapply missed APPROVED deposit/withdraw requests
    console.log('Reapplying missed transactions...');
    reapplyMissedApproved_(hashedUsername);

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
    const investments = getPortfolio(hashedUsername);
    const investSheet = ensureInvestTransactionsSheet_();

    for (const inv of investments) {
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (!reqRow) continue;

      const createdAt = new Date(investSheet.getRange(reqRow, 1).getValue());
      const amount = Number(investSheet.getRange(reqRow, 8).getValue());
      const rate = Number(investSheet.getRange(reqRow, 9).getValue());

      // Считаем проценты с момента создания до СЕЙЧАС
      // Используем высокую точность (8 знаков) для внутренних расчётов
      const dailyRate = round8((rate / 100) / 365.25);
      const msElapsed = now.getTime() - createdAt.getTime();
      const daysElapsed = round8(msElapsed / (24 * 60 * 60 * 1000));
      const accrued = round8(amount * dailyRate * daysElapsed);

      // Сохраняем в колонку K (column 11) с округлением до 2 знаков для хранения
      investSheet.getRange(reqRow, 11).setValue(round2(accrued));

      console.log(`Updated investment ${inv.shortId}: accrued=${round2(accrued)}`);
    }

    // 3.5. Переносим разблокированные проценты 16% в userDeposits
    console.log('Processing unlocked 16% interest...');
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const lastSyncDate = new Date(lastSync.getFullYear(), lastSync.getMonth(), lastSync.getDate(), 0, 0, 0, 0);

    // Проверяем, прошла ли полночь с момента последней синхронизации
    if (todayStart > lastSyncDate) {
      console.log('Midnight has passed since last sync, unlocking 16% interest...');

      let totalUnlockedInterest = 0;

      for (const inv of investments) {
        if (inv.rate !== 16) continue; // Обрабатываем только 16%

        const reqRow = findRequestRowById_(investSheet, inv.requestId);
        if (!reqRow) continue;

        const createdAt = new Date(investSheet.getRange(reqRow, 1).getValue());
        const amount = Number(investSheet.getRange(reqRow, 8).getValue());

        // Вычисляем проценты, накопленные ДО сегодняшнего дня (которые должны разблокироваться)
        const dailyRate = round8((inv.rate / 100) / 365.25);
        const msUntilToday = Math.max(0, todayStart.getTime() - createdAt.getTime());
        const daysUntilToday = round8(msUntilToday / (24 * 60 * 60 * 1000));
        const accruedUntilToday = round8(amount * dailyRate * daysUntilToday);

        // Разблокированные проценты = проценты до сегодняшнего дня минус уже разблокированные ранее
        // (так как мы могли пропустить несколько дней)
        const unlockedInterest = round2(accruedUntilToday);

        if (unlockedInterest > 0) {
          totalUnlockedInterest = round8(totalUnlockedInterest + unlockedInterest);

          // Обнуляем accruedInterest для этой инвестиции (проценты теперь в userDeposits)
          // НО! Оставляем проценты за СЕГОДНЯ (они разблокируются завтра)
          const msElapsedToday = Math.max(0, now.getTime() - todayStart.getTime());
          const daysElapsedToday = round8(msElapsedToday / (24 * 60 * 60 * 1000));
          const todayInterestOnly = round8(amount * dailyRate * daysElapsedToday);

          investSheet.getRange(reqRow, 11).setValue(round2(todayInterestOnly));

          console.log(`Unlocked 16% interest for ${inv.shortId}: ${round2(unlockedInterest)}, today's interest: ${round2(todayInterestOnly)}`);
        }
      }

      if (totalUnlockedInterest > 0) {
        // Переносим разблокированные проценты в userDeposits (column 2)
        const currentUserDeposits = Number(usersSheet.getRange(row, 2).getValue() || 0);
        const newUserDeposits = round2(currentUserDeposits + totalUnlockedInterest);
        usersSheet.getRange(row, 2).setValue(newUserDeposits);

        // Дублируем в column 19 для обратной совместимости
        usersSheet.getRange(row, 19).setValue(newUserDeposits);

        console.log(`Total unlocked 16% interest: ${round2(totalUnlockedInterest)}, new userDeposits: ${newUserDeposits}`);
      }
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
      const userPrefs = getUserPrefs(hashedUsername);

      unfrozenInvestments.forEach(inv => {
        const reqRow = findRequestRowById_(investSheet, inv.requestId);
        if (reqRow) {
          if (userPrefs.autoRenew) {
            // Автопродление: создаём новую инвестицию с ТЕКУЩЕЙ ставкой из конфига
            const principal = inv.amount;
            const frozenInterest = inv.accruedInterest || 0;

            // Помечаем старую инвестицию как delivered
            investSheet.getRange(reqRow, 6).setValue(now);

            // Определяем тип инвестиции (STABLE или AGGRESSIVE) и берём ТЕКУЩУЮ ставку
            const oldRateConfig = getRateConfig(inv.rate);
            let newRateConfig;

            if (oldRateConfig.freezeDays === 30) {
              // Была 17% (Стабильный) → берём текущую ставку STABLE
              newRateConfig = INVESTMENT_RATES.STABLE;
            } else if (oldRateConfig.freezeDays === 90) {
              // Была 18% (Агрессивный) → берём текущую ставку AGGRESSIVE
              newRateConfig = INVESTMENT_RATES.AGGRESSIVE;
            } else {
              // На всякий случай используем старый конфиг
              newRateConfig = oldRateConfig;
            }

            const newRequestId = Utilities.getUuid();
            const newUnfreezeDate = new Date(now);
            newUnfreezeDate.setDate(newUnfreezeDate.getDate() + newRateConfig.freezeDays);

            const lastRow = investSheet.getLastRow() + 1;
            investSheet.getRange(lastRow, 1, 1, 11).setValues([[
              now,                          // A: createdAt
              hashedUsername,               // B: hashedUsername
              newRequestId,                 // C: requestId
              'APPROVED',                   // D: status (ИСПРАВЛЕНО!)
              now,                          // E: decidedAt (ИСПРАВЛЕНО!)
              null,                         // F: delivered (null = заморожено)
              'INVEST',                     // G: type (ИСПРАВЛЕНО!)
              principal,                    // H: amount (только principal, БЕЗ процентов)
              newRateConfig.rate,           // I: rate (ТЕКУЩАЯ ставка из конфига!)
              newRateConfig.freezeDays > 0 ? newUnfreezeDate : null, // J: unfreezeDate
              0                             // K: accruedInterest
            ]]);

            // НОВАЯ ЛОГИКА: Размороженные проценты добавляем в userDeposits (колонка B/2)
            const currentUserDeposits = Number(usersSheet.getRange(row, 2).getValue() || 0);
            const newUserDeposits = round2(currentUserDeposits + frozenInterest);
            usersSheet.getRange(row, 2).setValue(newUserDeposits);

            // Дублируем в column 19 для обратной совместимости
            usersSheet.getRange(row, 19).setValue(newUserDeposits);

            console.log(`Auto-renewed investment ${inv.shortId} (${inv.rate}% → ${newRateConfig.rate}%) → new ${shortIdFromUuid(newRequestId)}, frozen interest ${round2(frozenInterest)} → userDeposits`);
          } else {
            // Без автопродления: просто размораживаем
            investSheet.getRange(reqRow, 6).setValue(now);

            // НОВАЯ ЛОГИКА: Переносим проценты в userDeposits
            const frozenInterest = inv.accruedInterest || 0;
            if (frozenInterest > 0) {
              const currentUserDeposits = Number(usersSheet.getRange(row, 2).getValue() || 0);
              const newUserDeposits = round2(currentUserDeposits + frozenInterest);
              usersSheet.getRange(row, 2).setValue(newUserDeposits);

              // Дублируем в column 19 для обратной совместимости
              usersSheet.getRange(row, 19).setValue(newUserDeposits);

              console.log(`Unfrozen investment ${inv.shortId}, frozen interest ${round2(frozenInterest)} → userDeposits`);
            } else {
              console.log(`Unfrozen investment ${inv.shortId}`);
            }
          }
        }
      });
    }

    // 5. Обновляем lastSync
    usersSheet.getRange(row, 3).setValue(now);

    // 6. Возвращаем рассчитанные балансы из calculateBalances()
    console.log('Calculating balances...');
    const balances = calculateBalances(hashedUsername);
    // displayName будет добавлен в doGet() БЕЗ сохранения в БД

    // 7. Обновляем НЕТТО (колонка E/5) - общий баланс (депозиты + профиты)
    const totalBalance = round2(balances.userDeposits + balances.totalEarnings);
    usersSheet.getRange(row, 5).setValue(totalBalance);
    console.log('Updated НЕТТО (column E):', totalBalance);

    console.log('=== syncBalance END ===');
    return balances;

  } finally {
    lock.releaseLock();
    console.log('Lock released');
  }
}

/**
 * Requests a deposit or withdrawal for a user, sends notification to admin via Telegram, and logs the request.
 * @param {string} hashedUsername - Хешированный никнейм пользователя.
 * @param {string} displayName - Оригинальный никнейм для отображения в Telegram (НЕ сохраняется в БД).
 * @param {number} amount - The amount (positive for deposit, negative for withdrawal).
 * @param {string} type - 'DEPOSIT' or 'WITHDRAW'.
 * @param {Object} [details] - Additional details for withdrawal (method, phone, bank).
 * @returns {Object} Object with success status, requestId, and shortId.
 */
function requestAmount(hashedUsername, displayName, amount, type, details) {
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
            const balances = calculateBalances(hashedUsername);
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

    // ВАЖНО: displayName приходит из параметра (НЕ сохраняется в БД), используется ТОЛЬКО для Telegram уведомления
    console.log('requestAmount: displayName =', displayName, 'hashedUsername =', hashedUsername);

    let detailsText = "";
    if (type === 'WITHDRAW' && details) {
        if(details.method === 'sbp') {
            detailsText = `\nРеквизиты: СБП ${details.bank}, ${details.phone}`;
        }
    }

    const verb = amount > 0 ? 'депозит' : 'вывод';
    const pretty = Math.abs(amount).toLocaleString('ru-RU');
    let text = `[#${shortId}] Пользователь ${displayName} запросил ${verb} на ${pretty} ₽.${detailsText}`;

    console.log('Telegram message text:', text);
    console.log('Sending to chat:', ADMIN_CHAT_ID);

    // ВАЖНО: В callback_data НЕ передаем hashedUsername (превышает лимит 64 байта)
    // Вместо этого используем только requestId, username найдем по requestId в doPost
    const replyMarkup = { inline_keyboard: [[ { text: 'Да', callback_data: `approve:${requestId}` }, { text: 'Нет', callback_data: `reject:${requestId}` } ]] };

    let messageId = null;
    try {
        const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'post', contentType: 'application/json',
            payload: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: text, reply_markup: replyMarkup }),
            muteHttpExceptions: true
        });
        console.log('Telegram API response status:', response.getResponseCode());
        const jsonResponse = JSON.parse(response.getContentText());
        console.log('Telegram API response:', JSON.stringify(jsonResponse));
        messageId = jsonResponse.ok ? jsonResponse.result.message_id : null;

        if (!jsonResponse.ok) {
            console.error('Telegram API error:', jsonResponse.description);
        }
        reqSheet.appendRow([now, hashedUsername, requestId, 'PENDING', null, null, type, Number(amount)]);
        logToEventJournal(now, hashedUsername, requestId, 'PENDING', messageId, null, null, ADMIN_CHAT_ID, now, type, Number(amount), null, null);
    } catch(e) {
        console.error("TG notification failed:", e);
        reqSheet.appendRow([now, hashedUsername, requestId, 'PENDING', null, false, type, Number(amount)]);
        logToEventJournal(now, hashedUsername, requestId, 'PENDING', null, null, false, null, null, type, Number(amount), null, null);
    }

        return { success: true, requestSent: true, requestId, shortId };
    } catch (error) {
        console.error('Error in requestAmount:', error);
        return { success: false, error: error.message };
    }
}

function logStrategyInvestment(hashedUsername, amount, rate) {
    const reqSheet = ensureInvestTransactionsSheet_();
    const requestId = Utilities.getUuid();
    const shortId = shortIdFromUuid(requestId);
    const now = new Date();

    // Используем централизованный конфиг для получения freezeDays
    const rateConfig = getRateConfig(rate);
    const freezeDays = rateConfig.freezeDays;

    const unfreezeDate = new Date(now);
    unfreezeDate.setDate(unfreezeDate.getDate() + freezeDays);

    reqSheet.appendRow([now, hashedUsername, requestId, 'APPROVED', now, null, 'INVEST', Number(amount), Number(rate), unfreezeDate, 0]);
    logToEventJournal(now, hashedUsername, requestId, 'APPROVED', null, now, null, null, null, 'INVEST', Number(amount), Number(rate), unfreezeDate);

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
        .filter(row =>
            String(row[1]).trim() === username &&
            String(row[6]).trim() === 'INVEST' &&
            String(row[3]).trim() === 'APPROVED' &&
            !row[5]  // ИСПРАВЛЕНИЕ: исключаем размороженные инвестиции (delivered != null)
        )
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
    const total16 = portfolio16.reduce((sum, inv) => round8(sum + inv.amount), 0);
    portfolio16.forEach(inv => {
      const share = total16 > 0 ? round8((inv.amount / total16) * interest16) : 0;
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (reqRow) {
        const currentAccrued = Number(investSheet.getRange(reqRow, 11).getValue() || 0);
        investSheet.getRange(reqRow, 11).setValue(round2(round8(currentAccrued + share)));
      }
    });
  }

  // Update 17%/18% investments
  if (interest1718 > 0) {
    const portfolio1718 = portfolio.filter(inv => inv.rate === 17 || inv.rate === 18);
    const total1718 = portfolio1718.reduce((sum, inv) => round8(sum + inv.amount), 0);
    portfolio1718.forEach(inv => {
      const share = total1718 > 0 ? round8((inv.amount / total1718) * interest1718) : 0;
      const reqRow = findRequestRowById_(investSheet, inv.requestId);
      if (reqRow) {
        const currentAccrued = Number(investSheet.getRange(reqRow, 11).getValue() || 0);
        investSheet.getRange(reqRow, 11).setValue(round2(round8(currentAccrued + share)));
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
    // Используем высокую точность (8 знаков) для расчётов
    const dailyRate = round8((inv.rate / 100) / 365.25);

    // Считаем проценты с создания до начала сегодняшнего дня
    const msUntilToday = Math.max(0, todayStart.getTime() - createdAt.getTime());
    const daysUntilToday = round8(msUntilToday / (24 * 60 * 60 * 1000));
    const accruedUntilToday = round8(inv.amount * dailyRate * daysUntilToday);

    // Считаем проценты за сегодня (с начала дня или с момента создания, если создано сегодня)
    const effectiveStart = createdAt > todayStart ? createdAt : todayStart;
    const msElapsedToday = Math.max(0, now.getTime() - effectiveStart.getTime());
    const daysElapsedToday = round8(msElapsedToday / (24 * 60 * 60 * 1000));
    const earnedToday = round8(inv.amount * dailyRate * daysElapsedToday);

    todayIncome = round8(todayIncome + earnedToday);

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
      // НОВАЯ ЛОГИКА: Проценты 16% уже включены в userDeposits после разблокировки в полночь
      // Для 17%/18% добавляем проценты до сегодня (они разблокируются вместе с основной суммой)
      if (inv.rate === 17 || inv.rate === 18) {
        availableForWithdrawal = round8(availableForWithdrawal + accruedUntilToday);
      }
      // Для 16% НЕ добавляем accruedUntilToday, так как они уже в userDeposits
    }
  }

  // КРИТИЧЕСКИ ВАЖНО: Вычитаем заблокированную основную сумму 17%/18%
  availableForWithdrawal = round8(availableForWithdrawal - locked1718Principal);

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
            // Используем высокую точность (8 знаков) для расчётов
            const dailyRate = round8((investment.rate / 100) / 365.25);
            const days = round8(periodMs / (24 * 60 * 60 * 1000));
            const interestForPeriod = round8(investment.amount * dailyRate * days);
            totalInterest = round8(totalInterest + interestForPeriod);
        }
    });
    // Возвращаем с высокой точностью (8 знаков) для внутренних расчётов
    return round8(totalInterest);
}

function saveUserPrefs(hashedUsername, prefsString) {
    const prefsSheet = ensurePrefsSheet_();
    const prefs = JSON.parse(prefsString || '{}');
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);
    let sbpMethods = prefs.sbpMethods ? (Array.isArray(prefs.sbpMethods) ? prefs.sbpMethods : []) : [];

    // ВАЖНО: displayName НЕ сохраняется (соблюдение 152-ФЗ)
    prefsSheet.getRange(row, 1, 1, 5).setValues([[
        hashedUsername,
        JSON.stringify(sbpMethods),
        prefs.cryptoWallet || '',
        prefs.bankAccount || '',
        prefs.currency || 'RUB'
    ]]);
    return { success: true, savedPrefs: getUserPrefs(hashedUsername) };
}

function getUserPrefs(hashedUsername) {
    const prefsSheet = ensurePrefsSheet_();
    const { row, existed } = findUserRowInSheet_(prefsSheet, hashedUsername, false);
    if (!existed) return { currency: 'RUB', sbpMethods: [], autoRenew: true };
    const data = prefsSheet.getRange(row, 2, 1, 5).getValues()[0];
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
        currency: data[3] || 'RUB',
        autoRenew: data[4] === 'true' || data[4] === true || data[4] === undefined || data[4] === ''
        // displayName НЕ хранится (соблюдение 152-ФЗ)
    };
}

function setUserPref(hashedUsername, key, value) {
    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);
    const currentPrefs = getUserPrefs(hashedUsername);

    // Обновляем только указанное поле
    if (key === 'autoRenew') {
        const boolValue = value === 'true' || value === true;
        prefsSheet.getRange(row, 6).setValue(boolValue);
        currentPrefs.autoRenew = boolValue;
    } else if (key === 'currency') {
        prefsSheet.getRange(row, 5).setValue(value || 'RUB');
        currentPrefs.currency = value || 'RUB';
    }

    return { success: true, updatedPrefs: currentPrefs };
}

/**
 * Настройка вечернего процента для пользователя
 * @param {string} hashedUsername - Хешированный никнейм пользователя
 * @param {string|number} startTime - Час начала (0-23)
 * @param {string|number} endTime - Час окончания (0-23)
 * @param {string|boolean} agreed - Согласие с условиями
 * @returns {Object} Результат операции
 */
function setEveningPercent(hashedUsername, startTime, endTime, agreed, sessionId) {
    // Backend validation: проверка согласия
    const isAgreed = agreed === 'true' || agreed === true;
    if (!isAgreed) {
        return { success: false, error: 'Необходимо согласиться с условиями' };
    }

    // Проверка наличия sessionId (означает что T-Bank подключен)
    if (!sessionId) {
        return { success: false, error: 'Необходимо подключить Т-Банк' };
    }

    const start = parseInt(startTime);
    const end = parseInt(endTime);

    // Валидация времени
    if (isNaN(start) || isNaN(end) || start < 0 || start > 23 || end < 0 || end > 23) {
        return { success: false, error: 'Неверный формат времени' };
    }

    const prefsSheet = ensurePrefsSheet_();

    // Проверяем, есть ли уже колонки для вечернего процента
    const headers = prefsSheet.getRange(1, 1, 1, prefsSheet.getLastColumn()).getValues()[0];
    let eveningStartCol = headers.indexOf('eveningPercentStart') + 1;
    let eveningEndCol = headers.indexOf('eveningPercentEnd') + 1;
    let eveningEnabledCol = headers.indexOf('eveningPercentEnabled') + 1;
    let tbankSessionCol = headers.indexOf('tbankSessionId') + 1;

    // Если колонок нет, создаем их
    if (!eveningStartCol) {
        const lastCol = prefsSheet.getLastColumn();
        prefsSheet.getRange(1, lastCol + 1, 1, 4).setValues([['eveningPercentStart', 'eveningPercentEnd', 'eveningPercentEnabled', 'tbankSessionId']]);
        eveningStartCol = lastCol + 1;
        eveningEndCol = lastCol + 2;
        eveningEnabledCol = lastCol + 3;
        tbankSessionCol = lastCol + 4;
    }

    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);

    // Сохраняем настройки
    prefsSheet.getRange(row, eveningStartCol).setValue(start);
    prefsSheet.getRange(row, eveningEndCol).setValue(end);
    prefsSheet.getRange(row, eveningEnabledCol).setValue(true);
    prefsSheet.getRange(row, tbankSessionCol).setValue(sessionId);

    // Логируем операцию
    console.log(`Evening percent configured for user ${hashedUsername}: ${start}:00 - ${end}:00, sessionId: ${sessionId}`);

    return {
        success: true,
        startTime: start,
        endTime: end,
        enabled: true
    };
}

// ============================================================================
// T-BANK INTEGRATION (Proxy to Node.js Puppeteer Service)
// ============================================================================

// URL сервиса Puppeteer на Render
var TBANK_SERVICE_URL = 'https://homerbot.onrender.com/api';
// Таймаут для запросов к Puppeteer (login теперь асинхронный, возвращает сразу)
var TBANK_REQUEST_TIMEOUT = 30000; // 30 секунд

/**
 * Проверка доступности Puppeteer сервиса
 */
function tbankHealthCheck() {
  try {
    var options = {
      method: 'get',
      muteHttpExceptions: true,
      timeout: 60000 // 60 секунд для cold start
    };

    var response = UrlFetchApp.fetch(TBANK_SERVICE_URL.replace('/api', '') + '/health', options);
    var responseCode = response.getResponseCode();

    if (responseCode === 200) {
      return {
        success: true,
        status: 'online',
        message: 'Puppeteer сервис доступен'
      };
    } else {
      return {
        success: false,
        status: 'error',
        message: 'Сервис вернул код: ' + responseCode
      };
    }
  } catch (e) {
    Logger.log('[HEALTH CHECK] Error: ' + e.message);
    return {
      success: false,
      status: 'offline',
      message: 'Сервис недоступен: ' + e.message
    };
  }
}

/**
 * Прокси-функция для авторизации в T-Bank через Puppeteer сервис
 */
function tbankLogin(hashedUsername, phone) {
  try {
    console.log('[TBANK] tbankLogin called for user:', hashedUsername);

    // Проверяем, есть ли активная сессия для этого пользователя
    var existingSessionId = getTBankSessionId_(hashedUsername);
    console.log('[TBANK] Existing sessionId:', existingSessionId);

    // Если есть активная сессия, пытаемся её закрыть
    if (existingSessionId) {
      console.log('[TBANK] Found existing session, attempting to close it...');
      try {
        var logoutResult = tbankLogout(hashedUsername, existingSessionId);
        console.log('[TBANK] Logout result:', JSON.stringify(logoutResult));

        // Очищаем sessionId в базе независимо от результата logout
        saveTBankSessionId_(hashedUsername, '');
        console.log('[TBANK] Cleared sessionId in database');
      } catch (logoutError) {
        console.error('[TBANK] Error during logout, but continuing:', logoutError);
        // Очищаем sessionId в базе даже если logout упал
        saveTBankSessionId_(hashedUsername, '');
      }
    }

    var payload = JSON.stringify({
      username: hashedUsername,
      phone: phone
    });

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      muteHttpExceptions: true,
      timeout: TBANK_REQUEST_TIMEOUT
    };

    console.log('[TBANK] Sending login request...');
    var response = UrlFetchApp.fetch(TBANK_SERVICE_URL + '/auth/login', options);
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    // Проверка на HTML вместо JSON (сервер вернул ошибку)
    if (responseText.trim().startsWith('<')) {
      console.error('tbankLogin: Received HTML instead of JSON. Response code:', responseCode);
      return {
        success: false,
        error: 'Сервер Puppeteer недоступен или перезагружается. Попробуйте через 1-2 минуты.'
      };
    }

    var result = JSON.parse(responseText);
    console.log('[TBANK] Login successful, sessionId:', result.sessionId);
    return result;
  } catch (e) {
    console.error('tbankLogin error:', e);
    var errorStr = String(e);

    // Если таймаут из-за cold start, вернуть понятную ошибку
    if (errorStr.includes('timeout') || errorStr.includes('Timeout')) {
      return { success: false, error: 'Сервер запускается, попробуйте через 30-60 секунд (cold start)' };
    }

    // Если ошибка парсинга JSON
    if (errorStr.includes('JSON') || errorStr.includes('parse')) {
      return { success: false, error: 'Сервер Puppeteer перезагружается, попробуйте через 1-2 минуты' };
    }

    return { success: false, error: 'Ошибка подключения: ' + errorStr };
  }
}

/**
 * Проверка ожидающего ввода (SMS или номер карты)
 */
function tbankCheckPendingInput(hashedUsername, sessionId) {
  try {
    var url = TBANK_SERVICE_URL + '/auth/pending-input?sessionId=' + encodeURIComponent(sessionId);

    var options = {
      method: 'get',
      muteHttpExceptions: true,
      timeout: TBANK_REQUEST_TIMEOUT
    };

    var response = UrlFetchApp.fetch(url, options);
    var result = JSON.parse(response.getContentText());

    return result;
  } catch (e) {
    console.error('tbankCheckPendingInput error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Проверка ожидающего ввода от пользователя
 */
function tbankCheckPendingInput(hashedUsername, sessionId) {
  try {
    var url = TBANK_SERVICE_URL + '/auth/pending-input?sessionId=' + encodeURIComponent(sessionId) + '&username=' + encodeURIComponent(hashedUsername);

    var options = {
      method: 'get',
      muteHttpExceptions: true,
      timeout: TBANK_REQUEST_TIMEOUT
    };

    var response = UrlFetchApp.fetch(url, options);
    var result = JSON.parse(response.getContentText());

    return result;
  } catch (e) {
    console.error('[TBANK] tbankCheckPendingInput error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Отправка пользовательского ввода (SMS или номер карты)
 */
function tbankSubmitInput(hashedUsername, sessionId, value) {
  try {
    console.log('[TBANK] tbankSubmitInput called: submitting user input to Puppeteer');

    // Отправляем на Puppeteer сервер
    var payload = JSON.stringify({
      sessionId: sessionId,
      value: value
    });

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      muteHttpExceptions: true,
      timeout: TBANK_REQUEST_TIMEOUT
    };

    var response = UrlFetchApp.fetch(TBANK_SERVICE_URL + '/auth/submit-input', options);
    var result = JSON.parse(response.getContentText());

    return result;
  } catch (e) {
    console.error('[TBANK] tbankSubmitInput error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Сохраняет sessionId T-Bank в HB_UserPrefs (колонка G)
 */
function saveTBankSessionId_(hashedUsername, sessionId) {
  try {
    console.log('[TBANK] saveTBankSessionId_ START: user=' + hashedUsername + ', sessionId=' + sessionId);

    const prefsSheet = ensurePrefsSheet_();
    console.log('[TBANK] Got prefs sheet');

    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);
    console.log('[TBANK] Got row: ' + row);

    prefsSheet.getRange(row, 7).setValue(sessionId); // Колонка G = 7
    console.log('[TBANK] ✅ Successfully saved sessionId to row ' + row + ', column G');

    // Проверяем что сохранилось
    const savedValue = prefsSheet.getRange(row, 7).getValue();
    console.log('[TBANK] Verification: saved value = ' + savedValue);
  } catch (e) {
    console.error('[TBANK] ❌ Error saving sessionId: ' + e.message);
    console.error('[TBANK] Error stack: ' + e.stack);
  }
}

/**
 * Получает сохранённый sessionId T-Bank из HB_UserPrefs (колонка G)
 */
function getTBankSessionId_(hashedUsername) {
  try {
    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, false);

    const sessionId = prefsSheet.getRange(row, 7).getValue();
    console.log('[TBANK] Retrieved sessionId for user ' + hashedUsername + ': ' + (sessionId || 'none'));
    return sessionId || null;
  } catch (e) {
    console.error('[TBANK] Error retrieving sessionId: ' + e.message);
    return null;
  }
}

/**
 * Получить сохранённый sessionId из Google Sheets
 */
function tbankGetSessionId(hashedUsername) {
  try {
    const sessionId = getTBankSessionId_(hashedUsername);
    return {
      success: true,
      sessionId: sessionId
    };
  } catch (e) {
    console.error('[TBANK] Error getting sessionId:', e);
    return {
      success: false,
      error: String(e)
    };
  }
}

/**
 * Сохранить sessionId в Google Sheets (вызывается отдельным action)
 */
function tbankSaveSessionId(hashedUsername, sessionId) {
  try {
    saveTBankSessionId_(hashedUsername, sessionId);
    return {
      success: true,
      message: 'Session ID saved successfully'
    };
  } catch (e) {
    console.error('[TBANK] Error saving sessionId:', e);
    return {
      success: false,
      error: String(e)
    };
  }
}

/**
 * Сохраняет балансы счетов T-Bank в HB_UserPrefs (колонка H)
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @param {Array} accounts - Массив объектов счетов [{id, name, balance}, ...]
 */
function saveTBankBalances_(hashedUsername, accounts) {
  try {
    console.log('[TBANK] saveTBankBalances_ START: user=' + hashedUsername);
    console.log('[TBANK] Accounts to save:', JSON.stringify(accounts));

    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);

    // Создаём объект {accountId: {balance, name}}
    const balancesMap = {};
    accounts.forEach(function(acc) {
      balancesMap[acc.id] = {
        balance: acc.balance,
        name: acc.name || acc.id
      };
    });

    const balancesJson = JSON.stringify(balancesMap);
    prefsSheet.getRange(row, 8).setValue(balancesJson); // Колонка H = 8

    console.log('[TBANK] ✅ Successfully saved balances to row ' + row + ', column H: ' + balancesJson);
  } catch (e) {
    console.error('[TBANK] ❌ Error saving balances: ' + e.message);
    console.error('[TBANK] Error stack: ' + e.stack);
  }
}

/**
 * Получает сохранённые балансы T-Bank из HB_UserPrefs (колонка H)
 * @returns {Object} Объект {accountId: {balance, name}}
 */
function getTBankBalances_(hashedUsername) {
  try {
    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, false);

    const balancesJson = prefsSheet.getRange(row, 8).getValue();
    if (!balancesJson) {
      console.log('[TBANK] No saved balances for user ' + hashedUsername);
      return {};
    }

    const balances = JSON.parse(balancesJson);
    console.log('[TBANK] Retrieved balances for user ' + hashedUsername + ':', JSON.stringify(balances));
    return balances;
  } catch (e) {
    console.error('[TBANK] Error retrieving balances: ' + e.message);
    return {};
  }
}

/**
 * Прокси-функция для получения списка счетов T-Bank
 */
function tbankGetAccounts(hashedUsername, sessionId) {
  try {
    var url = TBANK_SERVICE_URL + '/accounts?username=' + encodeURIComponent(hashedUsername) +
              '&sessionId=' + encodeURIComponent(sessionId);

    var options = {
      method: 'get',
      muteHttpExceptions: true,
      timeout: TBANK_REQUEST_TIMEOUT
    };

    var response = UrlFetchApp.fetch(url, options);
    var result = JSON.parse(response.getContentText());

    // Если получены счета успешно - сохраняем балансы в HB_UserPrefs
    if (result && result.success && result.accounts && result.accounts.length > 0) {
      console.log('[TBANK] Saving ' + result.accounts.length + ' debit account balances to Google Sheets');
      saveTBankBalances_(hashedUsername, result.accounts);
    }

    // Если получены накопительные счета - сохраняем первый в HB_UserPrefs
    if (result && result.success && result.savingAccounts && result.savingAccounts.length > 0) {
      console.log('[TBANK] Found ' + result.savingAccounts.length + ' saving accounts');

      // Берем первый накопительный счёт
      var firstSaving = result.savingAccounts[0];
      console.log('[TBANK] Saving vklad data: id=' + firstSaving.id + ', name=' + firstSaving.name);

      saveTBankVklad_(hashedUsername, firstSaving.id, firstSaving.name);
    } else {
      console.log('[TBANK] No saving accounts found');
    }

    return result;
  } catch (e) {
    console.error('tbankGetAccounts error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Прокси-функция для отключения T-Bank (закрытие браузера)
 */
function tbankLogout(hashedUsername, sessionId) {
  try {
    var payload = JSON.stringify({
      username: hashedUsername,
      sessionId: sessionId
    });

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      muteHttpExceptions: true,
      timeout: TBANK_REQUEST_TIMEOUT
    };

    var response = UrlFetchApp.fetch(TBANK_SERVICE_URL + '/auth/logout', options);
    var result = JSON.parse(response.getContentText());

    return result;
  } catch (e) {
    console.error('tbankLogout error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Сохраняет данные о накопительном счёте в HB_UserPrefs
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @param {string} vkladId - ID накопительного счёта
 * @param {string} vkladName - Название накопительного счёта
 */
function saveTBankVklad_(hashedUsername, vkladId, vkladName) {
  try {
    console.log('[TBANK] saveTBankVklad_ START: user=' + hashedUsername + ', id=' + vkladId + ', name=' + vkladName);

    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);

    // Сохраняем ID в колонку I (9)
    prefsSheet.getRange(row, 9).setValue(vkladId);

    // Сохраняем название в колонку L (12)
    prefsSheet.getRange(row, 12).setValue(vkladName);

    console.log('[TBANK] ✅ Successfully saved vklad data to row ' + row);
  } catch (e) {
    console.error('[TBANK] ❌ Error saving vklad: ' + e.message);
    console.error('[TBANK] Error stack: ' + e.stack);
  }
}

/**
 * Получает данные о накопительном счёте из HB_UserPrefs
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @returns {Object} Объект {vkladId, vkladName}
 */
function getTBankVklad_(hashedUsername) {
  try {
    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, false);

    const vkladId = prefsSheet.getRange(row, 9).getValue();
    const vkladName = prefsSheet.getRange(row, 12).getValue();

    console.log('[TBANK] Retrieved vklad for user ' + hashedUsername + ':', JSON.stringify({vkladId, vkladName}));
    return {
      vkladId: vkladId || null,
      vkladName: vkladName || null
    };
  } catch (e) {
    console.error('[TBANK] Error retrieving vklad: ' + e.message);
    return { vkladId: null, vkladName: null };
  }
}

/**
 * Сохраняет расписание переводов на/с накопительного счёта
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @param {string} transferToTime - Время перевода на вклад (HH:MM)
 * @param {string} transferFromTime - Время перевода с вклада (HH:MM)
 */
function saveTBankTransferSchedule_(hashedUsername, transferToTime, transferFromTime, eveningTransferTime, morningTransferTime) {
  try {
    console.log('[TBANK] saveTBankTransferSchedule_ START: user=' + hashedUsername);
    console.log('[TBANK] To: ' + transferToTime + ', From: ' + transferFromTime);
    console.log('[TBANK] Evening: ' + eveningTransferTime + ', Morning: ' + morningTransferTime);

    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);

    // OLD T-Bank vklad system: Сохраняем время перевода на вклад в колонку J (10)
    if (transferToTime !== undefined) {
      prefsSheet.getRange(row, 10).setValue(transferToTime || '');
    }

    // OLD T-Bank vklad system: Сохраняем время перевода с вклада в колонку K (11)
    if (transferFromTime !== undefined) {
      prefsSheet.getRange(row, 11).setValue(transferFromTime || '');
    }

    // NEW: Evening transfer time (T-Bank -> Alfa saving) в колонку R (18)
    if (eveningTransferTime !== undefined) {
      prefsSheet.getRange(row, 18).setValue(eveningTransferTime || '');
    }

    // NEW: Morning transfer time (Alfa saving -> T-Bank) в колонку S (19)
    if (morningTransferTime !== undefined) {
      prefsSheet.getRange(row, 19).setValue(morningTransferTime || '');
    }

    console.log('[TBANK] ✅ Successfully saved transfer schedule to row ' + row);
  } catch (e) {
    console.error('[TBANK] ❌ Error saving transfer schedule: ' + e.message);
    console.error('[TBANK] Error stack: ' + e.stack);
  }
}

/**
 * Получает расписание переводов из HB_UserPrefs
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @returns {Object} Объект {transferToTime, transferFromTime}
 */
function getTBankTransferSchedule_(hashedUsername) {
  try {
    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, false);

    // OLD T-Bank vklad system (columns 10, 11)
    const transferToTime = prefsSheet.getRange(row, 10).getValue();
    const transferFromTime = prefsSheet.getRange(row, 11).getValue();

    // NEW: Evening/morning transfers (T-Bank <-> Alfa-Bank, columns 18, 19)
    const eveningTransferTime = prefsSheet.getRange(row, 18).getValue();
    const morningTransferTime = prefsSheet.getRange(row, 19).getValue();

    console.log('[TBANK] Retrieved schedule for user ' + hashedUsername + ':', JSON.stringify({
      transferToTime,
      transferFromTime,
      eveningTransferTime,
      morningTransferTime
    }));

    return {
      // OLD T-Bank vklad system
      transferToTime: transferToTime || null,
      transferFromTime: transferFromTime || null,
      // NEW: Evening/morning transfers
      eveningTransferTime: eveningTransferTime || null,
      morningTransferTime: morningTransferTime || null
    };
  } catch (e) {
    console.error('[TBANK] Error retrieving transfer schedule: ' + e.message);
    return {
      transferToTime: null,
      transferFromTime: null,
      eveningTransferTime: null,
      morningTransferTime: null
    };
  }
}

/**
 * Прокси-функция для сохранения данных о накопительном счёте
 */
function tbankSaveVklad(hashedUsername, vkladId, vkladName) {
  try {
    saveTBankVklad_(hashedUsername, vkladId, vkladName);
    return { success: true };
  } catch (e) {
    console.error('tbankSaveVklad error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Прокси-функция для получения данных о накопительном счёте
 */
function tbankGetVklad(hashedUsername) {
  try {
    return getTBankVklad_(hashedUsername);
  } catch (e) {
    console.error('tbankGetVklad error:', e);
    return { vkladId: null, vkladName: null };
  }
}

/**
 * Прокси-функция для сохранения расписания переводов
 */
function tbankSaveTransferSchedule(hashedUsername, transferToTime, transferFromTime, eveningTransferTime, morningTransferTime) {
  try {
    saveTBankTransferSchedule_(hashedUsername, transferToTime, transferFromTime, eveningTransferTime, morningTransferTime);
    return { success: true };
  } catch (e) {
    console.error('tbankSaveTransferSchedule error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Прокси-функция для получения расписания переводов
 */
function tbankGetTransferSchedule(hashedUsername) {
  try {
    return getTBankTransferSchedule_(hashedUsername);
  } catch (e) {
    console.error('tbankGetTransferSchedule error:', e);
    return {
      transferToTime: null,
      transferFromTime: null,
      eveningTransferTime: null,
      morningTransferTime: null
    };
  }
}

/****************************
 * ALFA-BANK CREDENTIALS & SETTINGS
 * Колонки в HB_UserPrefs:
 * M (13) - alfaPhone
 * N (14) - alfaCardNumber
 * O (15) - alfaSavingAccountId
 * P (16) - alfaSavingAccountName
 * Q (17) - userTimezone
 ****************************/

/**
 * Сохраняет учётные данные Альфа-Банка в HB_UserPrefs
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @param {string} phone - Номер телефона (хешированный)
 * @param {string} cardNumber - Номер карты (хешированный)
 * @param {string} savingAccountId - ID накопительного счёта
 * @param {string} savingAccountName - Название накопительного счёта
 */
function saveAlfaBankCredentials_(hashedUsername, phone, cardNumber, savingAccountId, savingAccountName) {
  try {
    console.log('[ALFA] saveAlfaBankCredentials_ START: user=' + hashedUsername);

    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);

    // Сохраняем телефон в колонку M (13)
    if (phone) {
      prefsSheet.getRange(row, 13).setValue(phone);
    }

    // Сохраняем номер карты в колонку N (14)
    if (cardNumber) {
      prefsSheet.getRange(row, 14).setValue(cardNumber);
    }

    // Сохраняем ID накопительного счёта в колонку O (15)
    if (savingAccountId) {
      prefsSheet.getRange(row, 15).setValue(savingAccountId);
    }

    // Сохраняем название накопительного счёта в колонку P (16)
    if (savingAccountName) {
      prefsSheet.getRange(row, 16).setValue(savingAccountName);
    }

    console.log('[ALFA] ✅ Successfully saved Alfa-Bank credentials to row ' + row);
  } catch (e) {
    console.error('[ALFA] ❌ Error saving Alfa credentials: ' + e.message);
    console.error('[ALFA] Error stack: ' + e.stack);
  }
}

/**
 * Получает учётные данные Альфа-Банка из HB_UserPrefs
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @returns {Object} Объект {phone, cardNumber, savingAccountId, savingAccountName}
 */
function getAlfaBankCredentials_(hashedUsername) {
  try {
    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, false);

    const phone = prefsSheet.getRange(row, 13).getValue();
    const cardNumber = prefsSheet.getRange(row, 14).getValue();
    const savingAccountId = prefsSheet.getRange(row, 15).getValue();
    const savingAccountName = prefsSheet.getRange(row, 16).getValue();

    console.log('[ALFA] Retrieved credentials for user ' + hashedUsername);
    return {
      phone: phone || null,
      cardNumber: cardNumber || null,
      savingAccountId: savingAccountId || null,
      savingAccountName: savingAccountName || null
    };
  } catch (e) {
    console.error('[ALFA] Error retrieving credentials: ' + e.message);
    return { phone: null, cardNumber: null, savingAccountId: null, savingAccountName: null };
  }
}

/**
 * Сохраняет timezone пользователя в HB_UserPrefs
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @param {string} timezone - Timezone (например, "Europe/Moscow")
 */
function saveUserTimezone_(hashedUsername, timezone) {
  try {
    console.log('[TIMEZONE] saveUserTimezone_ START: user=' + hashedUsername + ', tz=' + timezone);

    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, true);

    // Сохраняем timezone в колонку Q (17)
    prefsSheet.getRange(row, 17).setValue(timezone);

    console.log('[TIMEZONE] ✅ Successfully saved timezone to row ' + row);
  } catch (e) {
    console.error('[TIMEZONE] ❌ Error saving timezone: ' + e.message);
    console.error('[TIMEZONE] Error stack: ' + e.stack);
  }
}

/**
 * Получает timezone пользователя из HB_UserPrefs
 * @param {string} hashedUsername - Хешированное имя пользователя
 * @returns {string} Timezone или 'Europe/Moscow' по умолчанию
 */
function getUserTimezone_(hashedUsername) {
  try {
    const prefsSheet = ensurePrefsSheet_();
    const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, false);

    const timezone = prefsSheet.getRange(row, 17).getValue();

    console.log('[TIMEZONE] Retrieved timezone for user ' + hashedUsername + ':', timezone);
    return timezone || 'Europe/Moscow';
  } catch (e) {
    console.error('[TIMEZONE] Error retrieving timezone: ' + e.message);
    return 'Europe/Moscow';
  }
}

/**
 * Прокси-функция для сохранения учётных данных Альфа-Банка
 */
function alfaSaveCredentials(hashedUsername, phone, cardNumber, savingAccountId, savingAccountName) {
  try {
    saveAlfaBankCredentials_(hashedUsername, phone, cardNumber, savingAccountId, savingAccountName);
    return { success: true };
  } catch (e) {
    console.error('alfaSaveCredentials error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Прокси-функция для получения учётных данных Альфа-Банка
 */
function alfaGetCredentials(hashedUsername) {
  try {
    return getAlfaBankCredentials_(hashedUsername);
  } catch (e) {
    console.error('alfaGetCredentials error:', e);
    return { phone: null, cardNumber: null, savingAccountId: null, savingAccountName: null };
  }
}

/**
 * Прокси-функция для сохранения timezone пользователя
 */
function saveUserTimezone(hashedUsername, timezone) {
  try {
    saveUserTimezone_(hashedUsername, timezone);
    return { success: true };
  } catch (e) {
    console.error('saveUserTimezone error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Прокси-функция для получения timezone пользователя
 */
function getUserTimezone(hashedUsername) {
  try {
    return { timezone: getUserTimezone_(hashedUsername) };
  } catch (e) {
    console.error('getUserTimezone error:', e);
    return { timezone: 'Europe/Moscow' };
  }
}

/**
 * Принудительный перевод средств на накопительный счёт
 */
function tbankForceTransferToSaving(hashedUsername, sessionId) {
  try {
    console.log('[TBANK] tbankForceTransferToSaving called for user:', hashedUsername);

    if (!sessionId) {
      return { success: false, error: 'Отсутствует sessionId. Пожалуйста, войдите в Т-Банк заново.' };
    }

    // Отправляем запрос на Puppeteer сервер для выполнения перевода
    var url = TBANK_SERVICE_URL + '/transfer/to-saving?sessionId=' + encodeURIComponent(sessionId);

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ force: true }),
      muteHttpExceptions: true,
      timeout: TBANK_REQUEST_TIMEOUT
    };

    console.log('[TBANK] Sending force transfer request to:', url);
    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();

    console.log('[TBANK] Response code:', responseCode);

    if (responseCode !== 200) {
      console.error('[TBANK] Non-200 response:', response.getContentText());
      return {
        success: false,
        error: 'Сервис автоматизации Т-Банка временно недоступен. Код: ' + responseCode
      };
    }

    var result = JSON.parse(response.getContentText());

    console.log('[TBANK] Force transfer result:', JSON.stringify(result));
    return result;
  } catch (e) {
    console.error('[TBANK] tbankForceTransferToSaving error:', e);
    var errorMessage = String(e);

    // Более понятные сообщения об ошибках
    if (errorMessage.indexOf('DNS') !== -1 || errorMessage.indexOf('timeout') !== -1) {
      return { success: false, error: 'Сервис автоматизации Т-Банка временно недоступен. Попробуйте позже.' };
    }

    return { success: false, error: 'Ошибка при переводе средств: ' + errorMessage };
  }
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
    // Структура: Дата создания, Пользователь, Request ID, Статус, Message ID, Дата решения, Доставлено, Тип, Сумма, Ставка
    sheet.appendRow([
        createdAt,      // A: Дата создания
        username,       // B: Пользователь
        requestId,      // C: Request ID
        finalStatus,    // D: Статус
        messageId,      // E: Message ID
        decidedAt,      // F: Дата решения (была проблема - записывался null вместо даты)
        delivered,      // G: Доставлено
        type,           // H: Тип
        amount,         // I: Сумма
        rate            // J: Ставка
    ]);
}

function ensurePrefsSheet_() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(PREFS_SHEET);
    if (!sh) {
        sh = ss.insertSheet(PREFS_SHEET);
        // ВАЖНО: displayName НЕ хранится (соблюдение 152-ФЗ)
        sh.getRange(1, 1, 1, 19).setValues([['hashedUsername', 'sbpMethods (JSON)', 'cryptoWallet', 'bankAccount', 'currency', 'autoRenew', 'tbankSessionId', 'tbankBalances (JSON)', 'tbankVkladId', 'transferToVkladTime', 'transferFromVkladTime', 'tbankVkladName', 'alfaPhone', 'alfaCardNumber', 'alfaSavingAccountId', 'alfaSavingAccountName', 'userTimezone', 'eveningTransferTime', 'morningTransferTime']]);
    } else {
        // Проверяем, есть ли уже новые колонки, если нет - добавляем заголовки
        var header7 = sh.getRange(1, 7).getValue();
        if (!header7 || header7 === 'tbankCard' || header7 !== 'tbankSessionId') {
            sh.getRange(1, 7).setValue('tbankSessionId');
        }

        var header8 = sh.getRange(1, 8).getValue();
        if (!header8 || header8 !== 'tbankBalances (JSON)') {
            sh.getRange(1, 8).setValue('tbankBalances (JSON)');
        }

        var header9 = sh.getRange(1, 9).getValue();
        if (!header9 || header9 !== 'tbankVkladId') {
            sh.getRange(1, 9).setValue('tbankVkladId');
        }

        var header10 = sh.getRange(1, 10).getValue();
        if (!header10 || header10 !== 'transferToVkladTime') {
            sh.getRange(1, 10).setValue('transferToVkladTime');
        }

        var header11 = sh.getRange(1, 11).getValue();
        if (!header11 || header11 !== 'transferFromVkladTime') {
            sh.getRange(1, 11).setValue('transferFromVkladTime');
        }

        var header12 = sh.getRange(1, 12).getValue();
        if (!header12 || header12 !== 'tbankVkladName') {
            sh.getRange(1, 12).setValue('tbankVkladName');
        }

        // Новые колонки для Альфа-Банка
        var header13 = sh.getRange(1, 13).getValue();
        if (!header13 || header13 !== 'alfaPhone') {
            sh.getRange(1, 13).setValue('alfaPhone');
        }

        var header14 = sh.getRange(1, 14).getValue();
        if (!header14 || header14 !== 'alfaCardNumber') {
            sh.getRange(1, 14).setValue('alfaCardNumber');
        }

        var header15 = sh.getRange(1, 15).getValue();
        if (!header15 || header15 !== 'alfaSavingAccountId') {
            sh.getRange(1, 15).setValue('alfaSavingAccountId');
        }

        var header16 = sh.getRange(1, 16).getValue();
        if (!header16 || header16 !== 'alfaSavingAccountName') {
            sh.getRange(1, 16).setValue('alfaSavingAccountName');
        }

        var header17 = sh.getRange(1, 17).getValue();
        if (!header17 || header17 !== 'userTimezone') {
            sh.getRange(1, 17).setValue('userTimezone');
        }

        // Новые колонки для вечернего/утреннего переводов (T-Bank <-> Alfa-Bank)
        var header18 = sh.getRange(1, 18).getValue();
        if (!header18 || header18 !== 'eveningTransferTime') {
            sh.getRange(1, 18).setValue('eveningTransferTime');
        }

        var header19 = sh.getRange(1, 19).getValue();
        if (!header19 || header19 !== 'morningTransferTime') {
            sh.getRange(1, 19).setValue('morningTransferTime');
        }
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

      // Пересчитываем accruedInterest пропорционально с высокой точностью
      const oldAccrued = Number(investSheet.getRange(reqRow, 11).getValue() || 0);
      const ratio = round8(newAmount / currentAmount);
      const newAccrued = round2(round8(oldAccrued * ratio));
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
 * Requests columns: 1:createdAt,2:hashedUsername,3:requestId,4:status,5:messageId,
 * 6:processedAt,7:delivered,8:adminChatId,9:messageDate,10:type,11:amount,12:rate
 */
function reapplyMissedApproved_(hashedUsername) {
  if (!hashedUsername) return {applied:0, sum:0};

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const usersSheet = ss.getSheetByName(SHEET_NAME);

  const u = findOrCreateUserRow_(usersSheet, hashedUsername);
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

      if (user !== hashedUsername) continue;
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
 * Column 1: hashedUsername (хешированный никнейм для соблюдения 152-ФЗ)
 * Column 2: userDeposits (только депозиты/выводы, БЕЗ процентов)
 * Column 3: lastSync
 * Column 4: lastAppliedAt (для reapplyMissedApproved_)
 * Column 5: НЕТТО (общий баланс = депозиты + профиты, обновляется при каждой синхронизации)
 *
 * Все остальные колонки (19-21) оставлены для обратной совместимости,
 * но новая логика использует только columns 1-5.
 */
function findOrCreateUserRow_(sheet, hashedUsername) {
    const { row, existed } = findUserRowInSheet_(sheet, hashedUsername, true);
    if (!existed) {
        const now = new Date();
        // Инициализируем минимальные необходимые колонки
        // Column 1: hashedUsername
        // Column 2: userDeposits
        // Column 3: lastSync
        // Column 4: lastAppliedAt (для reapplyMissedApproved_)
        // Column 5: НЕТТО (общий баланс)
        sheet.getRange(row, 1, 1, 5).setValues([[hashedUsername, 0, now, now, 0]]);

        // Дополнительно инициализируем column 19 для обратной совместимости
        if (sheet.getMaxColumns() < 19) {
          const colsToAdd = 19 - sheet.getMaxColumns();
          sheet.insertColumnsAfter(sheet.getMaxColumns(), colsToAdd);
        }
        sheet.getRange(row, 19).setValue(0); // userDeposits дублируется в column 19 для старого кода
    }
    return { row, existed };
}
function findUserRowInSheet_(sheet, hashedUsername, createIfNotFound) {
    const lastRow = sheet.getLastRow();
    if (lastRow > 0) { // Check if sheet has any data
        const range = sheet.getRange(1, 1, lastRow, 1);
        const hashedUsernames = range.getValues();
        for (let i = 0; i < hashedUsernames.length; i++) {
            if (hashedUsernames[i][0] === hashedUsername) return { row: i + 1, existed: true };
        }
    }
    if (createIfNotFound) {
        const newRow = lastRow + 1;
        sheet.getRange(newRow, 1).setValue(hashedUsername);
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

/**
 * Создает успешный JSON ответ с CORS заголовками
 * ВАЖНО: Google Apps Script не поддерживает setHeader(), поэтому используется хак через callback
 */
function jsonOk(obj) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, ...obj }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Создает ошибочный JSON ответ с CORS заголовками
 */
function jsonErr(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}
function cancelPendingDeposit_(hashedUsername) {
  if (!hashedUsername) return false;
  var sheets = [ensureDepositWithdrawTransactionsSheet_()];
  for (var s = 0; s < sheets.length; s++) {
    var reqSheet = sheets[s];
    var lastRow = reqSheet.getLastRow();
    if (lastRow < 2) continue;

    var data = reqSheet.getRange(2, 1, lastRow - 1, reqSheet.getLastColumn()).getValues();
    // take the most "fresh" PENDING deposit of this user
    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      if (row[1] === hashedUsername && row[3] === 'PENDING' && row[6] === 'DEPOSIT') { // type in column 7 (0-indexed 6)
        var requestId = row[2]; // column 3 (0-indexed 2)
        reqSheet.getRange(i + 2, 4).setValue('CANCELED');     // status
        reqSheet.getRange(i + 2, 6).setValue(new Date());     // processedAt

        // Find and update admin message
        var messageId = findMessageIdForRequest_(requestId);
        if (messageId) {
          var shortId = shortIdFromUuid(requestId);
          // ВАЖНО: displayName НЕ хранится в БД, поэтому не показываем никнейм
          var text = `[#${shortId}] ❌ Отменено пользователем.`;
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

/**
 * Сохраняет chatId пользователя при первом взаимодействии
 * @param {string} hashedUsername - Хешированный никнейм пользователя
 * @param {string} chatId - Telegram chatId пользователя
 */
function saveChatId_(hashedUsername, chatId) {
  try {
    console.log(`saveChatId_ called: hashedUsername=${hashedUsername}, chatId=${chatId}`);

    if (!chatId) {
      console.log('No chatId provided, skipping save');
      return;
    }

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const usersSheet = ss.getSheetByName(SHEET_NAME);
    const { row } = findOrCreateUserRow_(usersSheet, hashedUsername);

    // Проверяем, есть ли уже chatId (колонка F = 6)
    const existingChatId = usersSheet.getRange(row, 6).getValue();
    console.log(`Existing chatId in row ${row}, column F (6): ${existingChatId}`);

    if (!existingChatId || existingChatId !== chatId) {
      usersSheet.getRange(row, 6).setValue(chatId);
      console.log(`✅ Saved chatId for user ${hashedUsername} in row ${row}, column F: ${chatId}`);
    } else {
      console.log(`ChatId already saved for user ${hashedUsername}`);
    }
  } catch (e) {
    console.error('Failed to save chatId:', e);
  }
}

/**
 * Отправляет уведомление пользователю об автопродлении инвестиции
 * @param {string} hashedUsername - Хешированный никнейм пользователя
 * @param {string} investmentName - Название инвестиции (например, "Стабильный")
 * @param {number} amount - Сумма инвестиции
 * @param {number} freezeDays - Срок заморозки в днях
 */
function sendAutoRenewalNotification_(hashedUsername, investmentName, amount, freezeDays) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const usersSheet = ss.getSheetByName(SHEET_NAME);
    const { row } = findOrCreateUserRow_(usersSheet, hashedUsername);

    let chatId = usersSheet.getRange(row, 6).getValue(); // Колонка F = 6

    if (!chatId) {
      console.log('ChatId not found for user, skipping auto-renewal notification');
      return;
    }

    const text = `✅ Завтра продлим вашу инвестицию *${investmentName}* с суммой *${round2(amount)} ₽* ещё на *${freezeDays} дней*!`;

    UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      }),
      muteHttpExceptions: true
    });

    console.log(`Auto-renewal notification sent to user ${hashedUsername}`);
  } catch (e) {
    console.error('Failed to send auto-renewal notification:', e);
  }
}

/**
 * Ежедневная проверка инвестиций, которые размораживаются завтра
 * Вызывается по триггеру каждый день в определенное время (например, в 12:00)
 */
function checkUpcomingRenewals() {
  console.log('=== checkUpcomingRenewals START ===', new Date().toISOString());

  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const investSheet = ss.getSheetByName(INVEST_TRANSACTIONS);
    const usersSheet = ss.getSheetByName(SHEET_NAME);

    if (!investSheet) {
      console.log('INVEST_TRANSACTIONS sheet not found');
      return;
    }

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const dayAfterTomorrow = new Date(tomorrow);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

    console.log('Checking for investments unfreezing tomorrow:', tomorrow.toISOString());

    const lastRow = investSheet.getLastRow();
    if (lastRow < 2) {
      console.log('No investments found');
      return;
    }

    const data = investSheet.getRange(2, 1, lastRow - 1, 10).getValues();

    // Группируем по пользователям
    const userInvestments = {};

    for (let i = 0; i < data.length; i++) {
      const createdAt = data[i][0];
      const hashedUsername = data[i][1];
      const status = data[i][4];
      const delivered = data[i][5];
      const amount = Number(data[i][7]);
      const rate = Number(data[i][8]);
      const unfreezeDate = data[i][9];

      // Пропускаем если не 17% или 18%
      if (rate !== 17 && rate !== 18) continue;

      // Пропускаем если уже разморожено
      if (delivered) continue;

      // Пропускаем если статус не APPROVED
      if (status !== 'APPROVED') continue;

      // Проверяем, размораживается ли завтра
      if (unfreezeDate instanceof Date) {
        const unfreezeDateOnly = new Date(unfreezeDate);
        unfreezeDateOnly.setHours(0, 0, 0, 0);

        if (unfreezeDateOnly >= tomorrow && unfreezeDateOnly < dayAfterTomorrow) {
          if (!userInvestments[hashedUsername]) {
            userInvestments[hashedUsername] = [];
          }

          userInvestments[hashedUsername].push({
            amount: amount,
            rate: rate,
            unfreezeDate: unfreezeDate
          });
        }
      }
    }

    // Отправляем уведомления пользователям
    let notificationsSent = 0;
    for (const hashedUsername in userInvestments) {
      const investments = userInvestments[hashedUsername];

      // Проверяем настройку автопродления
      const userPrefs = getUserPrefs(hashedUsername);
      if (!userPrefs.autoRenew) {
        console.log(`User ${hashedUsername} has autoRenew disabled, skipping notification`);
        continue;
      }

      // Получаем chatId (колонка F = 6)
      const { row } = findOrCreateUserRow_(usersSheet, hashedUsername);
      const chatId = usersSheet.getRange(row, 6).getValue();

      if (!chatId) {
        console.log(`ChatId not found for user ${hashedUsername}, skipping notification`);
        continue;
      }

      // Отправляем уведомление для каждой инвестиции
      for (const inv of investments) {
        const rateConfig = getRateConfig(inv.rate);
        sendAutoRenewalNotification_(hashedUsername, rateConfig.name, inv.amount, rateConfig.freezeDays);
        notificationsSent++;
      }
    }

    console.log(`=== checkUpcomingRenewals END: ${notificationsSent} notifications sent ===`);
  } catch (e) {
    console.error('checkUpcomingRenewals error:', e);
  }
}

/**
 * Устанавливает ежедневный триггер для проверки автопродлений
 * Запустить вручную один раз из Google Apps Script Editor
 */
function setupDailyRenewalCheckTrigger() {
  // Удаляем существующие триггеры для этой функции
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'checkUpcomingRenewals') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Создаём новый триггер: каждый день в 12:00
  ScriptApp.newTrigger('checkUpcomingRenewals')
    .timeBased()
    .atHour(12)
    .everyDays(1)
    .create();

  console.log('Daily renewal check trigger created (12:00 every day)');
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
 * ТЕСТОВАЯ ФУНКЦИЯ: Проверяет отправку Telegram уведомления администратору
 * Запустить вручную из Google Apps Script Editor для проверки
 */
function testTelegramNotification() {
  Logger.log('=== ТЕСТ TELEGRAM УВЕДОМЛЕНИЯ ===');
  Logger.log('BOT_TOKEN: ' + BOT_TOKEN);
  Logger.log('ADMIN_CHAT_ID: ' + ADMIN_CHAT_ID);

  const testUsername = 'test_user';
  const testHashedUsername = hashUsername(testUsername);
  const testRequestId = Utilities.getUuid();
  const testShortId = shortIdFromUuid(testRequestId);
  const testAmount = 1000;

  Logger.log('Хешированный никнейм: ' + testHashedUsername);
  Logger.log('Request ID: ' + testRequestId);
  Logger.log('Short ID: ' + testShortId);

  const text = `[#${testShortId}] ТЕСТ: Пользователь ${testUsername} запросил депозит на ${testAmount} ₽.`;
  Logger.log('Текст сообщения: ' + text);

  const replyMarkup = {
    inline_keyboard: [[
      { text: 'Да', callback_data: `approve:${testRequestId}` },
      { text: 'Нет', callback_data: `reject:${testRequestId}` }
    ]]
  };

  Logger.log('Reply markup: ' + JSON.stringify(replyMarkup));

  try {
    Logger.log('Отправка запроса в Telegram API...');
    const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: text,
        reply_markup: replyMarkup
      }),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    Logger.log('HTTP Response Code: ' + responseCode);
    Logger.log('HTTP Response Body: ' + responseText);

    const jsonResponse = JSON.parse(responseText);

    if (jsonResponse.ok) {
      Logger.log('✅ УСПЕХ! Сообщение отправлено.');
      Logger.log('Message ID: ' + jsonResponse.result.message_id);
    } else {
      Logger.log('❌ ОШИБКА от Telegram API:');
      Logger.log('Error code: ' + jsonResponse.error_code);
      Logger.log('Description: ' + jsonResponse.description);
    }

  } catch (e) {
    Logger.log('❌ ИСКЛЮЧЕНИЕ при отправке:');
    Logger.log('Error: ' + e.toString());
    Logger.log('Stack: ' + e.stack);
  }

  Logger.log('=== КОНЕЦ ТЕСТА ===');
}

/**
 * Форматирует таблицы для красивого отображения
 * Запускать один раз из редактора Google Apps Script
 */
function formatSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Форматирование HomerBot листа (упрощенная структура с хешированными никнеймами)
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  if (usersSheet) {
    // ВАЖНО: Сначала очищаем ВСЕ старые заголовки и стили (до колонки Z)
    const maxCols = usersSheet.getMaxColumns();
    if (maxCols > 5) {
      // Очищаем содержимое и форматирование старых колонок (6 и далее)
      usersSheet.getRange(1, 6, 1, maxCols - 5).clearContent().clearFormat();
    }

    // Заголовки для новой структуры (columns 1-5)
    usersSheet.getRange(1, 1, 1, 5).setValues([[
      'Хеш пользователя (SHA-256)', 'Депозиты пользователя', 'Последняя синхронизация', 'Последнее применение', 'НЕТТО'
    ]]);

    // Стили заголовков
    usersSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Авторазмер колонок
    usersSheet.autoResizeColumns(1, 5);
  }

  // Форматирование INVEST_TRANSACTIONS листа
  const investSheet = ensureInvestTransactionsSheet_();
  if (investSheet) {
    // Устанавливаем заголовки явно (на случай если лист уже существовал)
    investSheet.getRange(1, 1, 1, 11).setValues([[
      'Дата создания', 'Пользователь', 'Request ID', 'Статус', 'Дата решения',
      'Доставлено', 'Тип', 'Сумма', 'Ставка', 'Дата разморозки', 'Начисленные проценты'
    ]]);

    // Форматирование заголовков
    investSheet.getRange(1, 1, 1, 11).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Условное форматирование для столбца J (Дата разморозки)
    const lastRow = investSheet.getLastRow();
    if (lastRow > 1) {
      const unfreezeRange = investSheet.getRange(2, 10, lastRow - 1, 1);
      const now = new Date();

      // Красный: прошедшая дата или менее 7 дней
      const redRule = SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND(J2<>"", J2<DATEVALUE("' + now.toISOString().split('T')[0] + '")+7)')
        .setBackground('#ffcdd2')
        .setRanges([unfreezeRange])
        .build();

      // Жёлтый: 7-30 дней
      const yellowRule = SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND(J2<>"", J2>=DATEVALUE("' + now.toISOString().split('T')[0] + '")+7, J2<DATEVALUE("' + now.toISOString().split('T')[0] + '")+30)')
        .setBackground('#fff9c4')
        .setRanges([unfreezeRange])
        .build();

      // Зелёный: более 30 дней
      const greenRule = SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND(J2<>"", J2>=DATEVALUE("' + now.toISOString().split('T')[0] + '")+30)')
        .setBackground('#c8e6c9')
        .setRanges([unfreezeRange])
        .build();

      investSheet.setConditionalFormatRules([redRule, yellowRule, greenRule]);
    }

    // Авторазмер колонок
    investSheet.autoResizeColumns(1, 11);
  }

  // Форматирование DEPOSIT_WITHDRAW_TRANSACTIONS листа
  const dwSheet = ensureDepositWithdrawTransactionsSheet_();
  if (dwSheet) {
    // Устанавливаем заголовки явно (на случай если лист уже существовал)
    dwSheet.getRange(1, 1, 1, 9).setValues([[
      'Дата создания', 'Пользователь', 'Request ID', 'Статус', 'Дата решения',
      'Доставлено', 'Тип', 'Сумма', 'Применено к балансу'
    ]]);

    // Форматирование заголовков
    dwSheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Авторазмер колонок
    dwSheet.autoResizeColumns(1, 9);
  }

  // Форматирование HB_UserPrefs листа
  const prefsSheet = ensurePrefsSheet_();
  if (prefsSheet) {
    // Заголовки уже установлены в ensurePrefsSheet_(), просто форматируем
    prefsSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Авторазмер колонок
    prefsSheet.autoResizeColumns(1, 5);
  }

  // Форматирование EVENT_JOURNAL листа
  const eventSheet = ensureEventJournalSheet_();
  if (eventSheet) {
    // Устанавливаем заголовки явно (на случай если лист уже существовал)
    eventSheet.getRange(1, 1, 1, 10).setValues([[
      'Дата создания', 'Пользователь', 'Request ID', 'Статус', 'Message ID',
      'Дата решения', 'Доставлено', 'Тип', 'Сумма', 'Ставка'
    ]]);

    // Форматирование заголовков
    eventSheet.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#e3f2fd').setBorder(true, true, true, true, null, null);

    // Авторазмер колонок
    eventSheet.autoResizeColumns(1, 10);
  }

  Logger.log('Таблицы отформатированы! Все листы обновлены с учетом хеширования SHA-256.');
}

/****************************
 * EVENING PERCENT - Т-БАНК ИНТЕГРАЦИЯ
 ****************************/

/**
 * ВАЖНО: Для работы с Т-Банком API необходимо:
 * 1. Получить токен доступа через OAuth 2.0
 * 2. Сохранить токен в Properties Service
 * 3. Настроить webhook для обновления токена
 *
 * Это упрощенная реализация для демонстрации концепции.
 * В продакшене необходимо:
 * - Хранить токены безопасно
 * - Реализовать refresh token механизм
 * - Обрабатывать ошибки API
 * - Логировать все операции
 */

/**
 * Получает список счетов пользователя из Т-Банка
 * @param {string} accessToken - Токен доступа пользователя
 * @returns {Array} Массив счетов
 */
function getTBankAccounts_(accessToken) {
  try {
    const response = UrlFetchApp.fetch('https://api.tinkoff.ru/v1/accounts', {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());
    if (result.resultCode === 'OK') {
      return result.payload || [];
    }

    console.error('Failed to get T-Bank accounts:', result);
    return [];
  } catch (e) {
    console.error('getTBankAccounts_ error:', e);
    return [];
  }
}

/**
 * Переводит средства между счетами в Т-Банке
 * @param {string} accessToken - Токен доступа
 * @param {string} fromAccount - ID счета-источника
 * @param {string} toAccount - ID счета-получателя
 * @param {number} amount - Сумма перевода
 * @returns {Object} Результат операции
 */
function transferBetweenAccounts_(accessToken, fromAccount, toAccount, amount) {
  try {
    const response = UrlFetchApp.fetch('https://api.tinkoff.ru/v1/operations/transfer', {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        from: fromAccount,
        to: toAccount,
        amount: {
          value: amount,
          currency: 'RUB'
        }
      }),
      muteHttpExceptions: true
    });

    return JSON.parse(response.getContentText());
  } catch (e) {
    console.error('transferBetweenAccounts_ error:', e);
    return { success: false, error: e.toString() };
  }
}

/**
 * Создает накопительный счет в Т-Банке если его нет
 * @param {string} accessToken - Токен доступа
 * @returns {string|null} ID созданного счета или null
 */
function createSavingsAccount_(accessToken) {
  try {
    const response = UrlFetchApp.fetch('https://api.tinkoff.ru/v1/savings-accounts', {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        name: 'HomerBot Вечерний процент',
        currency: 'RUB'
      }),
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());
    if (result.resultCode === 'OK') {
      return result.payload.accountId;
    }

    return null;
  } catch (e) {
    console.error('createSavingsAccount_ error:', e);
    return null;
  }
}

/**
 * Получает токен доступа пользователя к Т-Банку
 * @param {string} hashedUsername - Хешированный никнейм
 * @returns {string|null} Токен или null
 */
function getTBankAccessToken_(hashedUsername) {
  const prefsSheet = ensurePrefsSheet_();
  const { row } = findUserRowInSheet_(prefsSheet, hashedUsername, false);

  if (!row) return null;

  // Проверяем наличие колонки для токена
  const headers = prefsSheet.getRange(1, 1, 1, prefsSheet.getLastColumn()).getValues()[0];
  let tokenCol = headers.indexOf('tbankAccessToken') + 1;

  if (!tokenCol) return null;

  return prefsSheet.getRange(row, tokenCol).getValue() || null;
}

/**
 * Ежедневная функция для перевода средств (вечерний процент)
 * Запускается по триггеру
 */
function processEveningPercentTransfers() {
  console.log('=== processEveningPercentTransfers START ===', new Date().toISOString());

  try {
    const prefsSheet = ensurePrefsSheet_();
    const lastRow = prefsSheet.getLastRow();

    if (lastRow < 2) {
      console.log('No users found');
      return;
    }

    const headers = prefsSheet.getRange(1, 1, 1, prefsSheet.getLastColumn()).getValues()[0];
    const startCol = headers.indexOf('eveningPercentStart') + 1;
    const endCol = headers.indexOf('eveningPercentEnd') + 1;
    const enabledCol = headers.indexOf('eveningPercentEnabled') + 1;

    if (!startCol || !endCol || !enabledCol) {
      console.log('Evening percent columns not found');
      return;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const data = prefsSheet.getRange(2, 1, lastRow - 1, prefsSheet.getLastColumn()).getValues();

    for (let i = 0; i < data.length; i++) {
      const hashedUsername = data[i][0];
      const startTime = data[i][startCol - 1];
      const endTime = data[i][endCol - 1];
      const enabled = data[i][enabledCol - 1];

      if (!enabled) continue;

      // Добавляем рандомизацию ±20 минут
      const randomOffset = Math.floor(Math.random() * 41) - 20; // -20 до +20

      const adjustedStartHour = startTime;
      const adjustedStartMinute = randomOffset;

      const adjustedEndHour = endTime;
      const adjustedEndMinute = randomOffset;

      // Проверяем, нужно ли выполнять перевод
      const shouldTransferToSavings =
        currentHour === adjustedStartHour &&
        Math.abs(currentMinute - adjustedStartMinute) <= 5;

      const shouldTransferBack =
        currentHour === adjustedEndHour &&
        Math.abs(currentMinute - adjustedEndMinute) <= 5;

      if (shouldTransferToSavings) {
        console.log(`Transferring to savings for user ${hashedUsername}`);
        executeEveningTransfer_(hashedUsername, 'to_savings');
      } else if (shouldTransferBack) {
        console.log(`Transferring back from savings for user ${hashedUsername}`);
        executeEveningTransfer_(hashedUsername, 'from_savings');
      }
    }

    console.log('=== processEveningPercentTransfers END ===');
  } catch (e) {
    console.error('processEveningPercentTransfers error:', e);
  }
}

/**
 * Выполняет перевод средств для вечернего процента
 * @param {string} hashedUsername - Хешированный никнейм
 * @param {string} direction - 'to_savings' или 'from_savings'
 */
function executeEveningTransfer_(hashedUsername, direction) {
  try {
    const accessToken = getTBankAccessToken_(hashedUsername);

    if (!accessToken) {
      console.log(`No T-Bank access token for user ${hashedUsername}`);
      return;
    }

    const accounts = getTBankAccounts_(accessToken);

    // Фильтруем дебетовые счета
    const debitAccounts = accounts.filter(acc =>
      acc.accountType === 'Debit' &&
      !acc.isSavings &&
      !acc.isCredit
    );

    // Ищем или создаем накопительный счет
    let savingsAccount = accounts.find(acc =>
      acc.isSavings &&
      acc.name === 'HomerBot Вечерний процент'
    );

    if (!savingsAccount && direction === 'to_savings') {
      const savingsAccountId = createSavingsAccount_(accessToken);
      if (!savingsAccountId) {
        console.error('Failed to create savings account');
        return;
      }
      savingsAccount = { accountId: savingsAccountId };
    }

    if (!savingsAccount) {
      console.log('No savings account found');
      return;
    }

    if (direction === 'to_savings') {
      // Переводим с дебетовых на накопительный
      for (const account of debitAccounts) {
        const balance = account.balance || 0;
        if (balance > 0) {
          transferBetweenAccounts_(
            accessToken,
            account.accountId,
            savingsAccount.accountId,
            balance
          );
          console.log(`Transferred ${balance} from ${account.accountId} to savings`);
        }
      }
    } else if (direction === 'from_savings') {
      // Возвращаем с накопительного на дебетовые
      const savingsBalance = savingsAccount.balance || 0;

      if (savingsBalance > 0 && debitAccounts.length > 0) {
        // Распределяем пропорционально исходным суммам
        // Для простоты возвращаем на первый дебетовый счет
        transferBetweenAccounts_(
          accessToken,
          savingsAccount.accountId,
          debitAccounts[0].accountId,
          savingsBalance
        );
        console.log(`Transferred ${savingsBalance} back from savings`);
      }
    }
  } catch (e) {
    console.error('executeEveningTransfer_ error:', e);
  }
}

/**
 * Устанавливает триггер для вечернего процента (каждый час)
 * Запустить вручную один раз
 */
function setupEveningPercentTrigger() {
  // Удаляем существующие триггеры
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'processEveningPercentTransfers') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Создаём триггер: каждый час
  ScriptApp.newTrigger('processEveningPercentTransfers')
    .timeBased()
    .everyHours(1)
    .create();

  console.log('Evening percent trigger created (every hour)');
}

/****************************
 * RENDER HEARTBEAT
 * Пингует Render сервер чтобы он не засыпал (Free Tier засыпает через 15 мин бездействия)
 ****************************/

/**
 * Пингует Render сервер чтобы он не засыпал
 * Должен запускаться триггером каждые 5 минут
 *
 * Для настройки триггера:
 * 1. В Apps Script Editor: Triggers (иконка часов слева)
 * 2. + Add Trigger
 * 3. Function: pingRenderService
 * 4. Event source: Time-driven
 * 5. Type: Minutes timer
 * 6. Interval: Every 5 minutes
 */
function pingRenderService() {
  try {
    var pingUrl = TBANK_SERVICE_URL.replace('/api', '') + '/ping';

    var options = {
      method: 'get',
      muteHttpExceptions: true,
      timeout: 5000 // 5 секунд таймаут
    };

    var response = UrlFetchApp.fetch(pingUrl, options);
    var responseCode = response.getResponseCode();

    if (responseCode === 200) {
      var result = JSON.parse(response.getContentText());
      console.log('[HEARTBEAT] ✅ Render ping successful:', result.timestamp, '| Active sessions:', result.activeSessions);
    } else {
      console.warn('[HEARTBEAT] ⚠️ Render ping returned code:', responseCode);
    }

  } catch (e) {
    console.error('[HEARTBEAT] ❌ Ping failed:', e.message);
    // Не бросаем ошибку, просто логируем - следующий пинг попробует снова
  }
}

/**
 * ======================================================
 * ФУНКЦИЯ ДЛЯ ИСПРАВЛЕНИЯ ОТРИЦАТЕЛЬНОГО БАЛАНСА
 * ======================================================
 * Пересчитывает userDeposits на основе всех APPROVED депозитов/выводов
 * Используйте эту функцию ОДИН РАЗ для исправления данных после миграции на v9.0
 *
 * ВАЖНО: Эта функция должна быть запущена ВРУЧНУЮ из Google Apps Script Editor
 * Выберите функцию fixNegativeBalance в редакторе и нажмите "Run"
 *
 * @param {string} [specificUsername] - Опционально: исправить только для конкретного пользователя (хешированный никнейм)
 */
function fixNegativeBalance(specificUsername) {
  console.log('=== FIX NEGATIVE BALANCE START ===');

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const usersSheet = ss.getSheetByName(SHEET_NAME);
  const depositWithdrawSheet = ensureDepositWithdrawTransactionsSheet_();

  const lastRow = usersSheet.getLastRow();
  if (lastRow < 2) {
    console.log('No users found');
    return;
  }

  const userData = usersSheet.getRange(2, 1, lastRow - 1, 19).getValues();
  let fixedCount = 0;

  for (let i = 0; i < userData.length; i++) {
    const row = i + 2; // Строка в таблице (с учетом заголовка)
    const hashedUsername = String(userData[i][0] || '').trim(); // Column A = index 0

    if (!hashedUsername) continue;

    // Если указан конкретный пользователь, пропускаем остальных
    if (specificUsername && hashedUsername !== specificUsername) continue;

    const currentUserDeposits = Number(userData[i][1] || 0); // Column B = index 1

    console.log(`Processing user: ${hashedUsername}, current userDeposits: ${currentUserDeposits}`);

    // Пересчитываем userDeposits на основе ВСЕХ APPROVED депозитов/выводов
    let calculatedDeposits = 0;

    // Читаем все транзакции из DEPOSIT_WITHDRAW_TRANSACTIONS
    const txLastRow = depositWithdrawSheet.getLastRow();
    if (txLastRow >= 2) {
      const txData = depositWithdrawSheet.getRange(2, 1, txLastRow - 1, 9).getValues();

      for (let j = 0; j < txData.length; j++) {
        const txUsername = String(txData[j][1] || '').trim(); // Column B = index 1
        const txStatus = String(txData[j][3] || '').trim(); // Column E = index 3 (status)
        const txType = String(txData[j][6] || '').trim(); // Column H = index 6 (type)
        const txAmount = Number(txData[j][7] || 0); // Column I = index 7 (amount)

        if (txUsername !== hashedUsername) continue;
        if (txStatus !== 'APPROVED') continue;

        if (txType === 'DEPOSIT') {
          calculatedDeposits += Math.abs(txAmount);
        } else if (txType === 'WITHDRAW') {
          calculatedDeposits -= Math.abs(txAmount);
        }
      }
    }

    console.log(`Calculated userDeposits: ${calculatedDeposits}`);

    // Обновляем только если значение изменилось
    if (Math.abs(currentUserDeposits - calculatedDeposits) > 0.01) {
      usersSheet.getRange(row, 2).setValue(round2(calculatedDeposits)); // Column B
      usersSheet.getRange(row, 19).setValue(round2(calculatedDeposits)); // Column S (обратная совместимость)

      console.log(`✅ Fixed user ${hashedUsername}: ${currentUserDeposits} → ${round2(calculatedDeposits)}`);
      fixedCount++;
    } else {
      console.log(`✓ User ${hashedUsername} is already correct`);
    }
  }

  console.log(`=== FIX NEGATIVE BALANCE END: Fixed ${fixedCount} users ===`);
  return { success: true, fixedCount: fixedCount };
}