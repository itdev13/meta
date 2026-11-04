/**
 * Single source of truth for workflow trigger + action keys. These keys must match the
 * trigger/action "key" registered in the GHL Marketplace app dashboard exactly.
 */
const TRIGGERS = {
  MESSAGE_RECEIVED: 'whatsapp_message_received',
  NEW_CONTACT: 'whatsapp_new_contact',
  MEDIA_RECEIVED: 'whatsapp_media_received',
  PHONE_REPLY: 'whatsapp_phone_reply',
  MESSAGE_FAILED: 'whatsapp_message_failed',
  NUMBER_DISCONNECTED: 'whatsapp_number_disconnected',
  // feature: rules
  KEYWORD_RECEIVED: 'whatsapp_keyword_received',
  // feature: consent
  CONTACT_OPTED_OUT: 'whatsapp_contact_opted_out',
  CONTACT_OPTED_IN: 'whatsapp_contact_opted_in',
  // feature: groups
  GROUP_MESSAGE_RECEIVED: 'whatsapp_group_message_received',
};

const ACTIONS = {
  SEND_MESSAGE: 'whatsapp_send_message',
  SEND_MEDIA: 'whatsapp_send_media',
  SEND_TO_NUMBER: 'whatsapp_send_to_number',
  CHECK_NUMBER: 'whatsapp_check_number',
  // feature: rules (templates)
  SEND_TEMPLATE: 'whatsapp_send_template',
  // feature: consent
  OPT_IN_CONTACT: 'whatsapp_opt_in_contact',
  OPT_OUT_CONTACT: 'whatsapp_opt_out_contact',
  // feature: groups
  SEND_TO_GROUP: 'whatsapp_send_to_group',
};

module.exports = { TRIGGERS, ACTIONS };
