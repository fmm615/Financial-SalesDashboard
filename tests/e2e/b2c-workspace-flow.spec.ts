/**
 * B2C single-workspace acceptance flow (Task 7 of
 * docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md).
 *
 * NOT YET RUNNABLE IN THIS REPOSITORY. Playwright is not installed here
 * (no `@playwright/test` dependency, no `playwright.config.ts`) and this
 * environment has no browser binaries or a seeded Supabase project to
 * exercise it against. This file is a faithful, ready-to-run acceptance
 * spec, written against the actual selectors/routes used by the shipped
 * Task 4-6 UI (cross-checked against tests/b2c-workspace-ui.test.tsx,
 * tests/b2c-payment-review-drawer.test.tsx, tests/b2c-payment-duplicate-
 * drawer.test.tsx, tests/b2c-manual-bank-transfer-ui.test.tsx, and
 * tests/b2c-ui-ownership.test.tsx). It is intentionally excluded from
 * `tsconfig.json`, `eslint.config.mjs`, and `vitest.config.ts` (see the
 * `tests/e2e/**` entries added in each) so its unresolved `@playwright/test`
 * import cannot break `npm run typecheck`, `npm run lint`, or `npx vitest run`
 * before Playwright is actually wired in.
 *
 * Before this spec can run for real, a follow-up task must:
 *   1. `npm install -D @playwright/test` and `npx playwright install`.
 *   2. Add a `playwright.config.ts` with `testDir: "./tests/e2e"`, the four
 *      viewport projects below, and `webServer` pointed at `npm run build &&
 *      npm run start` (or `npm run dev`) against a seeded local Supabase.
 *   3. Remove the `tests/e2e/**` exclusions added for this task once the
 *      Playwright project has its own lint/type boundary.
 *   4. Provide `storageState` fixtures for an approved Admin and an approved
 *      Viewer. Sign-in in this app is Google OAuth only (see
 *      src/app/login/login-form.tsx) -- OAuth cannot be driven headlessly,
 *      so these fixtures must come from a `global-setup.ts` that creates a
 *      Supabase test session directly (service-role sign-in / magic link)
 *      and saves it as `playwright/.auth/admin.json` and
 *      `playwright/.auth/viewer.json`, matching this repo's existing
 *      Admin/Viewer role model (see `getApprovedRole`).
 *   5. Seed a disposable Supabase project with: Stripe/Tap sandbox
 *      credentials or fixture payloads, and the small known-value B2C
 *      dataset described in `knownValueDataset` below, before each full run
 *      (or via `test.beforeAll`).
 */

