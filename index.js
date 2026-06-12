const express = require('express');
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('OK'));

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const clientMap = {
  '+19714356058': {
    clientId: 'client_001',
    businessName: 'StreamlineAI',
    businessPhone: '+19717626038',
  },
  '+19714161313': {
    clientId: 'client_002',
    businessName: 'ABC Plumbing',
    businessPhone: '+15038959336',
  }
};

// ── Airtable helpers ──────────────────────────────────────────────

async function findContact(phoneNumber) {
  const formula = encodeURIComponent(`{phone_number}="${phoneNumber}"`);
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/SMS%20Contacts?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function createContact(phoneNumber, telnyxNumber, clientId) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/SMS%20Contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        phone_number: phoneNumber,
        client_telnyx_number: telnyxNumber,
        client_id: clientId,
        consent_status: 'pending',
        consent_requested_at: new Date().toISOString(),
        last_message_at: new Date().toISOString()
      }
    })
  });
  return await res.json();
}

async function updateContact(recordId, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/SMS%20Contacts/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return await res.json();
}

async function logCall(callerPhone, telnyxNumber, clientId, textSent) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Call%20Log`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        date_time: new Date().toISOString(),
        caller_phone: callerPhone,
        client_telnyx_number: telnyxNumber,
        client_id: clientId,
        text_sent: textSent
      }
    })
  });
  return await res.json();
}

async function logConversation(callerPhone, telnyxNumber, clientId, direction, messageText) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Conversations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        timestamp: new Date().toISOString(),
        caller_phone: callerPhone,
        client_id: clientId,
        client_telnyx_number: telnyxNumber,
        direction: direction,
        message: messageText
      }
    })
  });
  return await res.json();
}

async function sendSMS(from, to, text) {
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TELNYX_API_KEY}` },
    body: JSON.stringify({ from, to, text })
  });
  return await res.json();
}

async function rejectCall(callControlId) {
  const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TELNYX_API_KEY}` },
    body: JSON.stringify({})
  });
  return await res.json();
}

// ── AI helpers ────────────────────────────────────────────────────

async function getClientContext(clientId) {
  const formula = encodeURIComponent(`{client_id}="${clientId}"`);
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Clients?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  const data = await res.json();
  return data.records?.[0]?.fields?.ai_context || null;
}

async function getConversationHistory(callerPhone, clientId) {
  const formula = encodeURIComponent(`AND({caller_phone}="${callerPhone}",{client_id}="${clientId}")`);
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Conversations?filterByFormula=${formula}&sort[0][field]=timestamp&sort[0][direction]=asc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  const data = await res.json();
  return data.records || [];
}

async function getAIReply(aiContext, conversationHistory, latestMessage) {
  const messages = [];

  for (const record of conversationHistory) {
    const role = record.fields.direction === 'outbound' ? 'assistant' : 'user';
    messages.push({ role, content: record.fields.message });
  }

  messages.push({ role: 'user', content: latestMessage });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a helpful assistant responding to customers via SMS on behalf of a business. Keep replies conversational and concise — this is a text message conversation. Do not use bullet points or long formatted lists. Only answer based on the information provided to you. If you do not know the answer to something, say so honestly and let the customer know a team member will follow up. Never invent information, prices, or promises.\n\nBusiness context:\n\n${aiContext}`,
      messages
    })
  });

  const data = await res.json();
  return data.content?.[0]?.text || null;
}

// ── Call webhook ──────────────────────────────────────────────────

