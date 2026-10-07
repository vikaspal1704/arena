import { expect, test } from '@playwright/test';
import { BARE_BRIDGE, MOCK_BRIDGE } from '../../playwright.config';

const realDesk = `http://127.0.0.1:${MOCK_BRIDGE}/`;

test('e2e_real_mode_trades_around_bridge_prices', async ({ page }) => {
  await page.goto(realDesk);
  await expect(page).toHaveURL(/\/arena\/\?real=1/);
  await page.getByRole('button', { name: 'Trade freely' }).click();
  const real = page.getByTestId('real-book');
  await expect(real).toBeVisible();
  await expect(real.getByRole('list', { name: 'Real bids' }).getByRole('listitem').first()).toHaveText(/\d/);
  await expect(page.locator('.instrument')).toContainText('mock prices');
  // The contract's lot size (65) replaces the default.
  await expect(page.getByText('Lots (65 units each)')).toBeVisible();

  await page.getByRole('button', { name: 'Market', exact: true }).click();
  await page.getByRole('button', { name: 'Buy 65 at market' }).click();
  await expect(page.getByTestId('position')).toHaveText('+65');

  // The fill is close to the real (mock) price: the bots quote around it.
  const fill = Number((await page.getByTestId('fills').locator('.mono').first().innerText()).split('@')[1]!.replace(/,/g, '').trim());
  const realBid = Number((await real.getByRole('list', { name: 'Real bids' }).locator('.px').first().innerText()).replace(/,/g, ''));
  expect(Math.abs(fill - realBid)).toBeLessThan(10);

  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('cannot be rebuilt from the seed')).toBeVisible();
  await expect(page.getByTestId('wrapped-verified')).toContainText('Identical to the live session');
});

test('e2e_real_mode_without_credentials_shows_setup_steps', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${BARE_BRIDGE}/`);
  await expect(page.getByRole('heading', { name: 'Real-market mode' })).toBeVisible();
  await expect(page.getByText('has no Kite Connect credentials')).toBeVisible();
  await expect(page.getByText(`http://127.0.0.1:${BARE_BRIDGE}/kite/callback`)).toBeVisible();
});

test('e2e_public_site_is_unchanged_without_real_flag', async ({ page }) => {
  await page.goto('./?seed=4');
  await page.getByRole('button', { name: 'Trade freely' }).click();
  await expect(page.getByTestId('real-book')).toHaveCount(0);
  await expect(page.getByText('Lots (75 units each)')).toBeVisible();
});
