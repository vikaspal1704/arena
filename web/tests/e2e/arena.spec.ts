import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, seed = 42) {
  await page.goto(`./?seed=${seed}`);
  await page.getByRole('button', { name: 'Start trading' }).click();
  await expect(page.getByTestId('last-price')).not.toHaveText('—', { timeout: 15_000 });
}

test('e2e_trade_then_wrapped_with_verified_audit', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Market', exact: true }).click();
  await page.getByRole('button', { name: 'Buy 75 at market' }).click();
  await expect(page.getByTestId('position')).toHaveText('+75');
  await expect(page.getByTestId('fills')).toContainText('Bought 75');
  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  await page.getByRole('button', { name: 'Sell 75 at market' }).click();
  await expect(page.getByTestId('position')).toHaveText('0');
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('Your session, Wrapped')).toBeVisible();
  await expect(page.getByTestId('wrapped-net')).toHaveText(/₹/);
  await expect(page.getByTestId('wrapped-verified')).toContainText('identical to the live session');
  await expect(page.getByText('of 1 round trips won')).toBeVisible();
});

test('e2e_resting_order_shows_queue_and_cancels', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Bid', exact: true }).click();
  await page.getByRole('button', { name: /^Buy 75 @/ }).click();
  const order = page.getByRole('region', { name: 'Your orders' }).getByRole('listitem').first();
  await expect(order).toContainText(/ahead|front of queue|Buy 75/);
  await page.getByRole('button', { name: /Cancel order/ }).first().click();
  await expect(page.getByText('No resting orders.')).toBeVisible();
});

test('e2e_time_travel_replays_and_verifies', async ({ page }) => {
  await open(page);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Pause and time-travel' }).click();
  await expect(page.getByTestId('replay-verify')).toContainText('matches the live fingerprint');
  const slider = page.getByRole('slider', { name: 'Journal position' });
  await slider.fill('20');
  await expect(page.getByTestId('replay-verify')).toContainText('Replayed 20 entries');
  await expect(page.getByTestId('replay-verify')).toContainText('matches the live fingerprint');
  await expect(page.getByRole('heading', { name: /Order book · replay at #20/ })).toBeVisible();
  await page.getByRole('button', { name: 'Back to live' }).click();
  await expect(page.getByRole('heading', { name: /Order book · L2/ })).toBeVisible();
});

test('e2e_chaos_drops_packets_and_the_book_heals', async ({ page }) => {
  await open(page);
  await page.getByRole('slider', { name: 'Packet drop rate' }).fill('0.3');
  await expect.poll(async () => Number(await page.getByTestId('gaps').textContent()), { timeout: 15_000 }).toBeGreaterThan(2);
  await page.getByRole('slider', { name: 'Packet drop rate' }).fill('0');
  // With chaos off, the client resyncs and stays live.
  await expect(page.getByTestId('feed-stats')).toContainText('LIVE', { timeout: 10_000 });
});

test('e2e_same_seed_same_market', async ({ browser }) => {
  // Two independent browsers, same seed: the journal fingerprint at the same
  // sequence number must be identical (bots only, no player orders).
  const fingerprintAt = async (target: number | null) => {
    const page = await browser.newPage();
    await open(page, 7);
    if (target !== null) await expect.poll(async () => Number((await page.getByTestId('seq').textContent())!.slice(1)), { timeout: 20_000 }).toBeGreaterThan(target);
    else await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Pause and time-travel' }).click();
    const seq = target ?? Number((await page.getByTestId('seq').textContent())!.slice(1));
    await page.getByRole('slider', { name: 'Journal position' }).fill(String(seq));
    await expect(page.getByTestId('replay-verify')).toContainText(`Replayed ${seq} entries`);
    const text = (await page.getByTestId('replay-verify').textContent())!;
    await page.close();
    return { seq, fp: text.match(/[0-9a-f]{16}/)![0] };
  };
  const a = await fingerprintAt(null);
  const b = await fingerprintAt(a.seq);
  expect(b.fp).toBe(a.fp);
});

test('e2e_benchmark_runs_in_the_browser', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Run 1M commands' }).click();
  await expect(page.getByTestId('bench-result')).toContainText('commands/s in your browser', { timeout: 30_000 });
});

test('e2e_no_third_party_requests', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (r) => origins.add(new URL(r.url()).origin));
  await open(page);
  await page.getByRole('button', { name: 'Market', exact: true }).click();
  await page.getByRole('button', { name: 'Buy 75 at market' }).click();
  await page.waitForTimeout(500);
  expect([...origins].filter((o) => o !== new URL(page.url()).origin && !o.startsWith('data:'))).toEqual([]);
});

test('a11y_intro_desk_and_wrapped', async ({ page }) => {
  await page.goto('./?seed=3');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect((await new AxeBuilder({ page }).include('.intro').analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Start trading' }).click();
  await expect(page.getByTestId('last-price')).not.toHaveText('—', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('Your session, Wrapped')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
