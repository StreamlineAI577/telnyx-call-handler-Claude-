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
          console.log(`${caller} is opted out — no text sent`);
        } else {
          const consentMsg = `Hi, this is ${callClient.businessName}. Sorry we missed your call — can we follow up with you here by text? Reply YES to continue or STOP to opt out.`;
          await sendSMS(telnyxNumber, caller, consentMsg);
          textSent = true;
          console.log(`Consent request sent to ${caller}`);

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
  const payload = req.body?.data?.payload;
  const from = payload?.from?.phone_number;
  const to = payload?.to?.[0]?.phone_number;
  const messageRaw = payload?.text?.trim() || '';
  const message = messageRaw.toUpperCase();

  console.log(`Inbound SMS from ${from} to ${to}: ${messageRaw}`);

  try {
    const contact = await findContact(from);
    const consentStatus = contact?.fields?.consent_status;
    const now = new Date().toISOString();

    // Already opted out — ignore everything
    if (consentStatus === 'opted_out') {
      console.log(`${from} is opted out — ignoring message`);
      return;
    }

    // STOP — always honored, no matter their current status
    if (message === 'STOP' || message === 'UNSUBSCRIBE') {
      await sendSMS(to, from, 'StreamlineAI: You have been unsubscribed and will receive no further messages.');
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

    // HELP — only respond if they're opted in
    if (message === 'HELP') {
      if (consentStatus === 'opted_in') {
        await sendSMS(to, from, 'StreamlineAI: For assistance, contact us at hello@streamlineaihq.com. Reply STOP to opt out.');
        if (contact) {
          await updateContact(contact.id, { last_message_at: now });
        }
      }
      return;
    }

    // YES / START — opt them in (only if they were pending)
    if ((message === 'YES' || message === 'START') && consentStatus === 'pending') {
      await sendSMS(to, from, "StreamlineAI: You're now opted in. Message frequency varies. Msg & data rates may apply. Reply HELP for assistance or STOP to opt out. — How can we help you today?");
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
