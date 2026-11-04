/**
 * Turn internal errors into clear text GHL shows in the workflow execution history.
 */
const MAP = [
  [/NO_NUMBER|No WhatsApp number is connected/i, 'No WhatsApp number is connected for this sub-account. Link a number in the WhatsApp app first.'],
  [/NUMBER_OFFLINE|not connected right now/i, 'The WhatsApp number is offline. Open the WhatsApp app and reconnect it.'],
  [/NOT_ON_WHATSAPP|is not on WhatsApp/i, 'This phone number is not registered on WhatsApp.'],
  [/NO_PHONE|no phone number/i, 'The contact has no phone number, so there is nowhere to send the WhatsApp message.'],
  [/DAILY_LIMIT|Daily sending limit/i, 'This WhatsApp number reached its daily sending limit. It resets at 00:00 UTC.'],
  [/SUBSCRIPTION_REQUIRED|subscription is required/i, 'This sub-account has no active WhatsApp subscription.'],
  [/ACCESS_DISABLED|has not enabled WhatsApp/i, 'Your agency has not enabled WhatsApp for this sub-account.'],
  [/OPTED_OUT|unsubscribed from WhatsApp/i, 'This contact unsubscribed from WhatsApp messages (replied STOP or was opted out). The message was not sent.'],
  [/GROUP_NOT_FOUND/i, 'No WhatsApp group with that name or ID was found on the connected numbers.'],
  [/NOT_IN_GROUP/i, 'None of the connected numbers is a member of that WhatsApp group.'],
  [/BAD_GROUP/i, 'That is not a valid WhatsApp group ID.'],
  [/TEMPLATE_NOT_FOUND|template not found/i, 'That WhatsApp template no longer exists. Pick another template in this workflow step.'],
  [/EMPTY|Nothing to send/i,'The message is empty — add text or an attachment.'],
  [/maxContentLength|timeout of|ECONNREFUSED|ENOTFOUND|status code 404/i, 'The attachment URL could not be downloaded. Use a public, direct file link.'],
];

function toGhlActionMessage(error) {
  const raw = `${error?.code || ''} ${error?.message || ''}`;
  for (const [re, text] of MAP) if (re.test(raw)) return text;
  return error?.message || 'The WhatsApp action failed.';
}

module.exports = { toGhlActionMessage };
