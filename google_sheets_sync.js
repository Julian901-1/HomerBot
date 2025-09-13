/**
 * GOOGLE APPS SCRIPT ДЛЯ СИНХРОНИЗАЦИИ С TELEGRAM WALLET
 * Этот скрипт нужно развернуть как веб-приложение
 * Версия: 2.1 - с поддержкой обработки Telegram callback и webhook
 */

// Настройки
const SHEET_ID = '1eG_c2RcYcZs6jkJIPi8x4QXJBTBKTf2FwA33Ct7KxHg';
const SHEET_NAME = 'HomerBot';

// Константы для Telegram бота
const BOT_TOKEN = '7631840452:AAH4O93qQ6J914x5FhPTQX7YhJC3bTiJ_XA';
const ADMIN_CHAT_ID = '487525838';
var paymentStatuses = {};

/**
 * Обработка POST запросов
 */
function doPost(e) {
  try {
    Logger.log('POST request received');
    Logger.log('Raw data: ' + e.postData.contents);
    
    const data = JSON.parse(e.postData.contents);
    Logger.log('Parsed data: ' + JSON.stringify(data));
    
    // Проверяем, является ли это Telegram webhook
    if (data.callback_query) {
      Logger.log('Handling Telegram callback');
      return handleTelegramCallback(data.callback_query);
    }
    
    Logger.log('Handling action: ' + data.action);
    
    switch(data.action) {
      case 'updateBalance':
        return updateUserBalance(data.username, data.strategy, data.balance);
      case 'forceUpdateBalance':
        return forceUpdateBalance(data.username, data.newBalance);
      case 'sendNotification':
        return handleNotification(data);
      case 'setupWebhook':
        return createResponse(setupTelegramWebhook());
      case 'forceSetupWebhook':
        return createResponse(setupTelegramWebhook());
      case 'sendTestMessage':
        return sendTestWebhookMessage(data.chatId, data.message);
      default:
        Logger.log('Unknown action: ' + data.action);
        return createResponse({ 
          error: 'Unknown action: ' + data.action,
          availableActions: ['updateBalance', 'forceUpdateBalance', 'sendNotification']
        });
    }
  } catch (error) {
    Logger.log('Error in doPost: ' + error.toString());
    Logger.log('Error stack: ' + error.stack);
    return createResponse({ error: error.toString() });
  }
}

/**
 * Обработка GET запросов
 */
