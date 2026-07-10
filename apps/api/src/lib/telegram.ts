export async function sendTelegramMessage(chatId: string, message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN is not set, skipping message.');
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    if (!response.ok) {
      console.error(`[Telegram] Failed to send message: ${response.statusText}`);
    }
  } catch (error) {
    console.error(`[Telegram] Error sending message:`, error);
  }
}
