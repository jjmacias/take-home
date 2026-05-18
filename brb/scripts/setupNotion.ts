/**
 * Creates the BRB Audit Log database in a Notion page you specify.
 *
 * Usage:
 *   NOTION_TOKEN=secret_xxx NOTION_PARENT_PAGE_ID=<page-id> npm run setup:notion
 *
 * The script prints the database ID — paste it into NOTION_DATABASE_ID in your .env.
 */

import 'dotenv/config';
import { Client } from '@notionhq/client';

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN is not set');

  const parentPageId = process.env.NOTION_PARENT_PAGE_ID;
  if (!parentPageId) {
    throw new Error(
      'Set NOTION_PARENT_PAGE_ID to the Notion page ID where the database should live.\n' +
        'Grab it from the page URL: notion.so/<workspace>/<page-title>-<THIS-PART>'
    );
  }

  const notion = new Client({ auth: token });

  console.log('Creating BRB Audit Log database...');

  const db = await notion.databases.create({
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: '🔴 BRB Offboarding Audit Log' } }],
    properties: {
      Name: { title: {} },
      'Employee Email': { email: {} },
      'Manager Email': { email: {} },
      Status: {
        select: {
          options: [
            { name: 'Success', color: 'green' },
            { name: 'Partial', color: 'yellow' },
            { name: 'Failed', color: 'red' },
          ],
        },
      },
      'Triggered By': { rich_text: {} },
      'Triggered At': { date: {} },
      Reason: { rich_text: {} },
      'Actions Run': { number: { format: 'number' } },
      'Actions Passed': { number: { format: 'number' } },
      'Actions Failed': { number: { format: 'number' } },
    },
  });

  const dbId = db.id;
  console.log('\n✅ Database created successfully!');
  console.log(`\nAdd this to your .env:\n\n  NOTION_DATABASE_ID=${dbId}\n`);

  const cleanId = dbId.replace(/-/g, '');
  console.log(`View it at: https://www.notion.so/${cleanId}`);
}

main().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
