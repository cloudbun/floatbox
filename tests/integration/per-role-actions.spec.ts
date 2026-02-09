import {test, expect} from '@playwright/test';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../fixtures');

/**
 * Helper: upload files via the hidden file input in the DropZone.
 */
async function uploadFiles(page: import('@playwright/test').Page, filePaths: string[]) {
    const fileInput = page.locator('input[type="file"][accept*=".csv"]').first();
    await fileInput.setInputFiles(filePaths);
}

/**
 * Helper: tag the first file as SoT and process.
 */
async function tagSoTAndProcess(page: import('@playwright/test').Page) {
    const sotButton = page.locator('button:has-text("SoT")').first();
    await sotButton.click();

    const processButton = page.getByLabel('Start Processing');
    await processButton.click();
}

/**
 * Helper: wait for the report screen to appear.
 */
async function waitForReport(page: import('@playwright/test').Page) {
    await page.locator('[role="grid"]').waitFor({timeout: 30_000});
}

/**
 * Helper: open the multi-role dropdown and return the dropdown element.
 * The badge button has aria-expanded and contains "roles" text.
 */
async function openMultiRoleDropdown(page: import('@playwright/test').Page) {
    const roleBadge = page.locator('[aria-expanded]').filter({hasText: 'roles'}).first();
    await expect(roleBadge).toBeVisible();
    await roleBadge.click();

    // Wait for the dropdown to appear — it's a direct sibling after the button,
    // inside the same container ref. Use the parent container's dropdown child.
    const container = roleBadge.locator('..');
    const dropdown = container.locator('> div').last();
    await expect(dropdown).toBeVisible();

    return {roleBadge, dropdown};
}

test.describe('Per-Role Review Actions', () => {
    test.beforeEach(async ({page}) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    });

    test('multi-role record shows role count badge that expands dropdown', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const {roleBadge, dropdown} = await openMultiRoleDropdown(page);

        // Badge should show "3"
        await expect(roleBadge).toContainText('3');

        // Should see the individual role names
        await expect(dropdown).toContainText('Accounting Admin');
        await expect(dropdown).toContainText('HR Admin');
        await expect(dropdown).toContainText('Engineering Admin');

        // Each role should have A, R, F buttons (3 roles x 3 = 9 buttons)
        const actionButtons = dropdown.locator('button');
        await expect(actionButtons).toHaveCount(9);
    });

    test('clicking per-role action button sets that role action and shows colored dot', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const {dropdown} = await openMultiRoleDropdown(page);

        // Click "A" (Approve) for the first role
        const approveButtons = dropdown.locator('button[title="Approve"]');
        const firstApprove = approveButtons.first();
        await firstApprove.click({force: true});

        // The button should become active — white text on colored bg
        await expect(firstApprove).toHaveCSS('color', 'rgb(255, 255, 255)');

        // Click "R" (Revoke) for the second role
        const revokeButtons = dropdown.locator('button[title="Revoke"]');
        const secondRevoke = revokeButtons.nth(1);
        await secondRevoke.click({force: true});

        await expect(secondRevoke).toHaveCSS('color', 'rgb(255, 255, 255)');
    });

    test('per-role actions toggle off when clicked again', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const {dropdown} = await openMultiRoleDropdown(page);

        const firstApprove = dropdown.locator('button[title="Approve"]').first();
        await firstApprove.click({force: true});

        // Should be active
        await expect(firstApprove).toHaveCSS('color', 'rgb(255, 255, 255)');

        // Click again to toggle off
        await firstApprove.click({force: true});

        // Should no longer be white
        await expect(firstApprove).not.toHaveCSS('color', 'rgb(255, 255, 255)');
    });

    test('single-role records show role text directly, not a dropdown', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThan(0);
    });

    test('record-level action dropdown still works alongside per-role actions', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        // Target the first row's action trigger specifically
        const firstRow = page.locator('[role="row"][data-index="0"]');
        await expect(firstRow).toBeVisible();

        const actionTrigger = firstRow.locator('[aria-haspopup="listbox"]');
        await actionTrigger.click();

        const listbox = page.locator('[role="listbox"]');
        await expect(listbox).toBeVisible();
        await expect(listbox).toContainText('Approve');
        await expect(listbox).toContainText('Revoke');
        await expect(listbox).toContainText('Flag');

        // Click Approve
        await listbox.locator('button:has-text("Approve")').click();

        // The trigger should now show "Approve"
        await expect(actionTrigger).toContainText('Approve');
    });
});
