const mongoose = require('mongoose');

/**
 * WhatsApp chat ↔ GHL contact. WhatsApp addresses a person by phone jid
 * (<digits>@s.whatsapp.net) and increasingly by an opaque LID (<id>@lid); we keep both so the
 * same person never becomes two contacts.
 *
 * Groups (feature: groups): isGroup=true, waJid=<group>@g.us, groupSubject = the group name.
 */
const ContactMappingSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    ghlContactId: { type: String, required: true },
    waJid: { type: String, default: null },  // phone jid
    lidJid: { type: String, default: null }, // LID jid
    phone: { type: String, default: '' },    // E.164
    pushName: { type: String, default: '' },
    // feature: groups. A WhatsApp group is ONE GHL contact; its group jid (<id>@g.us) lives in
    // waJid so the existing unique (locationId, waJid) index also dedupes groups.
    isGroup: { type: Boolean, default: false },
    groupSubject: { type: String, default: '' },
    firstSessionId: { type: String, default: '' },
    lastSessionId: { type: String, default: '' }, // replies route back through this number
    lastInboundAt: { type: Date },
    lastOutboundAt: { type: Date },
  },
  { collection: 'contact_mappings', timestamps: true },
);

ContactMappingSchema.index({ locationId: 1, waJid: 1 }, { unique: true, partialFilterExpression: { waJid: { $type: 'string' } } });
ContactMappingSchema.index({ locationId: 1, lidJid: 1 }, { unique: true, partialFilterExpression: { lidJid: { $type: 'string' } } });
ContactMappingSchema.index({ locationId: 1, ghlContactId: 1 });

module.exports = mongoose.model('ContactMapping', ContactMappingSchema);
