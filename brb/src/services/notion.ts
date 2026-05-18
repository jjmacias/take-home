import { Client } from '@notionhq/client';
import type { OffboardingResult } from '../types';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export async function logToNotion(result: OffboardingResult): Promise<string> {
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error('NOTION_DATABASE_ID is not set');

  const successCount = result.actions.filter(a => a.status === 'success').length;
  const failedCount = result.actions.filter(a => a.status === 'failed').length;

  const statusLabel =
    result.overallStatus === 'success'
      ? 'Success'
      : result.overallStatus === 'partial'
      ? 'Partial'
      : 'Failed';

  const page = await notion.pages.create({
    parent: { database_id: dbId },
    properties: {
      Name: {
        title: [{ text: { content: result.employeeEmail } }],
      },
      'Employee Email': { email: result.employeeEmail },
      'Manager Email': { email: result.managerEmail },
      'Triggered By': {
        rich_text: [{ text: { content: `${result.triggeredByName} (${result.triggeredBy})` } }],
      },
      'Triggered At': {
        date: { start: result.triggeredAt.toISOString() },
      },
      Status: { select: { name: statusLabel } },
      Reason: {
        rich_text: [{ text: { content: result.reason } }],
      },
      'Actions Run': { number: result.actions.length },
      'Actions Passed': { number: successCount },
      'Actions Failed': { number: failedCount },
    },
    children: [
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: 'Action Log' } }],
        },
      },
      ...result.actions.map(a => ({
        object: 'block' as const,
        type: 'bulleted_list_item' as const,
        bulleted_list_item: {
          rich_text: [
            {
              type: 'text' as const,
              text: {
                content: [
                  a.status === 'success' ? '✅' : a.status === 'skipped' ? '⏭️' : '❌',
                  ` ${a.action}`,
                  a.details ? ` — ${a.details}` : '',
                  a.error ? ` (Error: ${a.error})` : '',
                ].join(''),
              },
            },
          ],
        },
      })),
    ],
  });

  return page.id;
}
