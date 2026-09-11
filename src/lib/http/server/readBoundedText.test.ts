import { describe, expect, it, vi } from 'vitest';
import { readBoundedText } from './readBoundedText';

describe('readBoundedText', () => {
  it('dekodiert UTF-8 auch ueber Chunk-Grenzen', async () => {
    const bytes = new TextEncoder().encode('Grüße');
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 3));
          controller.enqueue(bytes.slice(3));
          controller.close();
        },
      }),
    );
    expect(await readBoundedText(response, bytes.length)).toBe('Grüße');
  });

  it.each([true, false])(
    'bricht zu grosse Antworten ab (Content-Length: %s)',
    async (withLength) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
          },
          cancel,
        }),
        { headers: withLength ? { 'Content-Length': '10' } : {} },
      );
      await expect(readBoundedText(response, 9)).rejects.toThrow('Antwort ist zu gross');
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body!.locked).toBe(false);
    },
  );
});
