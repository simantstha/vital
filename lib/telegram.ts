import fs from 'fs';
import path from 'path';

const BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CONFIG_FILE = path.resolve(process.cwd(), '.vital-memory/telegram-config.json');

export async function sendMessage(chatId: number, text: string, parseMode: 'Markdown' | 'HTML' = 'Markdown') {
  await fetch(`${BASE()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
  });
}

export async function getFileUrl(fileId: string): Promise<string> {
  const res = await fetch(`${BASE()}/getFile?file_id=${fileId}`);
  const data = await res.json() as { result?: { file_path?: string } };
  const filePath = data.result?.file_path;
  if (!filePath) throw new Error(`Could not get file path for ${fileId}`);
  return `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
}

export async function downloadFileAsBase64(fileId: string): Promise<{ base64: string; mimeType: string }> {
  const url = await getFileUrl(fileId);
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  return { base64: Buffer.from(buffer).toString('base64'), mimeType: 'image/jpeg' };
}

export async function registerWebhook(webhookUrl: string, secret: string) {
  const res = await fetch(`${BASE()}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ['message'] }),
  });
  return res.json();
}

export function saveChatId(chatId: number) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ chatId }), 'utf-8');
  } catch { /* read-only fs on Vercel */ }
}

export function loadChatId(): number | null {
  try {
    return (JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as { chatId: number }).chatId ?? null;
  } catch { return null; }
}
