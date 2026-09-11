export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Antwort ist zu gross.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Antwort ist zu gross.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
