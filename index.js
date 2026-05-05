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
      console.error('Transfer failed:', err?.message, JSON.stringify(err?.response?.data));
    }
  }

  if (eventType === 'call.hangup') {
    if (!client) return;

    const answeredBy = payload?.hangup_cause;
    const callDuration = payload?.end_time && payload?.start_time
      ? (new Date(payload.end_time) - new Date(payload.start_time)) / 1000
      : 0;

    const wasMissed = answeredBy === 'timeout' || callDuration < 10;

    if (wasMissed) {
      console.log(`Missed call from ${callerNumber} — sending text back`);

      try {
        const response = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
          },
          body: JSON.stringify({
            from: calledNumber,
            to: callerNumber,
            text: `Hi, sorry we missed your call — how can we help?`
          })
        });
        const result = await response.json();
        console.log('SMS response:', JSON.stringify(result));
      } catch (err) {
        console.error('SMS failed:', err?.message);
      }
    }
  }
});

app.post('/sms', async (req, res) => {
  res.sendStatus(200);
  const payload = req.body?.data?.payload;
  console.log('Inbound SMS:', JSON.stringify(payload));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
