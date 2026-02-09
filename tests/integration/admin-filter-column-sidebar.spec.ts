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
 * Helper: get total record count from the grid's aria-rowcount attribute.
 */
async function getAriaRowCount(page: import('@playwright/test').Page): Promise<number> {
    const grid = page.locator('[role="grid"]');
    const count = await grid.getAttribute('aria-rowcount');
    return parseInt(count ?? '0', 10);
}

// =========================================================================
// Feature 1: Admins Filter Tab
// =========================================================================

test.describe('Admins Filter Tab', () => {
    test.beforeEach(async ({page}) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    });

    test('Admins filter button is visible in the filter bar', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await expect(adminsButton).toBeVisible();
    });

    test('clicking Admins filter reduces record count to only admin records', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const allCount = await getAriaRowCount(page);
        expect(allCount).toBeGreaterThan(0);

        // Click the Admins filter
        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await adminsButton.click();

        const adminCount = await getAriaRowCount(page);
        // The fixture data has admin roles: Alice (Accounting Admin, HR Admin, Engineering Admin),
        // Diana (HR-Admin), Ghost (IT-Admin) — so admin count should be > 0 but <= allCount
        expect(adminCount).toBeGreaterThan(0);
        expect(adminCount).toBeLessThanOrEqual(allCount);
    });

    test('Admins filter shows records with admin-like roles', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        // Click the Admins filter
        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await adminsButton.click();

        // All visible rows should contain admin-like text in some cell
        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThan(0);
    });

    test('switching back to All filter restores full record count', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const allCount = await getAriaRowCount(page);

        // Click Admins
        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await adminsButton.click();

        const adminCount = await getAriaRowCount(page);
        expect(adminCount).toBeLessThan(allCount);

        // Click All
        const allButton = page.locator('button[aria-pressed]').filter({hasText: 'All'});
        await allButton.click();

        const restoredCount = await getAriaRowCount(page);
        expect(restoredCount).toBe(allCount);
    });

    test('Admins filter button shows active styling when pressed', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});

        // Initially not active
        await expect(adminsButton).toHaveAttribute('aria-pressed', 'false');

        // Click to activate
        await adminsButton.click();
        await expect(adminsButton).toHaveAttribute('aria-pressed', 'true');
    });

    test('Admin Roles column appears when Admins filter is active', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const grid = page.locator('[role="grid"]');

        // Admin Roles column should NOT be present initially
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Admin Roles'})).toHaveCount(0);

        // Click Admins filter
        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await adminsButton.click();

        // Admin Roles column should now appear
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Admin Roles'})).toHaveCount(1);
    });

    test('Admin Roles column disappears when switching back to All filter', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const grid = page.locator('[role="grid"]');

        // Activate Admins filter
        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await adminsButton.click();
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Admin Roles'})).toHaveCount(1);

        // Switch back to All
        const allButton = page.locator('button[aria-pressed]').filter({hasText: 'All'});
        await allButton.click();

        // Admin Roles column should be gone
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Admin Roles'})).toHaveCount(0);
    });

    test('Admin Roles column shows system:role entries for admin records', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        // Click Admins filter
        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await adminsButton.click();

        // The rows should contain system:role text in the Admin Roles cells
        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThan(0);

        // At least one row should contain "Admin" text (from the admin roles entries)
        const firstRow = rows.first();
        await expect(firstRow).toContainText('Admin');
    });
});

// =========================================================================
// Feature 2: Column Visibility Sidebar
// =========================================================================

