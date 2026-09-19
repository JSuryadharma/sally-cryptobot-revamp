// Ported from robotrader's src/notifications.js - same Telegram push logic,
// backed by storage.js (Postgres) instead of a Postgres table directly.
import { readJson, writeJson } from './storage.js';
import { readSettings } from './settings.js';
import crypto from 'node:crypto';

const NOTIFICATIONS_FILE = 'notifications.json';
const TELEGRAM_STATUS_FILE = 'telegram-status.json';
const defaultNotifications = { items: [] };
const defaultTelegramStatus = {
  configured: false, lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null,
  lastError: '', totalSent: 0, totalFailed: 0
};

const TELEGRAM_DEFAULT_CATEGORIES = ['trade', 'ai-review'];

export class NotificationCenter {
  constructor() {
    this.broadcast = null;
  }

  setBroadcast(fn) {
    this.broadcast = fn;
  }

  async list() {
    const state = await readJson(NOTIFICATIONS_FILE, defaultNotifications);
    return state.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async notify({ title, message, level = 'info', category = 'system', metadata = {}, telegram = true }) {
    const state = await readJson(NOTIFICATIONS_FILE, defaultNotifications);
    const item = {
      id: cryptoRandomId(), title, message, level, category, metadata,
      read: false, createdAt: new Date().toISOString()
    };
    state.items.unshift(item);
    state.items = state.items.slice(0, 160);
    await writeJson(NOTIFICATIONS_FILE, state);

    if (this.broadcast) this.broadcast({ type: 'notification', payload: item });

    const telegramResult = telegram ? await this.sendTelegram(item) : null;
    return { ...item, telegram: telegramResult };
  }

  async markRead(ids = []) {
    const state = await readJson(NOTIFICATIONS_FILE, defaultNotifications);
    const idSet = new Set(ids);
    for (const item of state.items) {
      if (idSet.size === 0 || idSet.has(item.id)) item.read = true;
    }
    await writeJson(NOTIFICATIONS_FILE, state);
    return state.items;
  }

  async sendTelegram(item) {
    const telegram = await resolveTelegramSettings();
    const allowedCategories = telegram.categories?.length ? telegram.categories : TELEGRAM_DEFAULT_CATEGORIES;
    if (!allowedCategories.includes(item.category)) {
      return { sent: false, reason: 'Category not configured for Telegram push.', skipped: true };
    }
    if (telegram.enabled === false || !telegram.botToken || !telegram.chatId) {
      const reason = telegram.enabled === false ? 'Telegram bot is turned off in settings.' : 'Telegram bot token or chat ID is not configured.';
      await recordTelegramStatus({ sent: false, reason, configured: Boolean(telegram.botToken && telegram.chatId) });
      return { sent: false, reason };
    }
    const text = [`Sally Crypto Bot: ${item.title}`, item.message, `Level: ${item.level}`, `Time: ${item.createdAt}`].join('\n');
    const result = await sendTelegramMessage({ text });
    await recordTelegramStatus({ ...result, configured: true });
    return result;
  }
}

export async function sendTelegramMessage({ text, title, parseMode, botToken, chatId, retries = 1 }) {
  const telegram = await resolveTelegramSettings();
  const token = botToken || telegram.botToken;
  const channel = chatId || telegram.chatId;
  if (telegram.enabled === false && !botToken) return { sent: false, reason: 'Telegram bot is disabled.' };
  if (!token || !channel) return { sent: false, reason: 'Telegram settings are incomplete: bot token and chat ID are both required.' };

  const body = [...(title ? [`Sally Crypto Bot: ${title}`] : []), text].join('\n');
  let lastNetworkError = null;
  for (let attempt = 0; attempt <= Math.max(0, retries); attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: channel, text: body, parse_mode: parseMode || undefined, disable_web_page_preview: true })
      });
      const textResult = await response.text().catch(() => '');
      if (!response.ok) {
        return { sent: false, reason: `Telegram responded ${response.status}: ${textResult.slice(0, 160)}`, hint: telegramFailureHint(response.status, textResult) };
      }
      return { sent: true };
    } catch (error) {
      lastNetworkError = error;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  return { sent: false, reason: lastNetworkError?.message || 'Unknown network error.', hint: 'Could not reach api.telegram.org - check outbound internet access.' };
}

export async function getTelegramStatus() {
  const stored = await readJson(TELEGRAM_STATUS_FILE, defaultTelegramStatus);
  const telegram = await resolveTelegramSettings();
  return {
    ...defaultTelegramStatus, ...stored,
    enabled: telegram.enabled,
    configured: Boolean(telegram.botToken && telegram.chatId),
    categories: telegram.categories?.length ? telegram.categories : TELEGRAM_DEFAULT_CATEGORIES
  };
}

export async function recordTelegramStatus(result) {
  const stored = await readJson(TELEGRAM_STATUS_FILE, defaultTelegramStatus);
  const now = new Date().toISOString();
  const next = {
    ...defaultTelegramStatus, ...stored,
    configured: Boolean(result.configured),
    lastAttemptAt: now,
    lastSuccessAt: result.sent ? now : stored.lastSuccessAt || null,
    lastFailureAt: result.sent ? stored.lastFailureAt || null : now,
    lastError: result.sent ? '' : (result.hint ? `${result.reason} ${result.hint}` : result.reason || 'Unknown error'),
    totalSent: (stored.totalSent || 0) + (result.sent ? 1 : 0),
    totalFailed: (stored.totalFailed || 0) + (result.sent ? 0 : 1)
  };
  await writeJson(TELEGRAM_STATUS_FILE, next);
  return next;
}

function telegramFailureHint(status, bodyText) {
  if (status === 401) return 'Bot token looks invalid or was revoked in @BotFather.';
  if (status === 404) return 'Bot token has the wrong format or the bot does not exist.';
  if (status === 400 && /chat not found/i.test(bodyText)) return 'Chat ID is wrong, or the bot chat has not been started yet.';
  if (status === 403) return 'The bot was blocked by the user or removed from the chat/group.';
  if (status === 429) return 'Telegram is rate-limiting this bot; it will recover automatically.';
  return '';
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function resolveTelegramSettings() {
  const settings = await readSettings().catch(() => null);
  const stored = settings?.telegram || {};
  return {
    enabled: stored.enabled !== false,
    botToken: stored.botToken || '',
    chatId: stored.chatId || '',
    categories: Array.isArray(stored.categories) && stored.categories.length ? stored.categories : null
  };
}

function cryptoRandomId() { return crypto.randomBytes(12).toString('hex'); }
