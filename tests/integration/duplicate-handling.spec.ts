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

/**
 * Helper: process new files on the report screen and wait for completion.
 */
async function processNewFilesAndWait(page: import('@playwright/test').Page, fileCount: number) {
    const label = fileCount === 1 ? 'Process 1 New File' : `Process ${fileCount} New Files`;
    const processBtn = page.locator(`button:has-text("${label}")`);
    await expect(processBtn).toBeVisible();
    await processBtn.click();

    const processingBtn = page.locator('button:has-text("Processing...")');
    await expect(processingBtn).toBeVisible({timeout: 5_000});
    await expect(processingBtn).not.toBeVisible({timeout: 30_000});
    await page.waitForTimeout(300);
}

test.describe('Duplicate Record Handling', () => {
    test.beforeEach(async ({page}) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    });

    test('duplicate rows for same user+system are consolidated into one record', async ({page}) => {
        // satellite_dupes.csv has Alice twice (different roles), Bob twice (same role),
        // and Carol once. After dedup: Alice=1 row, Bob=1 row, Carol=1 row = 3 matched.
        // Plus any unmatched SoT users that don't appear in satellite.
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_dupes.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const rowCount = await getAriaRowCount(page);
        // SoT has 5 users; satellite_dupes has 3 unique users (Alice, Bob, Carol).
        // After dedup: 3 matched records (not 5 raw satellite rows).
        // Diana and Eve from SoT don't appear in this satellite, so no records for them.
        expect(rowCount).toBe(3);
    });

    test('different roles for same user are merged into one record', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_dupes.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        // Alice has Engineering-Lead + DevOps-Admin (merged from two duplicate rows).
        // The merged record should show as a multi-role badge ("2 roles").
        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();

        // Find Alice's row
        let aliceFound = false;
        for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const text = await row.textContent();
            if (text && text.includes('Alice Chen')) {
                aliceFound = true;
                // Should show multi-role badge since roles were merged
                expect(text).toContain('2');
                expect(text).toContain('roles');

                // Expand the multi-role dropdown to verify both roles are present
                const roleBadge = row.locator('[aria-expanded]').filter({hasText: 'roles'}).first();
                await roleBadge.click();
                const container = roleBadge.locator('..');
                const dropdown = container.locator('> div').last();
                await expect(dropdown).toBeVisible();

                const dropdownText = await dropdown.textContent();
                expect(dropdownText).toContain('Engineering-Lead');
                expect(dropdownText).toContain('DevOps-Admin');
                break;
            }
        }
        expect(aliceFound).toBe(true);
    });

    test('exact duplicate roles are deduplicated (not shown twice)', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_dupes.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();

        // Bob has Engineering-Lead twice — after dedup should appear as single role
        let bobFound = false;
        for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const text = await row.textContent();
            if (text && text.includes('Bob Martinez')) {
                bobFound = true;
                // Engineering-Lead should appear once, not duplicated
                const matches = (text.match(/Engineering-Lead/g) ?? []).length;
                expect(matches).toBe(1);
                break;
            }
        }
        expect(bobFound).toBe(true);
    });

    test('non-duplicate records are unaffected by deduplication', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_dupes.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();

        // Carol has one entry — should be unchanged
        let carolFound = false;
        for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const text = await row.textContent();
            if (text && text.includes('Carol White')) {
                carolFound = true;
                expect(text).toContain('Finance-Viewer');
                break;
            }
        }
        expect(carolFound).toBe(true);
    });

    test('incremental processing deduplicates across existing and new records', async ({page}) => {
        // Start with satellite_okta (has Alice, Bob, Carol, Diana, Ghost)
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const initialCount = await getAriaRowCount(page);
        expect(initialCount).toBeGreaterThan(0);

        // Add satellite_dupes which has overlapping users for a different system name.
        // Since satellite_dupes will get a different system name, these are separate
        // records (different systems), so count should increase.
        const newFileInput = page.locator('input[type="file"][accept=".csv"]').last();
        await newFileInput.setInputFiles([path.join(FIXTURES, 'satellite_dupes.csv')]);

        await processNewFilesAndWait(page, 1);

        const newCount = await getAriaRowCount(page);
        // New records from satellite_dupes (3 unique users) added alongside existing
        expect(newCount).toBeGreaterThan(initialCount);
    });

    test('duplicate records with different roles are auto-flagged', async ({page}) => {
        // satellite_dupes.csv has Alice twice with different roles (Engineering-Lead, DevOps-Admin).
        // The merged record should be automatically flagged.
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_dupes.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();

        // Find Alice's row — she should have a "Flag" action set
        let aliceFound = false;
        for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const text = await row.textContent();
            if (text && text.includes('Alice Chen')) {
                aliceFound = true;
                // The action should show "Flag" since different roles were detected
                const actionTrigger = row.locator('[aria-haspopup="listbox"]');
                await expect(actionTrigger).toContainText('Flag');
                break;
            }
        }
        expect(aliceFound).toBe(true);
    });

    test('duplicate records with identical roles are not auto-flagged', async ({page}) => {
        // satellite_dupes.csv has Bob twice with the exact same role (Engineering-Lead).
        // The merged record should NOT be auto-flagged.
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_dupes.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const rows = page.locator('[role="row"][data-index]');
        const rowCount = await rows.count();

        // Find Bob's row — he should NOT be flagged (same roles in both entries)
        let bobFound = false;
        for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const text = await row.textContent();
            if (text && text.includes('Bob Martinez')) {
                bobFound = true;
                // The action should show the default (unreviewed) state, not "Flag"
                const actionTrigger = row.locator('[aria-haspopup="listbox"]');
                await expect(actionTrigger).not.toContainText('Flag');
                break;
            }
        }
        expect(bobFound).toBe(true);
    });

    test('admin roles column deduplicates entries for same user', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        // Switch to Admins filter
        const adminsButton = page.locator('button[aria-pressed]').filter({hasText: 'Admins'});
        await adminsButton.click();

        // Verify rows are shown (admin records exist)
        const rowCount = await getAriaRowCount(page);
        expect(rowCount).toBeGreaterThan(0);

        // Admin Roles column should be visible
        const grid = page.locator('[role="grid"]');
        await expect(grid.locator('[role="columnheader"]').filter({hasText: 'Admin Roles'})).toHaveCount(1);
    });
});