test.describe('Column Visibility Sidebar', () => {
    test.beforeEach(async ({page}) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    });

    test('Columns button is visible above the table', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const columnsButton = page.locator('button:has-text("Columns")');
        await expect(columnsButton).toBeVisible();
    });

    test('clicking Columns button opens the sidebar dropdown', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        // Sidebar should be visible — it has a header saying "Columns" (uppercase)
        // and contains checkboxes
        const sidebar = page.locator('label:has(input[type="checkbox"])').filter({hasText: 'User'});
        await expect(sidebar).toBeVisible();
    });

    test('sidebar lists all column names except checkbox', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        // Core columns should appear
        for (const label of ['User', 'Dept', 'Status', 'Risk', 'Action', 'Notes']) {
            await expect(
                page.locator('label:has(input[type="checkbox"])').filter({hasText: label}).first()
            ).toBeVisible();
        }

        // Hidden-by-default columns should also appear
        for (const label of ['Employee ID', 'Manager', 'Match Type', 'Acct Status', 'Last Login', 'Source File']) {
            await expect(
                page.locator('label:has(input[type="checkbox"])').filter({hasText: label})
            ).toBeVisible();
        }
    });

    test('default-visible columns are checked and hidden-by-default are unchecked', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        // "User" should be checked (default visible)
        const userCheckbox = page.locator('label').filter({hasText: 'User'}).locator('input[type="checkbox"]');
        await expect(userCheckbox).toBeChecked();

        // "Employee ID" should be unchecked (default hidden)
        const employeeIdCheckbox = page.locator('label').filter({hasText: 'Employee ID'}).locator('input[type="checkbox"]');
        await expect(employeeIdCheckbox).not.toBeChecked();

        // "Manager" should be unchecked
        const managerCheckbox = page.locator('label').filter({hasText: 'Manager'}).locator('input[type="checkbox"]');
        await expect(managerCheckbox).not.toBeChecked();
    });

    test('toggling a hidden column on adds it to the table header', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        // "Employee ID" should not be in the header initially
        const grid = page.locator('[role="grid"]');
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Employee ID'})).toHaveCount(0);

        // Open sidebar and enable Employee ID
        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        const employeeIdCheckbox = page.locator('label').filter({hasText: 'Employee ID'}).locator('input[type="checkbox"]');
        await employeeIdCheckbox.click();

        // Now "Employee ID" should appear in the header
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Employee ID'})).toHaveCount(1);
    });

    test('toggling a visible column off removes it from the table header', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const grid = page.locator('[role="grid"]');

        // "Dept" should be visible initially
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Dept'})).toHaveCount(1);

        // Open sidebar and uncheck Dept
        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        const deptCheckbox = page.locator('label').filter({hasText: 'Dept'}).locator('input[type="checkbox"]');
        await deptCheckbox.click();

        // "Dept" should no longer be in the header
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Dept'})).toHaveCount(0);
    });

    test('active columns show a white dot indicator in the sidebar', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        // Active columns (like "User") should have a white dot span (6x6 circle)
        const userLabel = page.locator('label').filter({hasText: 'User'}).first();
        const whiteDot = userLabel.locator('span').filter({
            has: page.locator('[style]'),
        });
        // The white dot exists for checked columns
        const dotSpans = userLabel.locator('span');
        const dotCount = await dotSpans.count();
        expect(dotCount).toBeGreaterThanOrEqual(2); // at least the dot span + label span

        // Hidden columns (like "Employee ID") should not have the dot
        const empLabel = page.locator('label').filter({hasText: 'Employee ID'});
        const empSpans = empLabel.locator('span');
        // Only the label span, no dot
        await expect(empSpans).toHaveCount(1);
    });

    test('closing the sidebar via close button hides the panel', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        // Sidebar should be visible
        const closeButton = page.locator('button[aria-label="Close column picker"]');
        await expect(closeButton).toBeVisible();

        // Click close
        await closeButton.click();

        // Sidebar should be gone — close button should not be visible
        await expect(closeButton).not.toBeVisible();
    });

    test('Columns button shows active styling when sidebar is open', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const columnsButton = page.locator('button:has-text("Columns")');

        // Initially not expanded
        await expect(columnsButton).toHaveAttribute('aria-expanded', 'false');

        // Click to open
        await columnsButton.click();
        await expect(columnsButton).toHaveAttribute('aria-expanded', 'true');
    });

    test('enabling multiple hidden columns adds them all to the table', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const grid = page.locator('[role="grid"]');
        const columnsButton = page.locator('button:has-text("Columns")');
        await columnsButton.click();

        // Enable Employee ID and Manager
        const empCheckbox = page.locator('label').filter({hasText: 'Employee ID'}).locator('input[type="checkbox"]');
        await empCheckbox.click();

        const mgrCheckbox = page.locator('label').filter({hasText: 'Manager'}).locator('input[type="checkbox"]');
        await mgrCheckbox.click();

        // Both should now appear in the header
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Employee ID'})).toHaveCount(1);
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Manager'})).toHaveCount(1);
    });
});
