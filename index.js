const express = require('express');
const app = express();
app.use(express.json());

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

const clientMap = {
  '+19714356058': {
    clientId: 'client_001',
    businessName: 'StreamlineAI',
    businessPhone: '+19717626038',
    aiContext: 'You are a helpful assistant for StreamlineAI.'
  }
};

const POST_ANSWER_MISSED_THRESHOLD_SECONDS = 10;
const activeCalls = {};

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

async function logCall(callerPhone, telnyxNumber, clientId, status, durationSeconds, textSent) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Call%20Log`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        date_time: new Date().toISOString(),
        caller_phone: callerPhone,
        client_telnyx_number: telnyxNumber,
        client_id: clientId,
        call_status: status,
        call_duration_seconds: durationSeconds || 0,
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
    if (!client) { console.log('No client found for number:', calledNumber); return; }
    activeCalls[callControlId] = { client, callerNumber, telnyxNumber: calledNumber, answered: false, answeredAt: null };
    console.log(`Incoming call for ${client.businessName} from ${callerNumber}`);
    try {
      const response = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TELNYX_API_KEY}` },
        body: JSON.stringify({ to: client.businessPhone, from: callerNumber, timeout_secs: 60 })
      });
      const result = await response.json();
      console.log('Transfer response:', JSON.stringify(result));
    } catch (err) { console.error('Transfer failed:', err?.message); }
  }

  if (eventType === 'call.answered') {
    if (activeCalls[callControlId]) {
      activeCalls[callControlId].answered = true;
      activeCalls[callControlId].answeredAt = Date.now();
      console.log(`Call answered for leg ${callControlId}`);
    }
  }

  if (eventType === 'call.hangup') {
    const callData = activeCalls[callControlId];
    if (!callData) return;
    const { client: callClient, callerNumber: caller, telnyxNumber, answered, answeredAt } = callData;

    let postAnswerSeconds = null;
    if (answered && answeredAt) { postAnswerSeconds = (Date.now() - answeredAt) / 1000; }

    const wasMissed = !answered || (postAnswerSeconds !== null && postAnswerSeconds < POST_ANSWER_MISSED_THRESHOLD_SECONDS);
    const callStatus = wasMissed ? 'missed' : 'answered';
    const durationSeconds = postAnswerSeconds ? Math.round(postAnswerSeconds) : 0;

    console.log(`Call ended | status: ${callStatus}`);

    let textSent = false;

    if (wasMissed) {
      try {
        const contact = await findContact(caller);
        const consentStatus = contact?.fields?.consent_status;

        if (consentStatus === 'opted_out') {
          // Opted out — send nothing
          console.log(`${caller} is opted out — no text sent`);

        } else if (consentStatus === 'opted_in') {
          // Already have consent — skip the consent ask, go straight to help
          const shortMsg = `Hi, this is ${callClient.businessName}. Sorry we missed your call — how can we help you today?`;
          await sendSMS(telnyxNumber, caller, shortMsg);
          textSent = true;
          console.log(`Short missed call text sent to ${caller} (already opted in)`);
          await logConversation(caller, telnyxNumber, callClient.clientId, 'outbound', shortMsg);
          await updateContact(contact.id, { last_message_at: new Date().toISOString() });

        } else {
          // No record or pending — send full consent request
          const consentMsg = `Hi, this is ${callClient.businessName}. Sorry we missed your call — can we follow up with you here by text? Reply YES to continue or STOP to opt out. Text START anytime to opt back in.`;
          await sendSMS(telnyxNumber, caller, consentMsg);
          textSent = true;
          console.log(`Consent request sent to ${caller}`);
          await logConversation(caller, telnyxNumber, callClient.clientId, 'outbound', consentMsg);

          if (!contact) {
            await createContact(caller, telnyxNumber, callClient.clientId);
          } else {
            await updateContact(contact.id, {
              consent_status: 'pending',
              consent_requested_at: new Date().toISOString(),
              last_message_at: new Date().toISOString()
            });
          }
        }
      } catch (err) { console.error('Missed call handling error:', err?.message); }
    }

    try {
      await logCall(caller, telnyxNumber, callClient.clientId, callStatus, durationSeconds, textSent);
    } catch (err) { console.error('Call log error:', err?.message); }

    delete activeCalls[callControlId];
  }
});

// ── SMS webhook ───────────────────────────────────────────────────

app.post('/sms', async (req, res) => {
  res.sendStatus(200);
  const eventType = req.body?.data?.event_type;

  // Only process actual inbound messages, ignore outbound status webhooks (message.sent, message.finalized)
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

  // Ignore messages sent from our own Telnyx numbers (outbound echo)
  const ownNumbers = Object.keys(clientMap);
  if (ownNumbers.includes(from)) {
    console.log(`Ignoring echo from own Telnyx number ${from}`);
    return;
  }

  // Look up which client owns the Telnyx number this text was sent to
  const client = clientMap[to];
  const businessName = client?.businessName || 'the business';
  const clientId = client?.clientId || 'unknown';

  try {
    const contact = await findContact(from);
    const consentStatus = contact?.fields?.consent_status;
    const now = new Date().toISOString();

    // STOP — always honored first, no matter what
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

    // START / UNSTOP — re-opt-in if they were previously opted out
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

    // Already opted out and didn't send START/UNSTOP — ignore everything
    if (consentStatus === 'opted_out') {
      console.log(`${from} is opted out — ignoring message`);
      return;
    }

    // Log every other inbound message to Conversations
    await logConversation(from, to, clientId, 'inbound', messageRaw);

    // HELP — only respond if they're opted in
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

    // YES — opt them in (only if they were pending)
    if (message === 'YES' && consentStatus === 'pending') {
      const optInReply = `${businessName}: You're now opted in. Message frequency varies. Msg & data rates may apply. Reply HELP for assistance or STOP to opt out. — How can we help you today?`;
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

    // Pending but didn't reply YES/STOP — do nothing per 10DLC registration
    if (consentStatus === 'pending') {
      console.log(`${from} is pending — message was not YES/STOP, no reply sent`);
      return;
    }

    // Opted in — this is where the AI chatbot will eventually respond
    if (consentStatus === 'opted_in') {
      console.log(`${from} is opted in — AI chatbot reply goes here (not yet built)`);
      if (contact) {
        await updateContact(contact.id, { last_message_at: now });
      }
      return;
    }

    // No contact record and message isn't a recognized keyword — ignore
    console.log(`Unknown contact ${from} sent: ${messageRaw} — ignored`);

  } catch (err) {
    console.error('SMS handling error:', err?.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