function doGet(e) {
  try {
    const action = e.parameter.action;
    Logger.log('GET request received with action: ' + action);
    
    switch(action) {
      case 'getBalance':
        return getBalanceByUsername(e.parameter.username);
      case 'getAllUsers':
        return getAllUsers();
      case 'checkPayment':
        const transactionId = e.parameter.transactionId;
        const status = paymentStatuses[transactionId] || { confirmed: false };
        return createResponse(status);
      case 'test':
        return createResponse({ 
          success: true, 
          message: 'Google Apps Script is working!', 
          timestamp: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
          version: '2.1'
        });
      case 'getWebhookInfo':
        return createResponse({ result: getWebhookInfo() });
      default:
        return createResponse({ 
          error: 'Unknown action: ' + action,
          availableActions: ['getBalance', 'getAllUsers', 'checkPayment', 'test']
        });
    }
  } catch (error) {
    Logger.log('Error in doGet: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Обработка Telegram callback запросов
 */
function handleTelegramCallback(callbackQuery) {
  try {
    const callbackData = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    
    Logger.log('Received callback: ' + callbackData);
    
    if (callbackData.startsWith('confirm_')) {
      const parts = callbackData.split('_');
      const transactionId = parts[1];
      const amount = parseFloat(parts[2]);
      let username = parts[3] || 'unknown_user';
      
      // Убираем @ если он есть для поиска в таблице
      const searchUsername = username.startsWith('@') ? username.substring(1) : username;
      
      Logger.log(`Processing payment for user: ${username}, amount: ${amount}`);
      
      // Сохраняем статус платежа
      paymentStatuses[transactionId] = { confirmed: true, amount: amount, username: username };
      
      // Находим пользователя по имени
      const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
      const data = sheet.getDataRange().getValues();
      
      let userRowIndex = -1;
      for (let i = 1; i < data.length; i++) {
        // Проверяем и с @ и без @
        if (data[i][0] === username || data[i][0] === searchUsername || 
            data[i][0] === '@' + searchUsername) {
          userRowIndex = i + 1;
          break;
        }
      }
      
      let newBalance;
      if (userRowIndex > 0) {
        const currentBalance = sheet.getRange(userRowIndex, 3).getValue() || 0;
        newBalance = currentBalance + amount;
        sheet.getRange(userRowIndex, 3).setValue(newBalance);
        sheet.getRange(userRowIndex, 4).setValue(new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }));
        
        Logger.log(`Payment confirmed for ${username}: +${amount}, new balance: ${newBalance}`);
      } else {
        // Создаем нового пользователя если не найден
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        newBalance = amount;
        sheet.appendRow([username, 'standard', amount, timestamp]);
        Logger.log(`New user created: ${username} with payment: ${amount}`);
      }
      
      // Обновляем статус платежа с новым балансом
      paymentStatuses[transactionId] = { 
        confirmed: true, 
        amount: amount, 
        username: username,
        newBalance: newBalance
      };
      
      answerCallbackQuery(callbackQuery.id, 'Платеж подтвержден!');
      editMessageText(chatId, messageId, `✅ Платеж подтвержден!\nСумма: ${amount} ✧\nID: ${transactionId}\nПользователь: ${username}\nНовый баланс: ${newBalance} ✧`);
      
    } else if (callbackData.startsWith('reject_')) {
      const parts = callbackData.split('_');
      const transactionId = parts[1];
      
      // Сохраняем статус отклонения
      paymentStatuses[transactionId] = { confirmed: false, rejected: true };
      
      Logger.log(`Payment rejected for transaction: ${transactionId}`);
      
      answerCallbackQuery(callbackQuery.id, 'Платеж отклонен');
      editMessageText(chatId, messageId, `❌ Платеж отклонен\nID: ${transactionId}\nПричина: Отклонено администратором`);
      
    } else if (callbackData.startsWith('test_confirm_') || callbackData.startsWith('test_reject_')) {
      // Обработка тестовых кнопок
      const isConfirm = callbackData.startsWith('test_confirm_');
      const testId = callbackData.split('_')[2];
      
      Logger.log(`Test callback received: ${callbackData}`);
      
      answerCallbackQuery(callbackQuery.id, isConfirm ? 'Тест пройден!' : 'Тест отклонен');
      editMessageText(chatId, messageId, `${isConfirm ? '✅' : '❌'} Тест webhook ${isConfirm ? 'успешен' : 'отклонен'}!\n\nWebhook работает правильно - кнопки обрабатываются.`);
    }
    
    return createResponse({ success: true });
  } catch (error) {
    Logger.log('Error handling callback: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Отправка ответа на callback query
 */
function answerCallbackQuery(callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  const payload = {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: false
  };
  
  UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload)
  });
}

/**
 * Редактирование сообщения
 */
function editMessageText(chatId, messageId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text
  };
  
  UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload)
  });
}

/**
 * Настройка Telegram webhook
 */
function setupTelegramWebhook() {
  try {
    // Получаем URL текущего веб-приложения автоматически
    const webhookUrl = ScriptApp.getService().getUrl();
    
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
    const payload = {
      url: webhookUrl
    };
    
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    
    const result = JSON.parse(response.getContentText());
    Logger.log('Webhook setup result:', result);
    
    if (result.ok) {
      sendAdminNotification('🔗 Telegram webhook настроен успешно!');
    } else {
      sendAdminNotification('❌ Ошибка настройки webhook: ' + result.description);
    }
    
    return result;
  } catch (error) {
    Logger.log('Error setting up webhook: ' + error.toString());
    sendAdminNotification('❌ Ошибка настройки webhook: ' + error.toString());
    return null;
  }
}

