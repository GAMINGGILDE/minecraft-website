import { expect, test } from '@playwright/test';
import { installStatsMocks, waitForStatsAppReady } from './helpers/stats-mocks';

test('Sofortiger Wiederholungsversuch nach Fehler beendet den Ladezustand', async ({ page }) => {
  await installStatsMocks(page, {
    metrics: { hours: { label: 'Spielzeit', category: 'Activity', unit: 'h' } },
    players: {},
    leaderboards: { hours: [] },
  });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let summaryRequests = 0;
    window.fetch = async (input, options) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        location.href,
      );
      if (url.pathname.replace(/\/+$/, '') === '/api/world-state') {
        return Response.json({
          world: {
            name: 'world',
            ageDays: 20,
            ageTicks: 480_000,
            importedAt: '2026-09-11T06:00:00Z',
          },
          __generated: '2026-09-11T06:00:00Z',
        });
      }
      if (url.pathname.replace(/\/+$/, '') === '/api/summary' && ++summaryRequests === 1) {
        return Response.json({ error: 'temporary failure' }, { status: 500 });
      }
      return originalFetch(input, options);
    };
  });
  await page.goto('/statistiken/');
  await waitForStatsAppReady(page);
  await expect(page.getByText('Daten konnten nicht geladen werden').first()).toBeVisible();
  await page.getByRole('button', { name: 'Neu laden', exact: true }).first().click();
  await expect(page.getByText(/321[.,]50 h/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('Daten konnten nicht geladen werden')).toHaveCount(0);
});
