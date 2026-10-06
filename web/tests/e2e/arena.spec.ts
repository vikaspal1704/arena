import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, seed = 42) {
  await page.goto(`./?seed=${seed}`);
  await page.getByRole('button', { name: 'Start the lessons' }).click();
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
  await expect(page.getByText('of 1 round trip won')).toBeVisible();
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
  await expect(page.locator('#book-h')).toContainText('replay at #20');
  await page.getByRole('button', { name: 'Back to live' }).click();
  await expect(page.locator('#book-h')).toContainText('· live');
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
  await page.getByRole('button', { name: 'Start the lessons' }).click();
  await expect(page.getByTestId('last-price')).not.toHaveText('—', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('Your session, Wrapped')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('e2e_lessons_guide_and_explain_with_coach_notes', async ({ page }) => {
  await open(page);
  const lessons = page.getByTestId('lessons');
  await expect(lessons).toContainText('1. Take liquidity');
  await page.getByRole('button', { name: 'Market', exact: true }).click();
  await page.getByRole('button', { name: 'Buy 75 at market' }).click();
  await expect(lessons).toContainText('✓ Take liquidity');
  await expect(lessons).toContainText('the price of not waiting');
  await expect(page.locator('.note-card').first()).toContainText('Bought 75');
  await page.getByRole('button', { name: 'Next lesson →' }).click();
  await expect(lessons).toContainText('2. Make liquidity');
  await expect(lessons).toContainText('Lessons 1/7');
});

test('e2e_glossary_tip_opens_and_closes', async ({ page }) => {
  await open(page);
  const tip = page.getByRole('button', { name: 'What is the spread?' });
  await tip.click();
  await expect(page.getByRole('note')).toContainText('Crossing it is the cost of trading now');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('note')).toHaveCount(0);
});

test('e2e_layout_stays_still_while_the_market_moves', async ({ page }) => {
  // Regression guard for the "everything jumps" problem: measure layout
  // shifts and panel movement for 6 s of live market at normal speed.
  await open(page);
  await page.getByRole('combobox', { name: 'Market speed' }).selectOption('1');
  await page.getByRole('button', { name: /^Buy 75 @/ }).click();
  const result = await page.evaluate(
    () =>
      new Promise<{ cls: number; moved: string[] }>((resolve) => {
        let cls = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & { value: number })[]) cls += e.value;
        }).observe({ type: 'layout-shift' });
        const watch = ['.ladder .mid', '#ticket-h', '#pos-h', '#orders-h', '#tape-h', '#hood-h'];
        const start = watch.map((sel) => document.querySelector(sel)!.getBoundingClientRect().top);
        const moved = new Set<string>();
        const timer = setInterval(() => {
          watch.forEach((sel, i) => {
            if (document.querySelector(sel)!.getBoundingClientRect().top !== start[i]) moved.add(sel);
          });
        }, 100);
        setTimeout(() => {
          clearInterval(timer);
          resolve({ cls, moved: [...moved] });
        }, 6000);
      }),
  );
  expect(result.moved).toEqual([]);
  expect(result.cls).toBeLessThan(0.05);
});