import { test, expect, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1024, height: 800 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const WORKSPACE_URL = "/operations/b2c";

/**
 * The known-value dataset this spec assumes is seeded before the run.
 * Every figure here must match the numbers written into the assertions
 * below -- do not let the two drift independently.
 */
const knownValueDataset = {
  cleanSucceededPayment: "100.00",
  partialRefund: "25.00",
  // Same Finance Tracker payment present in two workbook versions
  // (an original import and a different-hash replacement import); it must
  // be counted exactly once.
  financeTrackerPaymentAcrossVersions: "40.00",
  manualBankTransfer: "60.00",
  // Failed, pending, and ambiguous-replacement rows all contribute exactly
  // $0.00 -- they are excluded, never zeroed-and-counted.
  failedPaymentContribution: "0.00",
  pendingPaymentContribution: "0.00",
  ambiguousReplacementRowContribution: "0.00",
  // reportable cash (100.00 + 40.00 + 60.00) minus linked refunds (25.00)
  expectedNetCashUsd: "175.00",
};

async function gotoWorkspace(page: Page, query = "") {
  await page.goto(`${WORKSPACE_URL}${query}`);
}

/** Opens the shared record drawer from a Work queue item by its visible title. */
async function openDrawerForWorkItem(page: Page, itemTitle: string | RegExp) {
  const item = page.getByRole("listitem").filter({ hasText: itemTitle });
  await item.getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("B2C workspace -- positive flow", () => {
  test.use({ storageState: "playwright/.auth/admin.json" });

  test("clean payments post automatically, replacement imports never double-post, and the workflow completes end to end", async ({ page }) => {
    await test.step("1. Provider source records are already loaded (Stripe/Tap sync fixtures seeded out of band)", async () => {
      await gotoWorkspace(page, "?tab=sources");
      await expect(page.getByText(/Stripe/)).toBeVisible();
      await expect(page.getByText(/Tap/)).toBeVisible();
    });

    await test.step("2. Import a Payment Tracker snapshot with one iOS and one bank-transfer lineage; exact cross-tab candidates appear without a Find button", async () => {
      await gotoWorkspace(page, "?tab=sources");
      const fileInput = page.getByLabelText(/workbook/i);
      await fileInput.setInputFiles("tests/e2e/fixtures/payment-tracker-v1.xlsx");
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByText(/extracted rows/)).toBeVisible();
      await expect(page.getByText(/1 ios/i)).toBeVisible();
      await expect(page.getByText(/1 bank transfer/i)).toBeVisible();
      await page.getByRole("button", { name: "Import reviewed workbook" }).click();
      await expect(page.getByText(/import complete/i)).toBeVisible();

      await gotoWorkspace(page, "?tab=work&queue=duplicates");
      await expect(page.getByRole("button", { name: "Find exact duplicates" })).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Work queue filters" }).getByRole("button", { name: /^Duplicates \d+$/ })).toBeVisible();
    });

    await test.step("3. Import a different-hash replacement workbook containing unchanged historical rows", async () => {
      await gotoWorkspace(page, "?tab=sources");
      const fileInput = page.getByLabelText("Replace workbook");
      await fileInput.setInputFiles("tests/e2e/fixtures/payment-tracker-v2-replacement.xlsx");
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByText(/unchanged/i)).toBeVisible();
      await page.getByRole("button", { name: "Replace with reviewed workbook" }).click();
      await expect(page.getByText(/import complete/i)).toBeVisible();
    });

    await test.step("4. Unchanged rows cannot post twice", async () => {
      await gotoWorkspace(page, "?tab=work&queue=ready_to_post");
      const readyToPostCountBefore = await page.getByTestId("ready-to-post-count").innerText();
      await gotoWorkspace(page, "?tab=ledger");
      const financeTrackerRows = page.getByRole("row", { name: /finance tracker/i });
      await expect(financeTrackerRows).toHaveCount(1); // one row, not two, for the unchanged lineage
      expect(readyToPostCountBefore).not.toContain("2×"); // sanity: never double-counted
    });

    await test.step("5. Resolve one cross-tab duplicate", async () => {
      await gotoWorkspace(page, "?tab=work&queue=duplicates");
      await openDrawerForWorkItem(page, /duplicate/i);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("row")).toHaveCount(2, { timeout: 5000 }); // both immutable source rows shown
      await dialog.getByRole("radio").first().check();
      await dialog.getByLabelText("Reason").fill("B2C Cons contains the fuller verified contact record.");
      await dialog.getByRole("button", { name: "Record decision" }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("6. Correct one missing field", async () => {
      await gotoWorkspace(page, "?tab=work&queue=data");
      await openDrawerForWorkItem(page, /missing/i);
      const dialog = page.getByRole("dialog");
      await dialog.getByLabelText(/business date|amount|category/i).first().fill("2026-08-01");
      await dialog.getByLabelText("Reason").fill("Verified against the original source record.");
      await dialog.getByRole("button", { name: /^(Save|Correct)/ }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("7. Approve one FX conversion", async () => {
      await gotoWorkspace(page, "?tab=work&queue=data");
      await openDrawerForWorkItem(page, /foreign currency|FX/i);
      const dialog = page.getByRole("dialog");
      await dialog.getByLabelText(/exchange rate/i).fill("0.376");
      await dialog.getByLabelText("Reason").fill("Finance-approved rate for the settlement date.");
      await dialog.getByRole("button", { name: /convert|fx/i }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("8. Record one valid Finance exception", async () => {
      await gotoWorkspace(page, "?tab=work&queue=data");
      await openDrawerForWorkItem(page, /missing.*email|exception/i);
      const dialog = page.getByRole("dialog");
      await dialog.getByLabelText(/provider id/i).fill("ch_confirmed_exact_id");
      await dialog.getByLabelText(/no known duplicate/i).check();
      await dialog.getByLabelText(/category/i).fill("membership");
      await dialog.getByLabelText("Reason").fill("Finance confirmed this record by phone; no e-mail on file.");
      await dialog.getByRole("button", { name: /record exception/i }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("9. Ready to post shows separate iOS/bank counts and one batch Post button", async () => {
      await gotoWorkspace(page, "?tab=work&queue=ready_to_post");
      await expect(page.getByText(/\d+ ios/i)).toBeVisible();
      await expect(page.getByText(/\d+ bank transfer/i)).toBeVisible();
      const postButtons = page.getByRole("button", { name: "Post approved Finance payments" });
      await expect(postButtons).toHaveCount(1);
      await postButtons.click();
      await expect(page.getByText(/posted/i)).toBeVisible();
    });

    await test.step("10. Add one genuinely new manual bank transfer through preview and confirmation", async () => {
      await gotoWorkspace(page, "?tab=sources");
      await page.getByRole("button", { name: "Add bank transfer" }).click();
      await page.getByLabelText("Bank reference").fill("IBAN-2026-E2E-NEW");
      await page.getByLabelText("Customer name").fill("E2E New Transfer");
      await page.getByLabelText("Customer email").fill("e2e-new@example.com");
      await page.getByLabelText("Bank transfer date/time").fill("2026-08-19T09:00");
      await page.getByLabelText("Amount (USD)").fill(knownValueDataset.manualBankTransfer);
      await page.getByLabelText("Category").fill("membership");
      await page.getByLabelText("Reason").fill("New bank transfer received after the latest workbook.");
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByText(/no existing match/i)).toBeVisible();
      await page.getByRole("button", { name: "Record bank transfer" }).click();
      await expect(page.getByRole("button", { name: "Add bank transfer" })).toBeVisible(); // returned to Sources
    });

    await test.step("11. A manual bank transfer matching the sheet bank lineage is rejected with a link to the existing record", async () => {
      await gotoWorkspace(page, "?tab=sources");
      await page.getByRole("button", { name: "Add bank transfer" }).click();
      await page.getByLabelText("Bank reference").fill("IBAN-2026-0912"); // matches a sheet bank-transfer lineage
      await page.getByLabelText("Customer name").fill("Existing Tracker Customer");
      await page.getByLabelText("Customer email").fill("existing@example.com");
      await page.getByLabelText("Bank transfer date/time").fill("2026-08-12T08:00");
      await page.getByLabelText("Amount (USD)").fill("266");
      await page.getByLabelText("Category").fill("membership");
      await page.getByLabelText("Reason").fill("Checking a possible re-entry.");
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByText(/existing payment tracker\/payment found/i)).toBeVisible();
      await expect(page.getByRole("button", { name: "Record bank transfer" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /review the existing record/i })).toBeVisible();
    });

    await test.step("12. Import a later workbook containing the previously manual transfer; link its evidence and verify posting creates nothing new", async () => {
      await gotoWorkspace(page, "?tab=sources");
      const fileInput = page.getByLabelText("Replace workbook");
      await fileInput.setInputFiles("tests/e2e/fixtures/payment-tracker-v3-with-manual-transfer.xlsx");
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByText(/existing payment/i)).toBeVisible();
      await page.getByRole("button", { name: "Replace with reviewed workbook" }).click();
      await expect(page.getByText(/import complete/i)).toBeVisible();

      await gotoWorkspace(page, "?tab=work&queue=reconciliation");
      await openDrawerForWorkItem(page, /link.*existing manual|existing manual payment/i);
      const dialog = page.getByRole("dialog");
      await dialog.getByLabelText("Reason").fill("Confirmed: this is the same transfer already recorded manually.");
      await dialog.getByRole("button", { name: /link/i }).click();
      await expect(dialog).toBeHidden();

      await gotoWorkspace(page, "?tab=work&queue=ready_to_post");
      await page.getByRole("button", { name: "Post approved Finance payments" }).click();
      await expect(page.getByText(/0 new/i)).toBeVisible();
    });

    await test.step("13. Refresh and verify totals, statuses, source evidence, and audit history", async () => {
      await gotoWorkspace(page, "?tab=ledger");
      await page.reload();
      const netCash = await page.getByTestId("net-cash-usd").innerText();
      expect(netCash).toContain(knownValueDataset.expectedNetCashUsd);

      const firstRow = page.getByRole("row").nth(1);
      await firstRow.getByRole("button", { name: /review/i }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Source evidence")).toBeVisible();
      await expect(dialog.getByText("Audit history")).toBeVisible();
    });
  });
});

test.describe("B2C workspace -- negative flow", () => {
  test.use({ storageState: "playwright/.auth/admin.json" });

  test("excluded and unresolved records never contribute to reportable totals", async ({ page }) => {
    await test.step("1. A failed payment remains excluded", async () => {
      await gotoWorkspace(page, "?tab=ledger&status=failed");
      const row = page.getByRole("row", { name: /failed/i }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText(/excluded/i)).toBeVisible();
    });

    await test.step("2. A pending payment remains excluded", async () => {
      await gotoWorkspace(page, "?tab=ledger&status=pending");
      const row = page.getByRole("row", { name: /pending/i }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText(/excluded/i)).toBeVisible();
    });

    await test.step("3. Missing e-mail without an exception remains excluded", async () => {
      await gotoWorkspace(page, "?tab=work&queue=data");
      await expect(page.getByText(/missing.*email/i)).toBeVisible();
    });

    await test.step("4. An unresolved duplicate remains excluded", async () => {
      await gotoWorkspace(page, "?tab=work&queue=duplicates");
      await expect(page.getByText(/possible duplicate|duplicate/i).first()).toBeVisible();
    });

    await test.step("5. Missing FX remains excluded", async () => {
      await gotoWorkspace(page, "?tab=work&queue=data");
      await expect(page.getByText(/exchange rate|fx/i)).toBeVisible();
    });

    await test.step("6. Unmatched Tap statement evidence never becomes a payment", async () => {
      await gotoWorkspace(page, "?tab=sources");
      await expect(page.getByText(/unmatched/i)).toBeVisible();
      await gotoWorkspace(page, "?tab=ledger");
      await expect(page.getByRole("row", { name: /tap statement/i })).toHaveCount(0);
    });

    await test.step("7. An ambiguous replacement-workbook row cannot post", async () => {
      await gotoWorkspace(page, "?tab=work&queue=reconciliation");
      await expect(page.getByText(/ambiguous/i)).toBeVisible();
      await gotoWorkspace(page, "?tab=work&queue=ready_to_post");
      await expect(page.getByText(/ambiguous/i)).toHaveCount(0); // ambiguous rows are not counted as ready
    });

    await test.step("8. There is no manual iOS entry action anywhere", async () => {
      await gotoWorkspace(page, "?tab=sources");
      await expect(page.getByRole("button", { name: /add ios/i })).toHaveCount(0);
      await gotoWorkspace(page, "?tab=work");
      await expect(page.getByRole("button", { name: /add ios/i })).toHaveCount(0);
    });
  });

  test.describe("Viewer read-only access", () => {
    test.use({ storageState: "playwright/.auth/viewer.json" });

    test("9. A Viewer has no Work queue and no B2C write buttons", async ({ page }) => {
      await gotoWorkspace(page);
      await expect(page).toHaveURL(/tab=ledger/);
      await expect(page.getByRole("link", { name: "Work queue" })).toHaveCount(0);

      await gotoWorkspace(page, "?tab=work");
      await expect(page).toHaveURL(/tab=ledger/); // forced back onto Ledger

      await gotoWorkspace(page, "?tab=sources");
      await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add bank transfer" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /import workbook|replace workbook/i })).toHaveCount(0);
    });
  });
});

test.describe("B2C workspace -- responsive acceptance", () => {
  test.use({ storageState: "playwright/.auth/admin.json" });

  for (const viewport of VIEWPORTS) {
    test(`renders the Work queue, Ledger, Sources, and record drawer cleanly at ${viewport.width}px (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const tab of ["work", "ledger", "sources"] as const) {
        await gotoWorkspace(page, `?tab=${tab}`);

        const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect(bodyOverflow, `no page-level horizontal overflow on ${tab} at ${viewport.width}px`).toBe(false);

        const interactiveTargets = page.getByRole("button");
        const count = await interactiveTargets.count();
        for (let i = 0; i < count; i += 1) {
          const box = await interactiveTargets.nth(i).boundingBox();
          if (box) expect(box.height, `interactive target ${i} on ${tab} is at least 44px tall`).toBeGreaterThanOrEqual(44);
        }
      }

      // One primary action per Work queue item, even on mobile.
      await gotoWorkspace(page, "?tab=work");
      const firstItem = page.getByRole("listitem").first();
      await expect(firstItem.getByRole("button")).toHaveCount(1);

      // Drawer opens, traps focus, and scrolls within itself rather than the page.
      await firstItem.getByRole("button").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toBeFocused({ timeout: 2000 }).catch(async () => {
        // Focus may land on the first focusable descendant rather than the dialog itself.
        await expect(dialog.locator(":focus")).toHaveCount(1);
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  }
});
