import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });

test('Galerie startet mit dem HTML-Bild und pausiert ausserhalb des Sichtbereichs', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  const gallery = page.locator('[data-gallery]');
  const front = gallery.locator('[data-gallery-a]');
  const initialSrc = await front.getAttribute('src');
  await page.clock.runFor(11_000);
  await expect(front).toHaveAttribute('src', initialSrc!);
  const initialImages = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /\/_astro\/\d{2}\./.test(url)),
  );
  expect(initialImages.every((url) => /\/01\./.test(url))).toBe(true);

  await gallery.scrollIntoViewIfNeeded();
  await expect(gallery.locator('[data-gallery-placeholder]')).toHaveClass(/opacity-0/);
  await expect(front).toHaveAttribute('src', initialSrc!);
  await page.clock.runFor(6_000);
  await expect(front).not.toHaveAttribute('src', initialSrc!);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(gallery).not.toBeInViewport();
  await page.clock.runFor(100);
  const pausedSrc = await front.getAttribute('src');
  const requestCount = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => /\/_astro\/\d{2}\./.test(entry.name)).length,
  );
  await page.clock.runFor(11_000);
  await expect(front).toHaveAttribute('src', pausedSrc!);
  expect(
    await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => /\/_astro\/\d{2}\./.test(entry.name)).length,
    ),
  ).toBe(requestCount);
});

test('Galerie nutzt responsive Folgebilder und unterstuetzt Vor und Zurueck', async ({ page }) => {
  await page.goto('/');
  const gallery = page.locator('[data-gallery]');
  await gallery.scrollIntoViewIfNeeded();
  await expect(gallery.locator('[data-gallery-placeholder]')).toHaveClass(/opacity-0/);
  await gallery.hover();
  const front = gallery.locator('[data-gallery-a]');
  const initialSrc = await front.getAttribute('src');
  await gallery.locator('[data-gallery-next]').click();
  await expect(front).not.toHaveAttribute('src', initialSrc!);
  await expect
    .poll(() =>
      front.evaluate((img: HTMLImageElement) => ({
        loaded: img.complete && img.naturalWidth > 0,
        responsive: img.srcset.includes(new URL(img.currentSrc).pathname + ' 768w'),
      })),
    )
    .toEqual({ loaded: true, responsive: true });
  await gallery.locator('[data-gallery-prev]').click();
  await expect(front).toHaveAttribute('src', initialSrc!);
});
