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
 * Waits for the "Processing..." state to appear and then disappear.
 */
async function processNewFilesAndWait(page: import('@playwright/test').Page, fileCount: number) {
    const label = fileCount === 1 ? 'Process 1 New File' : `Process ${fileCount} New Files`;
    const processBtn = page.locator(`button:has-text("${label}")`);
    await expect(processBtn).toBeVisible();
    await processBtn.click();

    // Wait for "Processing..." to appear (indicates processing started)
    const processingBtn = page.locator('button:has-text("Processing...")');
    await expect(processingBtn).toBeVisible({timeout: 5_000});

    // Wait for "Processing..." to disappear (indicates processing completed)
    await expect(processingBtn).not.toBeVisible({timeout: 30_000});

    // Give React a tick to re-render with new data
    await page.waitForTimeout(300);
}

test.describe('Incremental Satellite Processing', () => {
    test.beforeEach(async ({page}) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    });

    test('initial processing produces report with expected records', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const rowCount = await getAriaRowCount(page);
        expect(rowCount).toBeGreaterThan(0);

        await expect(page.locator('text=Add More Files')).toBeVisible();
    });

    test('"Add More Files" section appears on report screen with file picker', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        await expect(page.locator('text=Add More Files')).toBeVisible();
        await expect(page.locator('text=+ Add CSV Files')).toBeVisible();
    });

    test('adding new files shows them in the unprocessed list', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const newFileInput = page.locator('input[type="file"][accept=".csv"]').last();
        await newFileInput.setInputFiles([path.join(FIXTURES, 'satellite_extra.csv')]);

        await expect(page.locator('text=satellite_extra.csv')).toBeVisible();

        const processBtn = page.locator('button:has-text("Process 1 New File")');
        await expect(processBtn).toBeVisible();
    });

    test('processing new files merges results into existing report', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const initialRowCount = await getAriaRowCount(page);
        expect(initialRowCount).toBeGreaterThan(0);

        const newFileInput = page.locator('input[type="file"][accept=".csv"]').last();
        await newFileInput.setInputFiles([path.join(FIXTURES, 'satellite_aws.csv')]);

        await processNewFilesAndWait(page, 1);

        const newRowCount = await getAriaRowCount(page);
        expect(newRowCount).toBeGreaterThan(initialRowCount);
    });

    test('existing review actions are preserved after incremental processing', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        // Find the first data row's action trigger and set it to Approve
        const firstRow = page.locator('[role="row"][data-index="0"]');
        const actionTrigger = firstRow.locator('[aria-haspopup="listbox"]');
        await actionTrigger.click();

        const listbox = page.locator('[role="listbox"]');
        await expect(listbox).toBeVisible();
        await listbox.locator('button:has-text("Approve")').click();

        await expect(actionTrigger).toContainText('Approve');

        // Now add more files and process
        const newFileInput = page.locator('input[type="file"][accept=".csv"]').last();
        await newFileInput.setInputFiles([path.join(FIXTURES, 'satellite_aws.csv')]);

        await processNewFilesAndWait(page, 1);

        // The same row should still have "Approve"
        // After incremental processing, the record should preserve its action
        const approvedAction = page.locator('[aria-label*="approve"]').first();
        await expect(approvedAction).toBeVisible();
        await expect(approvedAction).toContainText('Approve');
    });

    test('processing multiple new files at once', async ({page}) => {
        await uploadFiles(page, [
            path.join(FIXTURES, 'sot_test.csv'),
            path.join(FIXTURES, 'satellite_okta.csv'),
        ]);

        await tagSoTAndProcess(page);
        await waitForReport(page);

        const initialRowCount = await getAriaRowCount(page);

        const newFileInput = page.locator('input[type="file"][accept=".csv"]').last();
        await newFileInput.setInputFiles([
            path.join(FIXTURES, 'satellite_aws.csv'),
            path.join(FIXTURES, 'satellite_extra.csv'),
        ]);

        await processNewFilesAndWait(page, 2);

        const newRowCount = await getAriaRowCount(page);
        expect(newRowCount).toBeGreaterThan(initialRowCount);
    });
});