app.post('/call', async (req, res) => {
  res.sendStatus(200);
  const eventType = req.body?.data?.event_type;
  const payload = req.body?.data?.payload;
  const calledNumber = payload?.to;
  const callerNumber = payload?.from;
  const callControlId = payload?.call_control_id;
  const direction = payload?.direction;
  const client = clientMap[calledNumber];

  if (eventType === 'call.initiated' && direction === 'incoming') {
    if (!client) {
      console.log('No client found for number:', calledNumber);
      return;
    }

    console.log(`Missed call for ${client.businessName} from ${callerNumber}`);

    // Reject the call immediately — it's already missed (carrier forwarded it because client didn't answer)
    try {
      await rejectCall(callControlId);
      console.log('Call rejected');
    } catch (err) {
      console.error('Reject failed:', err?.message);
    }

    // Send text and log
    let textSent = false;
    try {
      const contact = await findContact(callerNumber);
      const consentStatus = contact?.fields?.consent_status;

      if (consentStatus === 'opted_out') {
        console.log(`${callerNumber} is opted out — no text sent`);

      } else if (consentStatus === 'opted_in') {
        const shortMsg = `Hi, this is ${client.businessName}. Sorry we missed your call — how can we help you today?`;
        await sendSMS(calledNumber, callerNumber, shortMsg);
        textSent = true;
        console.log(`Short missed call text sent to ${callerNumber} (already opted in)`);
        await logConversation(callerNumber, calledNumber, client.clientId, 'outbound', shortMsg);
        await updateContact(contact.id, { last_message_at: new Date().toISOString() });

      } else {
        // Cooldown check: if already pending and a consent request was sent within the last 24 hours, skip
        if (contact?.fields?.consent_status === 'pending' && contact?.fields?.consent_requested_at) {
          const lastSent = new Date(contact.fields.consent_requested_at);
          const hoursSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
          if (hoursSince < 24) {
            console.log(`Consent request already sent to ${callerNumber} ${Math.floor(hoursSince)}h ago — skipping`);
            await logCall(callerNumber, calledNumber, client.clientId, false);
            return;
          }
        }

        const consentMsg = `Hi, this is ${client.businessName}. Sorry we missed your call — can we follow up with you here by text? Reply YES to continue or STOP to opt out. Text START anytime to opt back in.`;
        await sendSMS(calledNumber, callerNumber, consentMsg);
        textSent = true;
        console.log(`Consent request sent to ${callerNumber}`);
        await logConversation(callerNumber, calledNumber, client.clientId, 'outbound', consentMsg);

        if (!contact) {
          await createContact(callerNumber, calledNumber, client.clientId);
        } else {
          await updateContact(contact.id, {
            consent_status: 'pending',
            consent_requested_at: new Date().toISOString(),
            last_message_at: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.error('Missed call handling error:', err?.message);
    }

    try {
      await logCall(callerNumber, calledNumber, client.clientId, textSent);
    } catch (err) {
      console.error('Call log error:', err?.message);
    }
  }
});

// ── SMS webhook ───────────────────────────────────────────────────

app.post('/sms', async (req, res) => {
  res.sendStatus(200);
  const eventType = req.body?.data?.event_type;

  if (eventType !== 'message.received') {
    console.log(`Ignoring SMS event: ${eventType}`);
    return;
  }

  const payload = req.body?.data?.payload;
  const from = payload?.from?.phone_number;
  const to = payload?.to?.[0]?.phone_number;
  const messageRaw = payload?.text?.trim() || '';
  const message = messageRaw.toUpperCase();

  console.log(`Inbound SMS from ${from} to ${to}: ${messageRaw}`);

  const ownNumbers = Object.keys(clientMap);
  if (ownNumbers.includes(from)) {
    console.log(`Ignoring echo from own Telnyx number ${from}`);
    return;
  }

  const client = clientMap[to];
  const businessName = client?.businessName || 'the business';
  const clientId = client?.clientId || 'unknown';

  try {
    const contact = await findContact(from);
    const consentStatus = contact?.fields?.consent_status;
    const now = new Date().toISOString();

    if (message === 'STOP' || message === 'UNSUBSCRIBE') {
      await logConversation(from, to, clientId, 'inbound', messageRaw);
      if (contact) {
        await updateContact(contact.id, {
          consent_status: 'opted_out',
          opted_out_at: now,
          last_message_at: now
        });
      }
      console.log(`${from} opted out`);
      return;
    }

    if (message === 'START' || message === 'UNSTOP') {
      const reOptInReply = `${businessName}: You have been re-subscribed and will receive messages again. Reply STOP at any time to opt out.`;
      await sendSMS(to, from, reOptInReply);
      await logConversation(from, to, clientId, 'inbound', messageRaw);
      await logConversation(from, to, clientId, 'outbound', reOptInReply);
      if (contact) {
        await updateContact(contact.id, {
          consent_status: 'opted_in',
          opted_in_at: now,
          last_message_at: now
        });
      }
      console.log(`${from} re-opted in`);
      return;
    }

    if (consentStatus === 'opted_out') {
      console.log(`${from} is opted out — ignoring message`);
      return;
    }

    await logConversation(from, to, clientId, 'inbound', messageRaw);

    if (message === 'HELP') {
      if (consentStatus === 'opted_in') {
        const helpReply = `${businessName}: For assistance, contact us at hello@streamlineaihq.com. Reply STOP to opt out.`;
        await sendSMS(to, from, helpReply);
        await logConversation(from, to, clientId, 'outbound', helpReply);
        if (contact) {
          await updateContact(contact.id, { last_message_at: now });
        }
      }
      return;
    }

    if (message === 'YES' && consentStatus === 'pending') {
      const optInReply = `${businessName}: You're now opted in. Message frequency varies. Msg & data rates may apply. Reply HELP for assistance or STOP to opt out. — You're now chatting with an AI assistant. How can we help you today?`;
      await sendSMS(to, from, optInReply);
      await logConversation(from, to, clientId, 'outbound', optInReply);
      await updateContact(contact.id, {
        consent_status: 'opted_in',
        opted_in_at: now,
        last_message_at: now
      });
      console.log(`${from} opted in`);
      return;
    }

    if (consentStatus === 'pending') {
      console.log(`${from} is pending — message was not YES/STOP, no reply sent`);
      return;
    }

    // Opted in — Claude AI chatbot responds
    if (consentStatus === 'opted_in') {
      try {
        const aiContext = await getClientContext(clientId);
        if (!aiContext) {
          console.log(`No AI context found for ${clientId} — skipping AI reply`);
          return;
        }
        const history = await getConversationHistory(from, clientId);
        const aiReply = await getAIReply(aiContext, history, messageRaw);
        if (!aiReply) {
          console.log('Claude returned no reply');
          return;
        }
        await sendSMS(to, from, aiReply);
        await logConversation(from, to, clientId, 'outbound', aiReply);
        await updateContact(contact.id, { last_message_at: now });
        console.log(`AI reply sent to ${from}: ${aiReply}`);
      } catch (err) {
        console.error('AI chatbot error:', err?.message);
      }
      return;
    }

    console.log(`Unknown contact ${from} sent: ${messageRaw} — ignored`);

  } catch (err) {
    console.error('SMS handling error:', err?.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