/**
 * Получение информации о webhook
 */
function getWebhookInfo() {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`;
    const response = UrlFetchApp.fetch(url);
    const result = JSON.parse(response.getContentText());
    
    Logger.log('Webhook info:', result);
    return result;
  } catch (error) {
    Logger.log('Error getting webhook info: ' + error.toString());
    return null;
  }
}

/**
 * Обновление баланса пользователя
 */
function updateUserBalance(username, strategy, balance) {
  try {
    Logger.log(`Updating balance for user: ${username}, strategy: ${strategy}, balance: ${balance}`);
    
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    
    Logger.log(`Sheet has ${data.length} rows`);
    
    // Убираем @ если он есть для поиска в таблице
    const searchUsername = username.startsWith('@') ? username.substring(1) : username;
    
    // Поиск пользователя (начиная со второй строки)
    let userRowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      // Проверяем и с @ и без @
      if (data[i][0] === username || data[i][0] === searchUsername || 
          data[i][0] === '@' + searchUsername) {
        userRowIndex = i + 1;
        Logger.log(`User found at row ${userRowIndex}`);
        break;
      }
    }
    
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    
    // Если пользователь не найден, добавляем новую строку
    if (userRowIndex === -1) {
      sheet.appendRow([username, strategy, balance, timestamp]);
      Logger.log(`New user added: ${username}, strategy: ${strategy}, balance: ${balance}`);
    } else {
      // Проверяем, был ли баланс изменен администратором
      const currentSheetBalance = data[userRowIndex - 1][2] || 0;
      const balanceDifference = Math.abs(currentSheetBalance - balance);
      
      Logger.log(`Current sheet balance: ${currentSheetBalance}, App balance: ${balance}, Difference: ${balanceDifference}`);
      
      if (balanceDifference > 1 && currentSheetBalance !== balance) {
        Logger.log(`Admin may have changed balance for ${username}. Sheet: ${currentSheetBalance}, App: ${balance}`);
        return createResponse({ 
          success: true, 
          message: 'Balance not updated - admin override detected',
          adminBalance: currentSheetBalance 
        });
      }
      
      // Обновляем существующую строку
      sheet.getRange(userRowIndex, 2).setValue(strategy);
      sheet.getRange(userRowIndex, 3).setValue(balance);
      sheet.getRange(userRowIndex, 4).setValue(timestamp);
      Logger.log(`User updated: ${username}, strategy: ${strategy}, balance: ${balance}`);
    }
    
    return createResponse({ success: true, message: 'Balance updated successfully' });
  } catch (error) {
    Logger.log('Error updating balance: ' + error.toString());
    Logger.log('Error stack: ' + error.stack);
    return createResponse({ error: error.toString() });
  }
}

/**
 * Получение баланса пользователя по имени
 */
function getBalanceByUsername(username) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    
    // Убираем @ для поиска если он есть
    const searchUsername = username.startsWith('@') ? username.substring(1) : username;
    
    // Поиск пользователя (начиная со второй строки)
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === username || data[i][0] === searchUsername || 
          data[i][0] === '@' + searchUsername) {
        return createResponse({ 
          balance: data[i][2] || 1000,
          strategy: data[i][1] || 'standard',
          username: data[i][0],
          lastUpdate: data[i][3] || ''
        });
      }
    }
    
    // Пользователь не найден - создаем с дефолтными значениями
    const defaultBalance = 1000;
    const defaultStrategy = 'standard';
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    
    sheet.appendRow([username, defaultStrategy, defaultBalance, timestamp]);
    Logger.log(`New user created with defaults: ${username}`);
    
    return createResponse({ 
      balance: defaultBalance, 
      strategy: defaultStrategy,
      username: username,
      lastUpdate: timestamp
    });
  } catch (error) {
    Logger.log('Error getting balance: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Принудительное обновление баланса администратором
 */
function forceUpdateBalance(username, newBalance) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === username) {
        const oldBalance = data[i][2];
        sheet.getRange(i + 1, 3).setValue(newBalance);
        sheet.getRange(i + 1, 4).setValue(new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }));
        
        Logger.log(`Admin force updated balance for ${username}: ${oldBalance} -> ${newBalance}`);
        sendAdminNotification(`Баланс пользователя ${username} изменен: ${oldBalance} → ${newBalance} ✧`);
        
        return true;
      }
    }
    
    return false;
  } catch (error) {
    Logger.log('Error force updating balance: ' + error.toString());
    return false;
  }
}

/**
 * Получение всех пользователей
 */
function getAllUsers() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    
    const users = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        users.push({
          username: data[i][0],
          strategy: data[i][1] || 'standard',
          balance: data[i][2] || 0,
          lastUpdate: data[i][3] || ''
        });
      }
    }
    
    return createResponse({ users: users });
  } catch (error) {
    Logger.log('Error getting all users: ' + error.toString());
    return createResponse({ error: error.toString(), users: [] });
  }
}

/**
 * Обработка уведомлений от приложения
 */
function handleNotification(data) {
  try {
    Logger.log('Handling notification:', data);
    
    switch(data.type) {
      case 'deposit':
        return handleDepositNotification(data);
      case 'withdraw':
        return handleWithdrawNotification(data);
      case 'strategy_change':
        return handleStrategyChangeNotification(data);
      default:
        Logger.log('Unknown notification type:', data.type);
        return createResponse({ error: 'Unknown notification type' });
    }
  } catch (error) {
    Logger.log('Error handling notification: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Обработка уведомления о депозите
 */
function handleDepositNotification(data) {
  try {
    const keyboard = {
      inline_keyboard: [[
        { text: 'Да', callback_data: `confirm_${data.transactionId}_${data.amount}_${data.userId}` },
        { text: 'Нет', callback_data: `reject_${data.transactionId}` }
      ]]
    };

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: ADMIN_CHAT_ID,
      text: data.message,
      reply_markup: JSON.stringify(keyboard)
    };
    
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    
    const result = JSON.parse(response.getContentText());
    Logger.log('Deposit notification sent:', result);
    
    return createResponse({ 
      success: true, 
      messageId: result.result ? result.result.message_id : null 
    });
  } catch (error) {
    Logger.log('Error sending deposit notification: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Обработка уведомления о выводе
 */
function handleWithdrawNotification(data) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: ADMIN_CHAT_ID,
      text: data.message,
      parse_mode: 'HTML'
    };
    
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    
    const result = JSON.parse(response.getContentText());
    Logger.log('Withdraw notification sent:', result);
    
    return createResponse({ success: true });
  } catch (error) {
    Logger.log('Error sending withdraw notification: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Обработка уведомления о смене стратегии
 */
function handleStrategyChangeNotification(data) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: ADMIN_CHAT_ID,
      text: data.message,
      parse_mode: 'HTML'
    };
    
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    
    const result = JSON.parse(response.getContentText());
    Logger.log('Strategy change notification sent:', result);
    
    return createResponse({ success: true });
  } catch (error) {
    Logger.log('Error sending strategy change notification: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Отправка тестового сообщения с кнопками для проверки webhook
 */
function sendTestWebhookMessage(chatId, message) {
  try {
    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Да', callback_data: 'test_confirm_' + Date.now() },
        { text: '❌ Нет', callback_data: 'test_reject_' + Date.now() }
      ]]
    };

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: chatId || ADMIN_CHAT_ID,
      text: message || '🧪 Тест webhook - нажмите любую кнопку',
      reply_markup: JSON.stringify(keyboard)
    };
    
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    
    const result = JSON.parse(response.getContentText());
    Logger.log('Test message sent:', result);
    
    return createResponse({ 
      success: result.ok, 
      result: result,
      messageId: result.result ? result.result.message_id : null 
    });
  } catch (error) {
    Logger.log('Error sending test message: ' + error.toString());
    return createResponse({ error: error.toString() });
  }
}

/**
 * Отправка уведомления администратору
 */
function sendAdminNotification(message) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: ADMIN_CHAT_ID,
      text: `🔧 ${message}`,
      parse_mode: 'HTML'
    };
    
    UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    
    Logger.log('Admin notification sent: ' + message);
  } catch (error) {
    Logger.log('Error sending admin notification: ' + error.toString());
  }
}

/**
 * Создание ответа в формате JSON
 */
function createResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Инициализация таблицы
 */
function initializeSheet() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    
    // Проверяем, есть ли заголовки
    const firstRow = sheet.getRange(1, 1, 1, 4).getValues()[0];
    
    if (!firstRow[0] || firstRow[0] !== 'Username') {
      // Создаем заголовки
      sheet.getRange(1, 1, 1, 4).setValues([['Username', 'Strategy', 'Balance', 'Last Update']]);
      
      // Форматируем заголовки
      const headerRange = sheet.getRange(1, 1, 1, 4);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#4285f4');
      headerRange.setFontColor('#ffffff');
      
      Logger.log('Sheet initialized with headers');
      sendAdminNotification('📋 Таблица HomerBot инициализирована с заголовками');
    }
    
    return true;
  } catch (error) {
    Logger.log('Error initializing sheet: ' + error.toString());
    return false;
  }
}

/**
 * ТЕСТОВЫЕ ФУНКЦИИ
 */
function testAddUser() {
  const result = updateUserBalance('testuser', 'balanced', 5000);
  Logger.log('Test add user result: ' + result.getContent());
}

function testGetBalance() {
  const result = getBalanceByUsername('testuser');
  Logger.log('Test get balance result: ' + result.getContent());
}

function testWebhookSetup() {
  const result = setupTelegramWebhook();
  Logger.log('Webhook setup test result:', result);
}

/**
 * ФУНКЦИИ ДЛЯ АДМИНИСТРИРОВАНИЯ
 */

/**
 * Функция для массового обновления балансов
 * Полезна для начисления бонусов или корректировок
 */
function massBalanceUpdate(multiplier = 1.1) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    let updatedCount = 0;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][2]) { // Если есть имя пользователя и баланс
        const oldBalance = data[i][2];
        const newBalance = oldBalance * multiplier;
        sheet.getRange(i + 1, 3).setValue(newBalance);
        sheet.getRange(i + 1, 4).setValue(new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }));
        updatedCount++;
      }
    }
    
    const message = `Массовое обновление балансов завершено. Обновлено ${updatedCount} пользователей с множителем ${multiplier}`;
    Logger.log(message);
    sendAdminNotification(message);
    
    return updatedCount;
  } catch (error) {
    Logger.log('Error in mass balance update: ' + error.toString());
    return 0;
  }
}

/**
 * Функция для очистки неактивных пользователей
 * Удаляет пользователей с балансом 0 или пустым балансом
 */
function cleanInactiveUsers() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    let deletedCount = 0;
    
    // Идем снизу вверх, чтобы не сбить индексы при удалении
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][2] === 0 || data[i][2] === '' || data[i][2] === null) {
        sheet.deleteRow(i + 1);
        deletedCount++;
      }
    }
    
    const message = `Очистка неактивных пользователей завершена. Удалено ${deletedCount} записей`;
    Logger.log(message);
    sendAdminNotification(message);
    
    return deletedCount;
  } catch (error) {
    Logger.log('Error cleaning inactive users: ' + error.toString());
    return 0;
  }
}

/**
 * Функция для получения статистики
 */
function getStatistics() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    
    let totalUsers = 0;
    let totalBalance = 0;
    const strategies = { standard: 0, balanced: 0, aggressive: 0 };
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) { // Если есть имя пользователя
        totalUsers++;
        totalBalance += data[i][2] || 0;
        
        const strategy = data[i][1] || 'standard';
        if (strategies[strategy] !== undefined) {
          strategies[strategy]++;
        }
      }
    }
    
    const stats = {
      totalUsers: totalUsers,
      totalBalance: totalBalance,
      averageBalance: totalUsers > 0 ? totalBalance / totalUsers : 0,
      strategies: strategies
    };
    
    Logger.log('Statistics:', stats);
    return stats;
  } catch (error) {
    Logger.log('Error getting statistics: ' + error.toString());
    return null;
  }
}

/**
 * ТРИГГЕРЫ И АВТОМАТИЗАЦИЯ
 */

/**
 * Функция для создания триггера, который будет проверять изменения в таблице
 */
function createSheetChangesTrigger() {
  // Удаляем существующие триггеры для этой функции
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Создаем новый триггер
  ScriptApp.newTrigger('onSheetEdit')
    .onEdit()
    .create();
    
  Logger.log('Sheet changes trigger created');
}

/**
 * Обработчик изменений в таблице
 */
function onSheetEdit(e) {
  try {
    const range = e.range;
    const sheet = e.source.getActiveSheet();
    
    // Проверяем, что изменения в нужном листе и в столбце C (баланс)
    if (sheet.getName() === SHEET_NAME && range.getColumn() === 3) {
      const row = range.getRow();
      if (row > 1) { // Не первая строка (заголовки)
        const username = sheet.getRange(row, 1).getValue();
        const newBalance = range.getValue();
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        
        // Обновляем время последнего изменения
        sheet.getRange(row, 4).setValue(timestamp);
        
        Logger.log(`Admin manually changed balance for user ${username} to ${newBalance}`);
        
        sendAdminNotification(`Баланс пользователя ${username} изменен вручную на ${newBalance} ✧`);
        
        // Проверяем корректность введенного значения
        if (isNaN(newBalance) || newBalance < 0) {
          sendAdminNotification(`⚠️ ВНИМАНИЕ: Некорректное значение баланса для ${username}: ${newBalance}`);
        }
      }
    }
  } catch (error) {
    Logger.log('Error in onSheetEdit: ' + error.toString());
    sendAdminNotification(`❌ Ошибка при обработке изменений: ${error.toString()}`);
  }
}

/**
 * Создание триггера для ежедневной статистики
 */
function createDailyStatsTrigger() {
  // Удаляем существующие триггеры
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'sendDailyStats') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Создаем новый триггер на каждый день в 9:00
  ScriptApp.newTrigger('sendDailyStats')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
    
  Logger.log('Daily stats trigger created');
}

/**
 * Отправка ежедневной статистики админу
 */
function sendDailyStats() {
  try {
    const stats = getStatistics();
    if (!stats) return;
    
    const message = `📊 Ежедневная статистика HomerBot:

👥 Всего пользователей: ${stats.totalUsers}
💰 Общий баланс: ${stats.totalBalance.toFixed(2)} ✧
📈 Средний баланс: ${stats.averageBalance.toFixed(2)} ✧

📋 Распределение по стратегиям:
• Стандартная: ${stats.strategies.standard}
• Сбалансированная: ${stats.strategies.balanced}
• Агрессивная: ${stats.strategies.aggressive}`;

    sendAdminNotification(message);
    Logger.log('Daily stats sent');
  } catch (error) {
    Logger.log('Error sending daily stats: ' + error.toString());
  }
}

/**
 * ИНСТРУКЦИИ ПО НАСТРОЙКЕ
 * 
 * 1. Замените SHEET_ID, BOT_TOKEN, ADMIN_CHAT_ID на ваши значения
 * 2. Развертите как веб-приложение с доступом "Все"
 * 3. Выполните функции по порядку:
 *    - initializeSheet()          // создает заголовки в таблице
 *    - setupTelegramWebhook()     // настраивает webhook для кнопок
 *    - createSheetChangesTrigger() // опционально: отслеживание изменений
 *    - createDailyStatsTrigger()   // опционально: ежедневная статистика
 * 4. Скопируйте URL веб-приложения и вставьте в HTML-приложение
 */