export const MODAL_CALLBACK_ID = 'offboarding_confirm';

export function buildOffboardingModal(prefillEmail = '') {
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    title: { type: 'plain_text', text: '🔴 Big Red Button' },
    submit: { type: 'plain_text', text: 'Offboard Employee' },
    close: { type: 'plain_text', text: 'Cancel' },
    notify_on_close: false,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*This will immediately suspend the employee\'s Google Workspace account, revoke all sessions and tokens, move them to the Departed Employees OU, and transfer their Drive files to their manager.*\n\nThis action cannot be undone.',
        },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'employee_block',
        label: { type: 'plain_text', text: 'Departing Employee Email' },
        element: {
          type: 'plain_text_input',
          action_id: 'employee_email',
          placeholder: { type: 'plain_text', text: 'employee@company.com' },
          initial_value: prefillEmail,
        },
      },
      {
        type: 'input',
        block_id: 'manager_block',
        label: { type: 'plain_text', text: 'Manager / Delegate Email' },
        hint: {
          type: 'plain_text',
          text: 'Drive files will be transferred to this person.',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'manager_email',
          placeholder: { type: 'plain_text', text: 'manager@company.com' },
        },
      },
      {
        type: 'input',
        block_id: 'reason_block',
        label: { type: 'plain_text', text: 'Reason for Departure' },
        element: {
          type: 'plain_text_input',
          action_id: 'reason',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'e.g. Voluntary resignation, effective 2026-05-18' },
        },
      },
    ],
  };
}
