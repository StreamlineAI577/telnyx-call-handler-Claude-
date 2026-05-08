const express = require('express');
const app = express();
app.use(express.json());

const clientMap = {
  '+19714356058': {
    clientId: 'client_001',
    businessName: 'StreamlineAI',
    businessPhone: '+19717626038',
    aiContext: 'You are a helpful assistant for StreamlineAI.'
  }
};

// How long after answer (in seconds) we still consider a call "missed".
// Catches voicemail-bailers who hang up during the greeting.
const POST_ANSWER_MISSED_THRESHOLD_SECONDS = 5;

// Tracks each active call's state in memory while it's happening.
// Key: call_control_id
// Value: { client, callerNumber, telnyxNumber, answered, answeredAt }
const activeCalls = {};

app.post('/call', async (req, res) => {
  res.sendStatus(200);

  const eventType = req.body?.data?.event_type;
  const payload = req.body?.data?.payload;
  const calledNumber = payload?.to;
  const callerNumber = payload?.from;
  const callControlId = payload?.call_control_id;
  const direction = payload?.direction;

  const client = clientMap[calledNumber];

  // ── Incoming call: store it in memory and forward to the business ──
  if (eventType === 'call.initiated' && direction === 'incoming') {
    if (!client) {
      console.log('No client found for number:', calledNumber);
      return;
    }

    activeCalls[callControlId] = {
      client,
      callerNumber,
      telnyxNumber: calledNumber,
      answered: false,
      answeredAt: null
    };

    console.log(`Incoming call for ${client.businessName} from ${callerNumber}`);

    try {
      const response = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
        },
        body: JSON.stringify({
          to: client.businessPhone,
          from: callerNumber,
          timeout_secs: 30
        })
      });
      const result = await response.json();
      console.log('Transfer response:', JSON.stringify(result));
    } catch (err) {
      console.error('Transfer failed:', err?.message);
    }
  }

  // ── Call was answered (by human or voicemail) — record timestamp ──
  if (eventType === 'call.answered') {
    if (activeCalls[callControlId]) {
      activeCalls[callControlId].answered = true;
      activeCalls[callControlId].answeredAt = Date.now();
      console.log(`Call answered for leg ${callControlId}`);
    }
  }

  // ── Call ended — decide if it was missed ──
  if (eventType === 'call.hangup') {
    const callData = activeCalls[callControlId];
    if (!callData) return; // not a call we were tracking

    const { client: callClient, callerNumber: caller, telnyxNumber, answered, answeredAt } = callData;

    // Calculate how long the call lasted AFTER it was answered (if at all)
    let postAnswerSeconds = null;
    if (answered && answeredAt) {
      postAnswerSeconds = (Date.now() - answeredAt) / 1000;
    }

    console.log(
      `Call ended | answered: ${answered}` +
      (postAnswerSeconds !== null ? ` | post-answer: ${postAnswerSeconds.toFixed(2)}s` : '') +
      ` | hangup_cause: ${payload?.hangup_cause}`
    );

    // Missed if: never answered, OR answered but ended quickly (voicemail bailer)
    const wasMissed =
      !answered ||
      (postAnswerSeconds !== null && postAnswerSeconds < POST_ANSWER_MISSED_THRESHOLD_SECONDS);

    if (wasMissed) {
      const reason = !answered ? 'no answer' : `bailed after ${postAnswerSeconds.toFixed(1)}s`;
      console.log(`Missed call from ${caller} (${reason}) — sending text-back`);

      try {
        const response = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
          },
          body: JSON.stringify({
            from: telnyxNumber,
            to: caller,
            text: `Hi, this is ${callClient.businessName}. Sorry we missed your call — how can we help?`
          })
        });
        const result = await response.json();
        console.log('SMS response:', JSON.stringify(result));
      } catch (err) {
        console.error('SMS failed:', err?.message);
      }
    }

    // Clean up memory once the call is done
    delete activeCalls[callControlId];
  }
});

// Inbound SMS endpoint
app.post('/sms', async (req, res) => {
  res.sendStatus(200);
  const payload = req.body?.data?.payload;
  console.log('Inbound SMS:', JSON.stringify(payload));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
