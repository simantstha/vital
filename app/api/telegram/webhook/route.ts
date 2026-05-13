import { NextResponse } from 'next/server';
import { sendMessage, downloadFileAsBase64, saveChatId } from '@/lib/telegram';
import { processMessage, resolveQuantity, processPdf } from '@/lib/telegramCoach';
import { readPendingBarcode } from '@/lib/coachState';

export const dynamic = 'force-dynamic';

interface TelegramPhotoSize { file_id: string; }
interface TelegramDocument { file_id: string; mime_type?: string; }
interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}
interface TelegramUpdate { message?: TelegramMessage; }

async function downloadPdfAsBase64(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const getFileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const getFileJson = await getFileRes.json() as { result: { file_path: string } };
  const filePath = getFileJson.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const buffer = await fileRes.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

export async function POST(req: Request) {
  // Verify Telegram secret header
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  let update: TelegramUpdate;
  try { update = await req.json() as TelegramUpdate; }
  catch { return NextResponse.json({ ok: true }); }

  const msg = update.message;
  if (!msg) return NextResponse.json({ ok: true });

  const chatId = msg.chat.id;

  // Persist chat_id on first contact
  saveChatId(chatId);

  try {
    // Check if this is a quantity reply to a pending barcode scan
    if (msg.text) {
      const pending = readPendingBarcode(chatId);
      if (pending) {
        const reply = await resolveQuantity(pending, msg.text);
        await sendMessage(chatId, reply);
        return NextResponse.json({ ok: true });
      }
    }

    if (msg.document?.mime_type === 'application/pdf') {
      await sendMessage(chatId, 'Analysing your lab report — this may take a moment...');
      const pdfBase64 = await downloadPdfAsBase64(msg.document.file_id);
      const reply = await processPdf(pdfBase64, chatId);
      await sendMessage(chatId, reply);
    } else if (msg.photo && msg.photo.length > 0) {
      // Highest resolution = last in array
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const { base64, mimeType } = await downloadFileAsBase64(fileId);
      const reply = await processMessage(msg.text ?? '', chatId, { base64, mimeType });
      await sendMessage(chatId, reply);
    } else if (msg.text) {
      const reply = await processMessage(msg.text, chatId);
      await sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error('Telegram coach error:', err);
    await sendMessage(chatId, 'Something went wrong — try again in a moment.');
  }

  return NextResponse.json({ ok: true });
}
